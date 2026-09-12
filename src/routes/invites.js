import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import pool from '../db/pool.js';
import { authenticateToken, requireGm, generateToken } from '../middleware/auth.js';
import { findAccessibleCampaign } from './campaigns.js';

const router = Router();
const BCRYPT_ROUNDS = 10;

/**
 * POST /campaigns/:campaignId/invites
 * GM only. Creates a character shell + a pending invite for a player.
 * Body: { character_name, email? }
 */
router.post('/campaigns/:campaignId/invites', authenticateToken, requireGm, async (req, res) => {
  try {
    const { character_name, email } = req.body;
    const { campaignId } = req.params;

    if (!character_name) {
      return res.status(400).json({ error: 'Nom du personnage requis' });
    }

    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND gm_id = $2',
      [campaignId, req.user.id]
    );
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const character = await pool.query(
      'INSERT INTO characters (campaign_id, name) VALUES ($1, $2) RETURNING *',
      [campaignId, character_name]
    );

    const token = crypto.randomBytes(24).toString('hex');
    const invite = await pool.query(
      `INSERT INTO campaign_invites (campaign_id, character_id, token, email)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [campaignId, character.rows[0].id, token, email || null]
    );

    res.status(201).json({
      invite: invite.rows[0],
      character: character.rows[0],
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

/**
 * POST /invites/:token/accept
 * Public. Creates the player account and links it to the pre-created character.
 * Body: { email, password, display_name }
 */
router.post('/invites/:token/accept', async (req, res) => {
  try {
    const { email, password, display_name } = req.body;

    if (!email || !password || !display_name) {
      return res.status(400).json({ error: 'Email, mot de passe et nom d\'affichage requis' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
    }

    const inviteResult = await pool.query(
      `SELECT * FROM campaign_invites WHERE token = $1 AND status = 'pending'`,
      [req.params.token]
    );
    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invitation invalide ou déjà utilisée' });
    }
    const invite = inviteResult.rows[0];

    const existingUser = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, role)
       VALUES ($1, $2, $3, 'player')
       RETURNING id, email, display_name, role`,
      [email, passwordHash, display_name]
    );
    const user = userResult.rows[0];

    await pool.query('UPDATE characters SET user_id = $1 WHERE id = $2', [user.id, invite.character_id]);
    await pool.query(
      `UPDATE campaign_invites SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [invite.id]
    );

    const token = generateToken(user);
    res.status(201).json({ user, token });
  } catch (error) {
    console.error('Error POST /invites/:token/accept:', error.message);
    res.status(500).json({ error: 'Erreur lors de l\'acceptation de l\'invitation' });
  }
});

export default router;
