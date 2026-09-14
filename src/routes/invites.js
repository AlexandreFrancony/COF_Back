import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';
import { authenticateToken, requireGm, generateToken } from '../middleware/auth.js';
import { findAccessibleCampaign } from './campaigns.js';

const router = Router();
const BCRYPT_ROUNDS = 10;

/**
 * POST /campaigns/:campaignId/invites
 * GM only. Either creates a new character shell, or attaches an invite to an existing
 * unclaimed one (e.g. a PJ the GM already built ahead of time to save the player setup time) —
 * pass character_id instead of character_name for the latter.
 * Body: { character_name?, character_id?, email? }
 */
router.post('/campaigns/:campaignId/invites', authenticateToken, requireGm, async (req, res) => {
  try {
    const { character_name, character_id, email } = req.body;
    const { campaignId } = req.params;

    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND gm_id = $2',
      [campaignId, req.user.id]
    );
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    let character;
    if (character_id) {
      const existing = await pool.query(
        'SELECT * FROM characters WHERE id = $1 AND campaign_id = $2 AND user_id IS NULL',
        [character_id, campaignId]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Personnage introuvable ou déjà associé à un joueur' });
      }
      const pendingInvite = await pool.query(
        `SELECT id FROM campaign_invites WHERE character_id = $1 AND status = 'pending'`,
        [character_id]
      );
      if (pendingInvite.rows.length > 0) {
        return res.status(409).json({ error: 'Ce personnage a déjà une invitation en attente' });
      }
      character = existing.rows[0];
    } else {
      if (!character_name) {
        return res.status(400).json({ error: 'Nom du personnage requis' });
      }
      character = (await pool.query(
        'INSERT INTO characters (campaign_id, name) VALUES ($1, $2) RETURNING *',
        [campaignId, character_name]
      )).rows[0];
    }

    const token = crypto.randomBytes(24).toString('hex');
    const invite = await pool.query(
      `INSERT INTO campaign_invites (campaign_id, character_id, token, email)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [campaignId, character.id, token, email || null]
    );

    res.status(201).json({
      invite: invite.rows[0],
      character,
      invite_url: `${process.env.FRONTEND_URL || 'https://jdr.francony.fr'}/invites/${token}`,
    });
  } catch (error) {
    console.error('Error POST /campaigns/:campaignId/invites:', error.message);
    res.status(500).json({ error: 'Erreur lors de la création de l\'invitation' });
  }
});

/**
 * GET /campaigns/:campaignId/invites
 * GM only. List invites for a campaign.
 */
router.get('/campaigns/:campaignId/invites', authenticateToken, requireGm, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ci.*, ch.name AS character_name
       FROM campaign_invites ci
       JOIN characters ch ON ch.id = ci.character_id
       JOIN campaigns c ON c.id = ci.campaign_id
       WHERE ci.campaign_id = $1 AND c.gm_id = $2
       ORDER BY ci.created_at DESC`,
      [req.params.campaignId, req.user.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error GET /campaigns/:campaignId/invites:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * DELETE /campaigns/:campaignId/invites/:inviteId
 * GM only. Revokes a pending invite and removes its unclaimed character shell.
 */
router.delete('/campaigns/:campaignId/invites/:inviteId', authenticateToken, requireGm, async (req, res) => {
  try {
    const invite = await pool.query(
      `SELECT ci.* FROM campaign_invites ci
       JOIN campaigns c ON c.id = ci.campaign_id
       WHERE ci.id = $1 AND ci.campaign_id = $2 AND c.gm_id = $3`,
      [req.params.inviteId, req.params.campaignId, req.user.id]
    );
    if (invite.rows.length === 0) {
      return res.status(404).json({ error: 'Invitation non trouvée' });
    }
    if (invite.rows[0].status !== 'pending') {
      return res.status(400).json({ error: 'Seule une invitation en attente peut être révoquée' });
    }

    await pool.query('DELETE FROM campaign_invites WHERE id = $1', [req.params.inviteId]);
    await pool.query(
      'DELETE FROM characters WHERE id = $1 AND user_id IS NULL',
      [invite.rows[0].character_id]
    );

    res.json({ message: 'Invitation révoquée' });
  } catch (error) {
    console.error('Error DELETE /campaigns/:campaignId/invites/:inviteId:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /invites/:token
 * Public. Preview an invite before accepting it.
 */
router.get('/invites/:token', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ci.status, ci.email, c.name AS campaign_name, ch.name AS character_name
       FROM campaign_invites ci
       JOIN campaigns c ON c.id = ci.campaign_id
       JOIN characters ch ON ch.id = ci.character_id
       WHERE ci.token = $1`,
      [req.params.token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invitation introuvable' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error GET /invites/:token:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export async function claimCharacter(userId, characterId, inviteId) {
  await pool.query('UPDATE characters SET user_id = $1 WHERE id = $2', [userId, characterId]);
  await pool.query(
    `UPDATE campaign_invites SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [inviteId]
  );
}

/**
 * POST /invites/:token/accept
 * Public. Attaches the invite's character to a player account — added to that account's
 * existing library of characters across campaigns, rather than forcing one account per
 * character. Three cases:
 *  - caller already holds a valid session (Authorization header) -> claim onto that account.
 *  - email matches an existing account -> body must include its password to claim onto it.
 *  - new email -> creates the account. Body: { email, password, display_name }
 */
router.post('/invites/:token/accept', async (req, res) => {
  try {
    const inviteResult = await pool.query(
      `SELECT * FROM campaign_invites WHERE token = $1 AND status = 'pending'`,
      [req.params.token]
    );
    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invitation invalide ou déjà utilisée' });
    }
    const invite = inviteResult.rows[0];

    const authHeader = req.headers['authorization'];
    if (authHeader) {
      try {
        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        await claimCharacter(decoded.id, invite.character_id, invite.id);
        const userRow = await pool.query('SELECT id, email, display_name, role FROM users WHERE id = $1', [decoded.id]);
        return res.status(200).json({ user: userRow.rows[0], token: authHeader.split(' ')[1] });
      } catch {
        // expired/invalid token — fall through to the email+password flow below
      }
    }

    const { email, password, display_name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const existingUser = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    let user;

    if (existingUser.rows.length > 0) {
      const valid = await bcrypt.compare(password, existingUser.rows[0].password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Mot de passe incorrect pour ce compte existant' });
      }
      user = existingUser.rows[0];
    } else {
      if (!display_name) {
        return res.status(400).json({ error: 'Nom d\'affichage requis pour créer un compte' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
      }
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      user = (await pool.query(
        `INSERT INTO users (email, password_hash, display_name, role)
         VALUES ($1, $2, $3, 'player')
         RETURNING *`,
        [email, passwordHash, display_name]
      )).rows[0];
    }

    await claimCharacter(user.id, invite.character_id, invite.id);

    const token = generateToken(user);
    res.status(201).json({
      user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role },
      token,
    });
  } catch (error) {
    console.error('Error POST /invites/:token/accept:', error.message);
    res.status(500).json({ error: 'Erreur lors de l\'acceptation de l\'invitation' });
  }
});

export default router;
