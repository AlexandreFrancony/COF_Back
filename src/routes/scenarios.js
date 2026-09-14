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
    `SELECT t.*, c.avatar_url AS character_avatar_url, c.avatar_emoji AS character_avatar_emoji
     FROM scenario_tokens t LEFT JOIN characters c ON c.id = t.character_id
     WHERE t.scenario_id = ANY($1) ORDER BY t.id`,
    [scenarioRows.map((s) => s.id)]
  );
  const byScenario = {};
  for (const t of tokens.rows) (byScenario[t.scenario_id] ??= []).push(t);
  return scenarioRows.map((s) => ({ ...s, tokens: byScenario[s.id] || [] }));
}

async function attachZones(scenarioRows) {
  if (scenarioRows.length === 0) return [];
  const zones = await pool.query(
    'SELECT * FROM scenario_zones WHERE scenario_id = ANY($1) ORDER BY id',
    [scenarioRows.map((s) => s.id)]
  );
  const byScenario = {};
  for (const z of zones.rows) (byScenario[z.scenario_id] ??= []).push(z);
  return scenarioRows.map((s) => ({ ...s, zones: byScenario[s.id] || [] }));
}

// A scenario is enriched the same way a live board is (getFullBoard): its background (joined),
// tokens and zones, so the shared BoardEditor component can render either one interchangeably.
async function enrichScenarios(scenarioRows) {
  return attachZones(await attachTokens(scenarioRows));
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
    res.json(await enrichScenarios(result.rows));
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
    res.status(201).json({ ...result.rows[0], background_url: null, background_type: null, tokens: [], zones: [] });
  } catch (error) {
    console.error('Error POST /campaigns/:campaignId/scenarios:', error.message);
    res.status(500).json({ error: 'Erreur lors de la création du scénario' });
  }
});

/**
 * PATCH /scenarios/:id
 * Body: { name, notes, background_media_id, grid_visible, grid_size, token_size_delta }
 * grid_visible/grid_size are absolute (a checkbox and a direct value have no race to guard
 * against); token_size_delta is an atomic server-side delta, same reasoning as board_states'
 * own token_size_delta (see PATCH /campaigns/:campaignId/board) — and the first +/- click ever
 * made on a scenario's token size seeds it off the same 40px default the live board starts at,
 * via COALESCE(token_size, 40), rather than off NULL.
 */
router.patch('/scenarios/:id', requireGm, async (req, res) => {
  try {
    const { name, notes, background_media_id, grid_visible, grid_size, token_size_delta } = req.body;
    const result = await pool.query(
      `UPDATE campaign_scenarios s SET
         name = COALESCE($1, s.name),
         notes = COALESCE($2, s.notes),
         background_media_id = COALESCE($3, s.background_media_id),
         grid_visible = COALESCE($4, s.grid_visible),
         grid_size = COALESCE($5, s.grid_size),
         token_size = CASE
           WHEN $6::int IS NOT NULL THEN LEAST(80, GREATEST(20, COALESCE(s.token_size, 40) + $6))
           ELSE s.token_size
         END
       FROM campaigns c
       WHERE s.id = $7 AND s.campaign_id = c.id AND c.gm_id = $8
       RETURNING s.id`,
      [name, notes, background_media_id, grid_visible, grid_size, token_size_delta, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Scénario non trouvé' });
    res.json((await enrichScenarios([await getScenarioRow(result.rows[0].id)]))[0]);
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

    const { label, character_id, image_url, color, x, y, visible_to_players, hp_max } = req.body;
    if (!label) return res.status(400).json({ error: 'Nom du pion requis' });

    await pool.query(
      `INSERT INTO scenario_tokens (scenario_id, character_id, label, image_url, color, x, y, visible_to_players, hp_current, hp_max)
       VALUES ($1, $2, $3, $4, COALESCE($5, '#c65d3b'), COALESCE($6, 50), COALESCE($7, 50), COALESCE($8, true), $9, $9)`,
      [req.params.id, character_id || null, label, image_url || null, color, x, y, visible_to_players, hp_max || null]
    );

    res.status(201).json((await enrichScenarios([await getScenarioRow(req.params.id)]))[0]);
  } catch (error) {
    console.error('Error POST /scenarios/:id/tokens:', error.message);
    res.status(500).json({ error: "Erreur lors de l'ajout du pion" });
  }
});

/**
 * PATCH /scenario-tokens/:id — move or edit a prepared token (drag-end sends x/y). Returns the
 * full enriched scenario (not just the token row) — same contract as board.js's own token/zone
 * routes returning the full board — so the shared BoardEditor's "apply the response" handler
 * works identically whether it's talking to a live board or a scenario.
 */
router.patch('/scenario-tokens/:id', requireGm, async (req, res) => {
  try {
    const { label, image_url, color, x, y, visible_to_players, hp_delta } = req.body;
    const result = await pool.query(
      `UPDATE scenario_tokens t SET
         label = COALESCE($1, t.label),
         image_url = COALESCE($2, t.image_url),
         color = COALESCE($3, t.color),
         x = COALESCE($4, t.x),
         y = COALESCE($5, t.y),
         visible_to_players = COALESCE($6, t.visible_to_players),
         hp_current = CASE
           WHEN t.hp_max IS NOT NULL AND $7::int IS NOT NULL
             THEN LEAST(t.hp_max, GREATEST(0, t.hp_current + $7))
           ELSE t.hp_current
         END
       FROM campaign_scenarios s JOIN campaigns c ON c.id = s.campaign_id
       WHERE t.id = $8 AND t.scenario_id = s.id AND c.gm_id = $9
       RETURNING t.scenario_id`,
      [label, image_url, color, x, y, visible_to_players, hp_delta, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Pion non trouvé' });
    res.json((await enrichScenarios([await getScenarioRow(result.rows[0].scenario_id)]))[0]);
  } catch (error) {
    console.error('Error PATCH /scenario-tokens/:id:', error.message);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du pion' });
  }
});

/**
 * DELETE /scenario-tokens/:id — returns the full enriched scenario, see PATCH above.
 */
router.delete('/scenario-tokens/:id', requireGm, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM scenario_tokens t
       USING campaign_scenarios s, campaigns c
       WHERE t.id = $1 AND t.scenario_id = s.id AND s.campaign_id = c.id AND c.gm_id = $2
       RETURNING t.scenario_id`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Pion non trouvé' });
    res.json((await enrichScenarios([await getScenarioRow(result.rows[0].scenario_id)]))[0]);
  } catch (error) {
    console.error('Error DELETE /scenario-tokens/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /scenarios/:id/zones — add a prepared zone. Body mirrors POST board/zones exactly:
 * { shape ('circle'|'rectangle'|'cone'), label, color, x, y, size, width, rotation, visible_to_players }
 */
router.post('/scenarios/:id/zones', requireGm, async (req, res) => {
  try {
    if (!(await ownedScenario(req.params.id, req.user.id))) {
      return res.status(404).json({ error: 'Scénario non trouvé' });
    }

    const { shape, label, color, x, y, size, width, rotation, visible_to_players } = req.body;
    if (!['circle', 'rectangle', 'cone'].includes(shape)) {
      return res.status(400).json({ error: 'Forme de zone invalide' });
    }

    await pool.query(
      `INSERT INTO scenario_zones (scenario_id, shape, label, color, x, y, size, width, rotation, visible_to_players)
       VALUES ($1, $2, $3, COALESCE($4, '#c65d3b'), COALESCE($5, 50), COALESCE($6, 50),
               COALESCE($7, 10), COALESCE($8, 10), COALESCE($9, 0), COALESCE($10, true))`,
      [req.params.id, shape, label || null, color, x, y, size, width, rotation, visible_to_players]
    );

    res.status(201).json((await enrichScenarios([await getScenarioRow(req.params.id)]))[0]);
  } catch (error) {
    console.error('Error POST /scenarios/:id/zones:', error.message);
    res.status(500).json({ error: "Erreur lors de l'ajout de la zone" });
  }
});

/**
 * PATCH /scenario-zones/:id — mirrors PATCH board/zones/:zoneId (same delta-based size/width/
 * rotation reasoning), returns the full enriched scenario.
 */
router.patch('/scenario-zones/:id', requireGm, async (req, res) => {
  try {
    const {
      label, color, x, y, visible_to_players,
      size_delta, width_delta, rotation_delta,
    } = req.body;
    const result = await pool.query(
      `UPDATE scenario_zones z SET
         label = COALESCE($1, z.label),
         color = COALESCE($2, z.color),
         x = COALESCE($3, z.x),
         y = COALESCE($4, z.y),
         size = GREATEST(1, z.size + COALESCE($5, 0)),
         width = GREATEST(1, z.width + COALESCE($6, 0)),
         rotation = MOD((z.rotation + COALESCE($7, 0) + 360)::numeric, 360),
         visible_to_players = COALESCE($8, z.visible_to_players)
       FROM campaign_scenarios s JOIN campaigns c ON c.id = s.campaign_id
       WHERE z.id = $9 AND z.scenario_id = s.id AND c.gm_id = $10
       RETURNING z.scenario_id`,
      [label, color, x, y, size_delta, width_delta, rotation_delta, visible_to_players, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Zone non trouvée' });
    res.json((await enrichScenarios([await getScenarioRow(result.rows[0].scenario_id)]))[0]);
  } catch (error) {
    console.error('Error PATCH /scenario-zones/:id:', error.message);
    res.status(500).json({ error: 'Erreur lors de la mise à jour de la zone' });
  }
});

/**
 * DELETE /scenario-zones/:id
 */
router.delete('/scenario-zones/:id', requireGm, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM scenario_zones z
       USING campaign_scenarios s, campaigns c
       WHERE z.id = $1 AND z.scenario_id = s.id AND s.campaign_id = c.id AND c.gm_id = $2
       RETURNING z.scenario_id`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Zone non trouvée' });
    res.json((await enrichScenarios([await getScenarioRow(result.rows[0].scenario_id)]))[0]);
  } catch (error) {
    console.error('Error DELETE /scenario-zones/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /scenarios/:id/launch — applies whatever the scenario actually customized (background,
 * grid, token size) and adds its prepared tokens/zones to the campaign's live board. Additive
 * only for tokens/zones: nothing already on the board is ever cleared or replaced. Background/
 * grid/token size are the scenario's own settings, but each only overrides the live board when
 * it was actually set here — grid_visible/grid_size/token_size are NULL until the GM touches
 * those controls for this scenario, specifically so launching an otherwise-untouched scenario
 * can't silently reset the live board's grid to hidden or its token size back to 40.
 */
router.post('/scenarios/:id/launch', requireGm, async (req, res) => {
  try {
    const scenario = await ownedScenario(req.params.id, req.user.id);
    if (!scenario) return res.status(404).json({ error: 'Scénario non trouvé' });

    const [full] = await enrichScenarios([await getScenarioRow(req.params.id)]);

    const board = await getOrCreateBoard(scenario.campaign_id);

    await pool.query(
      `UPDATE board_states SET
         background_url = CASE WHEN $1::int IS NOT NULL THEN $2 ELSE background_url END,
         background_type = CASE WHEN $1::int IS NOT NULL THEN $3 ELSE background_type END,
         grid_visible = COALESCE($4, grid_visible),
         grid_size = COALESCE($5, grid_size),
         token_size = COALESCE($6, token_size)
       WHERE id = $7`,
      [
        full.background_media_id, full.background_url, full.background_type,
        full.grid_visible, full.grid_size, full.token_size,
        board.id,
      ]
    );

    for (const t of full.tokens) {
      await pool.query(
        `INSERT INTO board_tokens (board_state_id, character_id, label, image_url, color, x, y, visible_to_players, hp_current, hp_max)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [board.id, t.character_id, t.label, t.image_url, t.color, t.x, t.y, t.visible_to_players, t.hp_current, t.hp_max]
      );
    }

    for (const z of full.zones) {
      await pool.query(
        `INSERT INTO board_zones (board_state_id, shape, label, color, x, y, size, width, rotation, visible_to_players)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [board.id, z.shape, z.label, z.color, z.x, z.y, z.size, z.width, z.rotation, z.visible_to_players]
      );
    }

    const fullBoard = await getFullBoard(scenario.campaign_id);
    broadcastBoard(scenario.campaign_id, fullBoard, buildBoardForRole);
    res.json({ message: 'Scénario lancé', tokens_added: full.tokens.length, zones_added: full.zones.length });
  } catch (error) {
    console.error('Error POST /scenarios/:id/launch:', error.message);
    res.status(500).json({ error: 'Erreur lors du lancement du scénario' });
  }
});

export default router;
