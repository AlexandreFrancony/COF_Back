import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken, requireGm } from '../middleware/auth.js';
import { getFullBoard, buildBoardForRole, getOrCreateBoard } from './board.js';
import { broadcastBoard } from '../services/boardStream.js';

const router = Router();
// requireGm is applied per-route (not blanket) — this router is mounted at '/' alongside
// others (events, board...), and a blanket router.use(requireGm) here would 403 a player's
// requests to THOSE routers too, since Express runs it for every request reaching this router
// regardless of whether one of ITS OWN routes matches (learned the hard way: it silently
// broke GET /campaigns/:id/events for players once eventsRouter was mounted after this one).
router.use(authenticateToken);

// Scenario notes are GM prep material (can contain spoilers) — GM-only, never exposed to players.
//
// A scenario can also prepare a background (from the shared board_media library) and a set of
// tokens (scenario_tokens — same shape as board_tokens, positioned independently of the live
// board) ahead of a session. "Launching" it (POST /scenarios/:id/launch) copies the background
// onto the campaign's live board_states and adds the prepped tokens to board_tokens — additive
// only, it never clears whatever is already on the board.

async function ownedCampaign(campaignId, gmId) {
  const result = await pool.query('SELECT id FROM campaigns WHERE id = $1 AND gm_id = $2', [campaignId, gmId]);
  return result.rows.length > 0;
}

// Resolves a scenario to its campaign_id while checking GM ownership in one query — used by
// every route addressed by scenario id (tokens, launch) instead of campaign id.
async function ownedScenario(scenarioId, gmId) {
  const result = await pool.query(
    `SELECT s.id, s.campaign_id FROM campaign_scenarios s
     JOIN campaigns c ON c.id = s.campaign_id
     WHERE s.id = $1 AND c.gm_id = $2`,
    [scenarioId, gmId]
  );
  return result.rows[0] || null;
}

async function getScenarioRow(scenarioId) {
  const result = await pool.query(
    `SELECT s.*, m.url AS background_url, m.type AS background_type
     FROM campaign_scenarios s
     LEFT JOIN board_media m ON m.id = s.background_media_id
     WHERE s.id = $1`,
    [scenarioId]
  );
  return result.rows[0] || null;
}

async function attachTokens(scenarioRows) {
  if (scenarioRows.length === 0) return [];
  const tokens = await pool.query(
    'SELECT * FROM scenario_tokens WHERE scenario_id = ANY($1) ORDER BY id',
    [scenarioRows.map((s) => s.id)]
  );
  const byScenario = {};
  for (const t of tokens.rows) (byScenario[t.scenario_id] ??= []).push(t);
  return scenarioRows.map((s) => ({ ...s, tokens: byScenario[s.id] || [] }));
}

/**
 * GET /campaigns/:campaignId/scenarios
 */
router.get('/campaigns/:campaignId/scenarios', requireGm, async (req, res) => {
  try {
    if (!(await ownedCampaign(req.params.campaignId, req.user.id))) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const result = await pool.query(
      `SELECT s.*, m.url AS background_url, m.type AS background_type
       FROM campaign_scenarios s
       LEFT JOIN board_media m ON m.id = s.background_media_id
       WHERE s.campaign_id = $1 ORDER BY s.created_at`,
      [req.params.campaignId]
    );
    res.json(await attachTokens(result.rows));
  } catch (error) {
    console.error('Error GET /campaigns/:campaignId/scenarios:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /campaigns/:campaignId/scenarios
 * Body: { name, notes, background_media_id }
 */
router.post('/campaigns/:campaignId/scenarios', requireGm, async (req, res) => {
  try {
    if (!(await ownedCampaign(req.params.campaignId, req.user.id))) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const { name, notes, background_media_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom du scénario requis' });

    const result = await pool.query(
      `INSERT INTO campaign_scenarios (campaign_id, name, notes, background_media_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.campaignId, name, notes || null, background_media_id || null]
    );
    res.status(201).json({ ...result.rows[0], background_url: null, background_type: null, tokens: [] });
  } catch (error) {
    console.error('Error POST /campaigns/:campaignId/scenarios:', error.message);
    res.status(500).json({ error: 'Erreur lors de la création du scénario' });
  }
});

/**
 * PATCH /scenarios/:id
 * Body: { name, notes, background_media_id }
 */
router.patch('/scenarios/:id', requireGm, async (req, res) => {
  try {
    const { name, notes, background_media_id } = req.body;
    const result = await pool.query(
      `UPDATE campaign_scenarios s SET
         name = COALESCE($1, s.name),
         notes = COALESCE($2, s.notes),
         background_media_id = COALESCE($3, s.background_media_id)
       FROM campaigns c
       WHERE s.id = $4 AND s.campaign_id = c.id AND c.gm_id = $5
       RETURNING s.id`,
      [name, notes, background_media_id, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Scénario non trouvé' });
    res.json((await attachTokens([await getScenarioRow(result.rows[0].id)]))[0]);
  } catch (error) {
    console.error('Error PATCH /scenarios/:id:', error.message);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

/**
 * DELETE /scenarios/:id
 */
router.delete('/scenarios/:id', requireGm, async (req, res) => {
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

/**
 * POST /scenarios/:id/tokens — add a prepared token to a scenario.
 * Body: { label, character_id, image_url, color, x, y, visible_to_players }
 */
router.post('/scenarios/:id/tokens', requireGm, async (req, res) => {
  try {
    if (!(await ownedScenario(req.params.id, req.user.id))) {
      return res.status(404).json({ error: 'Scénario non trouvé' });
    }

    const { label, character_id, image_url, color, x, y, visible_to_players } = req.body;
    if (!label) return res.status(400).json({ error: 'Nom du pion requis' });

    await pool.query(
      `INSERT INTO scenario_tokens (scenario_id, character_id, label, image_url, color, x, y, visible_to_players)
       VALUES ($1, $2, $3, $4, COALESCE($5, '#c65d3b'), COALESCE($6, 50), COALESCE($7, 50), COALESCE($8, true))`,
      [req.params.id, character_id || null, label, image_url || null, color, x, y, visible_to_players]
    );

    res.status(201).json((await attachTokens([await getScenarioRow(req.params.id)]))[0]);
  } catch (error) {
    console.error('Error POST /scenarios/:id/tokens:', error.message);
    res.status(500).json({ error: "Erreur lors de l'ajout du pion" });
  }
});

/**
 * PATCH /scenario-tokens/:id — move or edit a prepared token (drag-end sends x/y).
 */
router.patch('/scenario-tokens/:id', requireGm, async (req, res) => {
  try {
    const { label, image_url, color, x, y, visible_to_players } = req.body;
    const result = await pool.query(
      `UPDATE scenario_tokens t SET
         label = COALESCE($1, t.label),
         image_url = COALESCE($2, t.image_url),
         color = COALESCE($3, t.color),
         x = COALESCE($4, t.x),
         y = COALESCE($5, t.y),
         visible_to_players = COALESCE($6, t.visible_to_players)
       FROM campaign_scenarios s JOIN campaigns c ON c.id = s.campaign_id
       WHERE t.id = $7 AND t.scenario_id = s.id AND c.gm_id = $8
       RETURNING t.*`,
      [label, image_url, color, x, y, visible_to_players, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Pion non trouvé' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error PATCH /scenario-tokens/:id:', error.message);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du pion' });
  }
});

/**
 * DELETE /scenario-tokens/:id
 */
router.delete('/scenario-tokens/:id', requireGm, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM scenario_tokens t
       USING campaign_scenarios s, campaigns c
       WHERE t.id = $1 AND t.scenario_id = s.id AND s.campaign_id = c.id AND c.gm_id = $2
       RETURNING t.id`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Pion non trouvé' });
    res.json({ message: 'Pion supprimé' });
  } catch (error) {
    console.error('Error DELETE /scenario-tokens/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /scenarios/:id/launch — applies the scenario's prepared background (if any) and adds
 * its prepared tokens to the campaign's live board. Additive only: never clears or replaces
 * whatever tokens/background the board already has.
 */
router.post('/scenarios/:id/launch', requireGm, async (req, res) => {
  try {
    const scenario = await ownedScenario(req.params.id, req.user.id);
    if (!scenario) return res.status(404).json({ error: 'Scénario non trouvé' });

    const [full] = await attachTokens([await getScenarioRow(req.params.id)]);

    const board = await getOrCreateBoard(scenario.campaign_id);

    if (full.background_media_id) {
      await pool.query(
        'UPDATE board_states SET background_url = $1, background_type = $2 WHERE id = $3',
        [full.background_url, full.background_type, board.id]
      );
    }

    for (const t of full.tokens) {
      await pool.query(
        `INSERT INTO board_tokens (board_state_id, character_id, label, image_url, color, x, y, visible_to_players)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [board.id, t.character_id, t.label, t.image_url, t.color, t.x, t.y, t.visible_to_players]
      );
    }

    const fullBoard = await getFullBoard(scenario.campaign_id);
    broadcastBoard(scenario.campaign_id, fullBoard, buildBoardForRole);
    res.json({ message: 'Scénario lancé', tokens_added: full.tokens.length });
  } catch (error) {
    console.error('Error POST /scenarios/:id/launch:', error.message);
    res.status(500).json({ error: 'Erreur lors du lancement du scénario' });
  }
});

export default router;
