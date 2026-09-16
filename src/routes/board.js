import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken, requireGm } from '../middleware/auth.js';
import { findAccessibleCampaign } from './campaigns.js';
import { broadcastBoard, broadcastPing } from '../services/boardStream.js';
import { TOKEN_ENRICHMENT_COLUMNS, TOKEN_ENRICHMENT_JOINS } from '../services/tokenEnrichment.js';
import { upload } from '../services/uploads.js';

const router = Router();

export async function getOrCreateBoard(campaignId) {
  const existing = await pool.query('SELECT * FROM board_states WHERE campaign_id = $1', [campaignId]);
  if (existing.rows.length > 0) return existing.rows[0];

  const created = await pool.query(
    'INSERT INTO board_states (campaign_id) VALUES ($1) RETURNING *',
    [campaignId]
  );
  return created.rows[0];
}

export async function getFullBoard(campaignId) {
  const board = await getOrCreateBoard(campaignId);
  const [tokens, zones] = await Promise.all([
    pool.query(
      `SELECT t.*, c.name AS character_name, c.is_npc,
              c.pv_current, c.pv_max, c.pm_current, c.pm_max,
              c.points_chance, c.points_chance_current, c.defense, c.initiative, c.caracteristiques,
              c.avatar_url AS character_avatar_url, c.avatar_emoji AS character_avatar_emoji,${TOKEN_ENRICHMENT_COLUMNS}
       FROM board_tokens t
       LEFT JOIN characters c ON c.id = t.character_id${TOKEN_ENRICHMENT_JOINS}
       WHERE t.board_state_id = $1 ORDER BY t.id`,
      [board.id]
    ),
    pool.query('SELECT * FROM board_zones WHERE board_state_id = $1 ORDER BY id', [board.id]),
  ]);
  return { ...board, tokens: tokens.rows, zones: zones.rows };
}

const STAT_FIELDS = ['pv_current', 'pv_max', 'pm_current', 'pm_max', 'points_chance', 'points_chance_current', 'defense', 'initiative', 'caracteristiques'];

// A creature pawn's own PV (Token's on-canvas life bar) and, for a bestiary monster, its whole
// joined stat block (CreatureSummaryCard's Déf/Init/attaques/capacités) — hidden together so a
// player can never back into the monster's identity/stats just because its exact PV is masked.
// player_hp_label is deliberately NOT in this list: it's the GM's own opt-in replacement clue,
// meant exactly for players to see in place of the real numbers.
const HIDDEN_CREATURE_FIELDS = [
  'hp_current', 'hp_max',
  'monstre_name', 'monstre_category', 'monstre_nc', 'monstre_defense',
  'monstre_initiative', 'monstre_attaques', 'monstre_caracteristiques', 'monstre_capacites',
];

// A PNJ's live stats never reach a player, even when its pawn is shown on the map — only the
// GM's own view (and the HUD it drives) gets to see enemy PV/PM/etc in real time. Same idea for
// a creature pawn the GM marked hide_hp_from_players (typically an enemy spawned from the
// bibliothèque d'ennemis) — its own life bar/stat block never reaches a player either.
function stripEnemyStats(token) {
  let stripped = token;
  if (token.is_npc) {
    stripped = { ...stripped };
    for (const field of STAT_FIELDS) stripped[field] = null;
  }
  if (token.hide_hp_from_players) {
    stripped = { ...stripped };
    for (const field of HIDDEN_CREATURE_FIELDS) stripped[field] = null;
  }
  return stripped;
}

// GM sees every token/zone with full stats; players only see the ones the GM marked visible,
// and never get a PNJ token's live stats (only its pawn, if the GM chose to show it at all).
export function buildBoardForRole(board, role) {
  if (role === 'gm') return board;
  return {
    ...board,
    tokens: board.tokens.filter((t) => t.visible_to_players).map(stripEnemyStats),
    zones: board.zones.filter((z) => z.visible_to_players),
  };
}

// Exported for sseStreams.js — board-stream needs the exact same access check as the plain
// GET below, but as its own route living outside any blanket-authenticateToken router (see
// sseStreams.js for why: EventSource can't send an Authorization header, so a router-level
// blanket auth would 401 it before its own bypass, if any, ever got a chance to run).
export async function resolveRole(campaignId, user) {
  const campaign = await findAccessibleCampaign(campaignId, user);
  if (!campaign) return null;
  return campaign.gm_id === user.id ? 'gm' : 'player';
}

router.use(authenticateToken);

/**
 * GET /campaigns/:campaignId/board
 */
router.get('/campaigns/:campaignId/board', async (req, res) => {
  try {
    const role = await resolveRole(req.params.campaignId, req.user);
    if (!role) return res.status(404).json({ error: 'Campagne non trouvée' });

    const board = await getFullBoard(req.params.campaignId);
    res.json(buildBoardForRole(board, role));
  } catch (error) {
    console.error('Error GET board:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * PATCH /campaigns/:campaignId/board — GM only.
 * Body: { background_url, background_type, grid_visible, grid_size,
 *         camera_x, camera_y, camera_width, camera_width_delta, initiative_visible,
 *         music_url, music_playing, music_volume, fog_enabled, fog_revealed, handout_url }
 * background_type ('image' | 'video') tells the frontend how to render background_url —
 * a video plays fullscreen/looped/muted behind the grid/zones/tokens instead of being used
 * as a CSS background-image (p.ex. pour une ambiance sonore/visuelle hors combat).
 * camera_x/camera_y/camera_width define the window of the full scene the projector actually
 * shows (the GM's own view always shows the full scene) — x/y are sent as absolute values on
 * drag-end (same pattern as tokens/zones), camera_width_delta is applied atomically in SQL on
 * a zoom +/- click (same reasoning as board_zones' size_delta: a client-computed absolute value
 * would drop clicks fired before the previous response updates local state). Clamped to keep
 * the window a sane size and roughly on-scene; exact edge-of-scene clamping is left to the GM.
 * music_url/music_playing/music_volume run independently of background_url/type — an ambiance
 * track plays alongside whatever visual background is showing, not instead of it.
 * fog_revealed is always sent as the full array (the GM's paint UI computes reveal/hide client
 * side off the current board it already has) — same one-shot-on-release pattern as everything
 * else dragged on this board, not a request per cell touched.
 */
router.patch('/campaigns/:campaignId/board', requireGm, async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.campaignId, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    await getOrCreateBoard(req.params.campaignId);
    const {
      background_url, background_type, grid_visible, grid_size,
      camera_x, camera_y, camera_width, camera_width_delta,
      token_size_delta, initiative_visible,
      music_url, music_playing, music_volume,
      fog_enabled, fog_revealed, handout_url,
    } = req.body;
    await pool.query(
      `UPDATE board_states SET
         background_url = COALESCE($1, background_url),
         background_type = COALESCE($2, background_type),
         grid_visible = COALESCE($3, grid_visible),
         grid_size = COALESCE($4, grid_size),
         camera_x = LEAST(100, GREATEST(0, COALESCE($5, camera_x))),
         camera_y = LEAST(100, GREATEST(0, COALESCE($6, camera_y))),
         camera_width = CASE
           WHEN $7::real IS NOT NULL THEN LEAST(100, GREATEST(10, $7))
           WHEN $8::real IS NOT NULL THEN LEAST(100, GREATEST(10, camera_width + $8))
           ELSE camera_width
         END,
         token_size = CASE
           WHEN $9::int IS NOT NULL THEN LEAST(80, GREATEST(20, token_size + $9))
           ELSE token_size
         END,
         initiative_visible = COALESCE($11, initiative_visible),
         music_url = COALESCE($12, music_url),
         music_playing = COALESCE($13, music_playing),
         music_volume = COALESCE($14, music_volume),
         fog_enabled = COALESCE($15, fog_enabled),
         fog_revealed = COALESCE($16::jsonb, fog_revealed),
         handout_url = COALESCE($17, handout_url)
       WHERE campaign_id = $10`,
      [
        background_url, background_type, grid_visible, grid_size,
        camera_x, camera_y, camera_width, camera_width_delta,
        token_size_delta,
        req.params.campaignId, initiative_visible,
        music_url, music_playing, music_volume,
        fog_enabled, fog_revealed ? JSON.stringify(fog_revealed) : null, handout_url,
      ]
    );

    const board = await getFullBoard(req.params.campaignId);
    broadcastBoard(req.params.campaignId, board, buildBoardForRole);
    res.json(board);
  } catch (error) {
    console.error('Error PATCH board:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// The turn order is never stored — it's whoever currently has a character-linked token on the
// board, sorted by their (already-computed) initiative, highest first. Recomputing it fresh
// every time (rather than snapshotting an ordered list) means a token added/removed mid-combat
// just slots into the order on the next "Suivant" instead of leaving stale/dangling entries.
function initiativeOrder(board) {
  return board.tokens
    .filter((t) => t.character_id != null)
    .sort((a, b) => (b.initiative ?? 0) - (a.initiative ?? 0) || a.id - b.id);
}

/**
 * POST /campaigns/:campaignId/board/initiative/next — GM only. Advances to the next
 * combatant in initiative order (wrapping around and bumping initiative_round). If nobody
 * currently has the turn (fresh combat, or the previous holder's token got removed), starts
 * at the top of the order instead of erroring.
 */
router.post('/campaigns/:campaignId/board/initiative/next', requireGm, async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.campaignId, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    const board = await getFullBoard(req.params.campaignId);
    const order = initiativeOrder(board);
    if (order.length === 0) return res.status(400).json({ error: 'Aucun personnage sur le plateau' });

    const currentIndex = order.findIndex((t) => t.id === board.initiative_current_token_id);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % order.length;
    const wrapped = currentIndex !== -1 && nextIndex === 0;

    await pool.query(
      `UPDATE board_states SET
         initiative_current_token_id = $1,
         initiative_round = initiative_round + CASE WHEN $2 THEN 1 ELSE 0 END
       WHERE campaign_id = $3`,
      [order[nextIndex].id, wrapped, req.params.campaignId]
    );

    const updated = await getFullBoard(req.params.campaignId);
    broadcastBoard(req.params.campaignId, updated, buildBoardForRole);
    res.json(updated);
  } catch (error) {
    console.error('Error POST board initiative/next:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /campaigns/:campaignId/board/initiative/reset — GM only. Clears the current turn and
 * round counter back to the start of combat, without touching initiative_visible.
 */
router.post('/campaigns/:campaignId/board/initiative/reset', requireGm, async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.campaignId, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    await pool.query(
      `UPDATE board_states SET initiative_current_token_id = NULL, initiative_round = 1 WHERE campaign_id = $1`,
      [req.params.campaignId]
    );

    const updated = await getFullBoard(req.params.campaignId);
    broadcastBoard(req.params.campaignId, updated, buildBoardForRole);
    res.json(updated);
  } catch (error) {
    console.error('Error POST board initiative/reset:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /campaigns/:campaignId/board/upload — GM only, multipart field "image"
 */
router.post('/campaigns/:campaignId/board/upload', requireGm, upload.single('image'), async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.campaignId, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });
    if (!req.file) return res.status(400).json({ error: 'Aucune image fournie' });

    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  } catch (error) {
    console.error('Error POST board upload:', error.message);
    res.status(500).json({ error: "Erreur lors de l'upload" });
  }
});

/**
 * POST /campaigns/:campaignId/board/ping — GM only. Body: { x, y } (% of the scene). Broadcasts
 * a transient pointer to every viewer — never persisted, nothing to fetch back on page load.
 */
router.post('/campaigns/:campaignId/board/ping', requireGm, async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.campaignId, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    const { x, y } = req.body;
    if (typeof x !== 'number' || typeof y !== 'number') {
      return res.status(400).json({ error: 'Coordonnées invalides' });
    }
    broadcastPing(req.params.campaignId, x, y);
    res.status(204).end();
  } catch (error) {
    console.error('Error POST board ping:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /campaigns/:campaignId/board/drawings — any campaign member (GM or player), not GM-only:
 * a quick shared annotation is exactly the kind of thing a player should be able to add too.
 * Body: { points: [{x, y}, ...], color }. Appended atomically with jsonb's || operator instead
 * of a client-computed full-array replace — a player and the GM could draw at the same moment,
 * and a replace would let whichever request lands second silently drop the other's stroke.
 */
router.post('/campaigns/:campaignId/board/drawings', async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.campaignId, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    const { points, color } = req.body;
    if (!Array.isArray(points) || points.length < 2) {
      return res.status(400).json({ error: 'Trait invalide' });
    }

    await getOrCreateBoard(req.params.campaignId);
    await pool.query(
      `UPDATE board_states SET drawings = drawings || $1::jsonb WHERE campaign_id = $2`,
      [JSON.stringify([{ points, color: color || '#ef4444' }]), req.params.campaignId]
    );

    const board = await getFullBoard(req.params.campaignId);
    broadcastBoard(req.params.campaignId, board, buildBoardForRole);
    res.status(201).json(board);
  } catch (error) {
    console.error('Error POST board drawings:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * DELETE /campaigns/:campaignId/board/drawings/last — GM only. Removes the most recently added
 * stroke (whoever drew it) — a quick "oops" undo, not scoped to the caller's own strokes.
 */
router.delete('/campaigns/:campaignId/board/drawings/last', requireGm, async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.campaignId, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    await pool.query(
      `UPDATE board_states SET drawings =
         CASE WHEN jsonb_array_length(drawings) > 0 THEN drawings - (jsonb_array_length(drawings) - 1) ELSE drawings END
       WHERE campaign_id = $1`,
      [req.params.campaignId]
    );

    const board = await getFullBoard(req.params.campaignId);
    broadcastBoard(req.params.campaignId, board, buildBoardForRole);
    res.json(board);
  } catch (error) {
    console.error('Error DELETE board drawings/last:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * DELETE /campaigns/:campaignId/board/drawings — GM only. Clears every stroke.
 */
router.delete('/campaigns/:campaignId/board/drawings', requireGm, async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.campaignId, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    await pool.query(`UPDATE board_states SET drawings = '[]' WHERE campaign_id = $1`, [req.params.campaignId]);

    const board = await getFullBoard(req.params.campaignId);
    broadcastBoard(req.params.campaignId, board, buildBoardForRole);
    res.json(board);
  } catch (error) {
    console.error('Error DELETE board drawings:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /campaigns/:campaignId/board/tokens — GM only
 */
router.post('/campaigns/:campaignId/board/tokens', requireGm, async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.campaignId, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    const board = await getOrCreateBoard(req.params.campaignId);
    const {
      label, character_id, image_url, color, x, y, visible_to_players, hp_max,
      owner_character_id, monstre_id, hide_hp_from_players,
    } = req.body;

    if (!label) return res.status(400).json({ error: 'Nom du pion requis' });

    // A creature pawn (no character_id) can start with its own PV — hp_current always starts
    // full at hp_max, there's no partial-health-on-creation use case. monstre_id's own stats
    // (defense/attaques/caracteristiques) are joined live in getFullBoard, not copied here —
    // only hp_max (the caller already read it off the bestiary entry to pass in) is snapshotted,
    // same as a golem's. hide_hp_from_players defaults to true for a bestiary spawn (the whole
    // point of the bibliothèque d'ennemis is a pawn the players shouldn't see the real PV of)
    // and false otherwise (a golem is player-owned, a plain named pawn is whatever the GM wants
    // it to be) — the caller can still override either way.
    const hideHp = hide_hp_from_players ?? (monstre_id != null);
    await pool.query(
      `INSERT INTO board_tokens (board_state_id, character_id, label, image_url, color, x, y, visible_to_players, hp_current, hp_max, owner_character_id, monstre_id, hide_hp_from_players)
       VALUES ($1, $2, $3, $4, COALESCE($5, '#c65d3b'), COALESCE($6, 50), COALESCE($7, 50), COALESCE($8, true), $9, $9, $10, $11, $12)`,
      [board.id, character_id || null, label, image_url || null, color, x, y, visible_to_players, hp_max || null, owner_character_id || null, monstre_id || null, hideHp]
    );

    const fullBoard = await getFullBoard(req.params.campaignId);
    broadcastBoard(req.params.campaignId, fullBoard, buildBoardForRole);
    res.status(201).json(fullBoard);
  } catch (error) {
    console.error('Error POST board token:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * PATCH /board/tokens/:tokenId — GM only (position, visibility, label, image, color)
 */
router.patch('/board/tokens/:tokenId', requireGm, async (req, res) => {
  try {
    const tokenRow = await pool.query(
      `SELECT bt.*, bs.campaign_id FROM board_tokens bt
       JOIN board_states bs ON bs.id = bt.board_state_id
       WHERE bt.id = $1`,
      [req.params.tokenId]
    );
    if (tokenRow.rows.length === 0) return res.status(404).json({ error: 'Pion non trouvé' });

    const { campaign_id } = tokenRow.rows[0];
    const campaign = await findAccessibleCampaign(campaign_id, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    const {
      label, image_url, color, x, y, visible_to_players, hp_delta,
      hide_hp_from_players, player_hp_label, status_icons,
    } = req.body;
    // hp_delta (not an absolute value) applies atomically in SQL, same reasoning as board_zones'
    // size_delta — a GM clicking a creature's PV +/- rapidly would otherwise drop in-flight
    // clicks fired before the previous response's state lands. Clamped to [0, hp_max]; a no-op
    // (CASE ... ELSE hp_current) for a plain pawn that never had hp_max set. status_icons is
    // always sent as the full array (the GM UI manages add/remove locally), not a delta.
    await pool.query(
      `UPDATE board_tokens SET
         label = COALESCE($1, label),
         image_url = COALESCE($2, image_url),
         color = COALESCE($3, color),
         x = COALESCE($4, x),
         y = COALESCE($5, y),
         visible_to_players = COALESCE($6, visible_to_players),
         hp_current = CASE
           WHEN hp_max IS NOT NULL AND $7::int IS NOT NULL
             THEN LEAST(hp_max, GREATEST(0, hp_current + $7))
           ELSE hp_current
         END,
         hide_hp_from_players = COALESCE($9, hide_hp_from_players),
         player_hp_label = COALESCE($10, player_hp_label),
         status_icons = COALESCE($11::jsonb, status_icons)
       WHERE id = $8`,
      [
        label, image_url, color, x, y, visible_to_players, hp_delta, req.params.tokenId,
        hide_hp_from_players, player_hp_label, status_icons ? JSON.stringify(status_icons) : null,
      ]
    );

    const fullBoard = await getFullBoard(campaign_id);
    broadcastBoard(campaign_id, fullBoard, buildBoardForRole);
    res.json(fullBoard);
  } catch (error) {
    console.error('Error PATCH board token:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /campaigns/:campaignId/board/zones — GM only
 * Body: { shape ('circle'|'rectangle'|'cone'), label, color, x, y, size, width, rotation, visible_to_players }
 */
router.post('/campaigns/:campaignId/board/zones', requireGm, async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.campaignId, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    const board = await getOrCreateBoard(req.params.campaignId);
    const { shape, label, color, x, y, size, width, rotation, visible_to_players } = req.body;

    if (!['circle', 'rectangle', 'cone'].includes(shape)) {
      return res.status(400).json({ error: 'Forme de zone invalide' });
    }

    await pool.query(
      `INSERT INTO board_zones (board_state_id, shape, label, color, x, y, size, width, rotation, visible_to_players)
       VALUES ($1, $2, $3, COALESCE($4, '#c65d3b'), COALESCE($5, 50), COALESCE($6, 50),
               COALESCE($7, 10), COALESCE($8, 10), COALESCE($9, 0), COALESCE($10, true))`,
      [board.id, shape, label || null, color, x, y, size, width, rotation, visible_to_players]
    );

    const fullBoard = await getFullBoard(req.params.campaignId);
    broadcastBoard(req.params.campaignId, fullBoard, buildBoardForRole);
    res.status(201).json(fullBoard);
  } catch (error) {
    console.error('Error POST board zone:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * PATCH /board/zones/:zoneId — GM only
 */
router.patch('/board/zones/:zoneId', requireGm, async (req, res) => {
  try {
    const zoneRow = await pool.query(
      `SELECT bz.*, bs.campaign_id FROM board_zones bz
       JOIN board_states bs ON bs.id = bz.board_state_id
       WHERE bz.id = $1`,
      [req.params.zoneId]
    );
    if (zoneRow.rows.length === 0) return res.status(404).json({ error: 'Zone non trouvée' });

    const { campaign_id } = zoneRow.rows[0];
    const campaign = await findAccessibleCampaign(campaign_id, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    const {
      label, color, x, y, visible_to_players,
      size_delta, width_delta, rotation_delta,
    } = req.body;
    // size/width/rotation move by a server-applied delta rather than an absolute value the
    // client computed — a GM clicking +/- rapidly fires several requests before the first
    // response (and its updated selectedZone state) comes back, so a client-computed absolute
    // value silently drops in-flight clicks. GREATEST/MOD keep the accumulation atomic in SQL.
    await pool.query(
      `UPDATE board_zones SET
         label = COALESCE($1, label),
         color = COALESCE($2, color),
         x = COALESCE($3, x),
         y = COALESCE($4, y),
         size = GREATEST(1, size + COALESCE($5, 0)),
         width = GREATEST(1, width + COALESCE($6, 0)),
         rotation = MOD((rotation + COALESCE($7, 0) + 360)::numeric, 360),
         visible_to_players = COALESCE($8, visible_to_players)
       WHERE id = $9`,
      [label, color, x, y, size_delta, width_delta, rotation_delta, visible_to_players, req.params.zoneId]
    );

    const fullBoard = await getFullBoard(campaign_id);
    broadcastBoard(campaign_id, fullBoard, buildBoardForRole);
    res.json(fullBoard);
  } catch (error) {
    console.error('Error PATCH board zone:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * DELETE /board/zones/:zoneId — GM only
 */
router.delete('/board/zones/:zoneId', requireGm, async (req, res) => {
  try {
    const zoneRow = await pool.query(
      `SELECT bz.id, bs.campaign_id FROM board_zones bz
       JOIN board_states bs ON bs.id = bz.board_state_id
       WHERE bz.id = $1`,
      [req.params.zoneId]
    );
    if (zoneRow.rows.length === 0) return res.status(404).json({ error: 'Zone non trouvée' });

    const { campaign_id } = zoneRow.rows[0];
    const campaign = await findAccessibleCampaign(campaign_id, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    await pool.query('DELETE FROM board_zones WHERE id = $1', [req.params.zoneId]);

    const fullBoard = await getFullBoard(campaign_id);
    broadcastBoard(campaign_id, fullBoard, buildBoardForRole);
    res.json(fullBoard);
  } catch (error) {
    console.error('Error DELETE board zone:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * DELETE /board/tokens/:tokenId — GM only
 */
router.delete('/board/tokens/:tokenId', requireGm, async (req, res) => {
  try {
    const tokenRow = await pool.query(
      `SELECT bt.id, bs.campaign_id FROM board_tokens bt
       JOIN board_states bs ON bs.id = bt.board_state_id
       WHERE bt.id = $1`,
      [req.params.tokenId]
    );
    if (tokenRow.rows.length === 0) return res.status(404).json({ error: 'Pion non trouvé' });

    const { campaign_id } = tokenRow.rows[0];
    const campaign = await findAccessibleCampaign(campaign_id, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    await pool.query('DELETE FROM board_tokens WHERE id = $1', [req.params.tokenId]);

    const fullBoard = await getFullBoard(campaign_id);
    broadcastBoard(campaign_id, fullBoard, buildBoardForRole);
    res.json(fullBoard);
  } catch (error) {
    console.error('Error DELETE board token:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
