import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken, requireGm } from '../middleware/auth.js';

const router = Router();
router.use(authenticateToken);

/**
 * GET /campaigns
 * GM: their own campaigns. Player: campaigns where they have a character.
 */
router.get('/', async (req, res) => {
  try {
    const result = req.user.role === 'gm'
      ? await pool.query(
          'SELECT * FROM campaigns WHERE gm_id = $1 ORDER BY created_at DESC',
          [req.user.id]
        )
      : await pool.query(
          `SELECT DISTINCT c.* FROM campaigns c
           JOIN characters ch ON ch.campaign_id = c.id
           WHERE ch.user_id = $1
           ORDER BY c.created_at DESC`,
          [req.user.id]
        );

    res.json(result.rows);
  } catch (error) {
    console.error('Error GET /campaigns:', error.message);
    res.status(500).json({ error: 'Erreur lors de la récupération des campagnes' });
  }
});

/**
 * POST /campaigns
 * GM only. Body: { name, description }
 */
router.post('/', requireGm, async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Nom de campagne requis' });
    }

    const result = await pool.query(
      'INSERT INTO campaigns (gm_id, name, description) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, name, description || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error POST /campaigns:', error.message);
    res.status(500).json({ error: 'Erreur lors de la création de la campagne' });
  }
});

async function findAccessibleCampaign(campaignId, user) {
  const result = await pool.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
  if (result.rows.length === 0) return null;

  const campaign = result.rows[0];
  if (user.role === 'gm' && campaign.gm_id === user.id) return campaign;

  const charResult = await pool.query(
    'SELECT id FROM characters WHERE campaign_id = $1 AND user_id = $2',
    [campaignId, user.id]
  );
  return charResult.rows.length > 0 ? campaign : null;
}

/**
 * GET /campaigns/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.id, req.user);
    if (!campaign) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    res.json(campaign);
  } catch (error) {
    console.error('Error GET /campaigns/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * PATCH /campaigns/:id
 * GM only, must own the campaign.
 * discord_webhook_url may be explicitly null (remove it) — unlike name/description, it isn't
 * COALESCE'd, since that would make "clear it" indistinguishable from "field omitted".
 */
router.patch('/:id', requireGm, async (req, res) => {
  try {
    const { name, description, discord_webhook_url } = req.body;
    const webhookProvided = Object.prototype.hasOwnProperty.call(req.body, 'discord_webhook_url');

    const result = await pool.query(
      `UPDATE campaigns SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         discord_webhook_url = CASE WHEN $3 THEN $4 ELSE discord_webhook_url END
       WHERE id = $5 AND gm_id = $6
       RETURNING *`,
      [name, description, webhookProvided, discord_webhook_url || null, req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error PATCH /campaigns/:id:', error.message);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

/**
 * DELETE /campaigns/:id
 * GM only, must own the campaign.
 */
router.delete('/:id', requireGm, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM campaigns WHERE id = $1 AND gm_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    res.json({ message: 'Campagne supprimée' });
  } catch (error) {
    console.error('Error DELETE /campaigns/:id:', error.message);
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

export default router;
export { findAccessibleCampaign };
