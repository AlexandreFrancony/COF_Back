import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { broadcastNotes } from '../services/notesStream.js';

const router = Router();

// Exported for sseStreams.js — notes-stream needs the exact same access check as the plain
// GET below, but as its own route living outside any blanket-authenticateToken router (see
// sseStreams.js for why).
export async function resolveAccess(campaignId, user) {
  const result = await pool.query('SELECT gm_id FROM campaigns WHERE id = $1', [campaignId]);
  if (result.rows.length === 0) return false;
  if (result.rows[0].gm_id === user.id) return true;

  const char = await pool.query(
    'SELECT id FROM characters WHERE campaign_id = $1 AND user_id = $2',
    [campaignId, user.id]
  );
  return char.rows.length > 0;
}

router.use(authenticateToken);

/**
 * GET /campaigns/:campaignId/notes
 */
router.get('/campaigns/:campaignId/notes', async (req, res) => {
  try {
    if (!(await resolveAccess(req.params.campaignId, req.user))) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const result = await pool.query(
      'SELECT content, updated_at, updated_by FROM campaign_notes WHERE campaign_id = $1',
      [req.params.campaignId]
    );
    res.json(result.rows[0] || { content: '', updated_at: null, updated_by: null });
  } catch (error) {
    console.error('Error GET campaign notes:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * PATCH /campaigns/:campaignId/notes
 * Body: { content }
 * Anyone with access to the campaign can edit — a shared scratchpad, not GM-only prep
 * (that's campaign_scenarios.notes). Last-write-wins; broadcasts the result over SSE so
 * every other open tab picks it up live.
 */
router.patch('/campaigns/:campaignId/notes', async (req, res) => {
  try {
    if (!(await resolveAccess(req.params.campaignId, req.user))) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const { content } = req.body;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'Contenu requis' });
    }

    const result = await pool.query(
      `INSERT INTO campaign_notes (campaign_id, content, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (campaign_id) DO UPDATE SET content = $2, updated_at = NOW(), updated_by = $3
       RETURNING content, updated_at, updated_by`,
      [req.params.campaignId, content, req.user.display_name]
    );

    broadcastNotes(req.params.campaignId, result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error PATCH campaign notes:', error.message);
    res.status(500).json({ error: 'Erreur lors de la sauvegarde des notes' });
  }
});

export default router;
