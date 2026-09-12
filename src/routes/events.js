import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken, requireGm } from '../middleware/auth.js';
import { findAccessibleCampaign } from './campaigns.js';

const router = Router();
router.use(authenticateToken);

/**
 * GET /campaigns/:campaignId/events?limit=
 * Anyone with access to the campaign (GM or a player in it) can read the log.
 */
router.get('/campaigns/:campaignId/events', async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.campaignId, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const result = await pool.query(
      `SELECT e.*, c.name AS character_name FROM session_events e
       LEFT JOIN characters c ON c.id = e.character_id
       WHERE e.campaign_id = $1
       ORDER BY e.created_at DESC
       LIMIT $2`,
      [req.params.campaignId, limit]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error GET /campaigns/:campaignId/events:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /campaigns/:campaignId/events — GM only, free-form note. Body: { message }
 */
router.post('/campaigns/:campaignId/events', requireGm, async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.campaignId, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message requis' });

    const result = await pool.query(
      `INSERT INTO session_events (campaign_id, type, message) VALUES ($1, 'note', $2) RETURNING *`,
      [req.params.campaignId, message]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error POST /campaigns/:campaignId/events:', error.message);
    res.status(500).json({ error: 'Erreur lors de l\'ajout de la note' });
  }
});

export default router;
