import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken, requireGm } from '../middleware/auth.js';

const router = Router();
router.use(authenticateToken, requireGm);

// Scenario notes are GM prep material (can contain spoilers) — GM-only, never exposed to players.

async function ownedCampaign(campaignId, gmId) {
  const result = await pool.query('SELECT id FROM campaigns WHERE id = $1 AND gm_id = $2', [campaignId, gmId]);
  return result.rows.length > 0;
}

/**
 * GET /campaigns/:campaignId/scenarios
 */
router.get('/campaigns/:campaignId/scenarios', async (req, res) => {
  try {
    if (!(await ownedCampaign(req.params.campaignId, req.user.id))) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const result = await pool.query(
      'SELECT * FROM campaign_scenarios WHERE campaign_id = $1 ORDER BY created_at',
      [req.params.campaignId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error GET /campaigns/:campaignId/scenarios:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /campaigns/:campaignId/scenarios
 * Body: { name, notes }
 */
router.post('/campaigns/:campaignId/scenarios', async (req, res) => {
  try {
    if (!(await ownedCampaign(req.params.campaignId, req.user.id))) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const { name, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom du scénario requis' });

    const result = await pool.query(
      'INSERT INTO campaign_scenarios (campaign_id, name, notes) VALUES ($1, $2, $3) RETURNING *',
      [req.params.campaignId, name, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error POST /campaigns/:campaignId/scenarios:', error.message);
    res.status(500).json({ error: 'Erreur lors de la création du scénario' });
  }
});

/**
 * PATCH /scenarios/:id
 * Body: { name, notes }
 */
router.patch('/scenarios/:id', async (req, res) => {
  try {
    const { name, notes } = req.body;
    const result = await pool.query(
      `UPDATE campaign_scenarios s SET
         name = COALESCE($1, s.name),
         notes = COALESCE($2, s.notes)
       FROM campaigns c
       WHERE s.id = $3 AND s.campaign_id = c.id AND c.gm_id = $4
       RETURNING s.*`,
      [name, notes, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Scénario non trouvé' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error PATCH /scenarios/:id:', error.message);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

/**
 * DELETE /scenarios/:id
 */
router.delete('/scenarios/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM campaign_scenarios s
       USING campaigns c
       WHERE s.id = $1 AND s.campaign_id = c.id AND c.gm_id = $2
       RETURNING s.id`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Scénario non trouvé' });
    res.json({ message: 'Scénario supprimé' });
  } catch (error) {
    console.error('Error DELETE /scenarios/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
