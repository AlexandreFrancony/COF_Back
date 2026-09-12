import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';
import { authenticateToken, requireGm } from '../middleware/auth.js';
import { findAccessibleCampaign } from './campaigns.js';
import { subscribe, broadcastBoard } from '../services/boardStream.js';

const router = Router();

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) {
      return cb(new Error("Format d'image non supporté"));
    }
    cb(null, true);
  },
});

async function getOrCreateBoard(campaignId) {
  const existing = await pool.query('SELECT * FROM board_states WHERE campaign_id = $1', [campaignId]);
  if (existing.rows.length > 0) return existing.rows[0];

  const created = await pool.query(
    'INSERT INTO board_states (campaign_id) VALUES ($1) RETURNING *',
    [campaignId]
  );
  return created.rows[0];
}

async function getFullBoard(campaignId) {
  const board = await getOrCreateBoard(campaignId);
  const [tokens, zones] = await Promise.all([
    pool.query('SELECT * FROM board_tokens WHERE board_state_id = $1 ORDER BY id', [board.id]),
    pool.query('SELECT * FROM board_zones WHERE board_state_id = $1 ORDER BY id', [board.id]),
  ]);
  return { ...board, tokens: tokens.rows, zones: zones.rows };
}

// GM sees every token/zone; players only see the ones the GM marked visible.
function buildBoardForRole(board, role) {
  if (role === 'gm') return board;
  return {
    ...board,
    tokens: board.tokens.filter((t) => t.visible_to_players),
    zones: board.zones.filter((z) => z.visible_to_players),
  };
}

async function resolveRole(campaignId, user) {
  const campaign = await findAccessibleCampaign(campaignId, user);
  if (!campaign) return null;
  return campaign.gm_id === user.id ? 'gm' : 'player';
}

// campaignsRouter is mounted at '/campaigns' with a blanket authenticateToken that runs for
// every sub-path regardless of route match — so the SSE stream (which authenticates via a
// query-string token, since EventSource can't set headers) must live outside that prefix,
// otherwise campaignsRouter's header-based auth middleware 401s it before it ever gets here.
router.use((req, res, next) => {
  if (req.path.startsWith('/board-stream/')) return next();
  authenticateToken(req, res, next);
});

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
 * GET /board-stream/:campaignId — SSE, token passed as ?token=
 */
router.get('/board-stream/:campaignId', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).end();

    let user;
    try {
      user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(403).end();
    }

    const role = await resolveRole(req.params.campaignId, user);
    if (!role) return res.status(404).end();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(':ok\n\n');

    const board = await getFullBoard(req.params.campaignId);
    res.write(`event: board\ndata: ${JSON.stringify(buildBoardForRole(board, role))}\n\n`);

    subscribe(req.params.campaignId, role, res);

    const heartbeat = setInterval(() => res.write(':ping\n\n'), 25000);
    req.on('close', () => clearInterval(heartbeat));
  } catch (error) {
    console.error('Error SSE board stream:', error.message);
    res.status(500).end();
  }
});

/**
 * PATCH /campaigns/:campaignId/board — GM only. Body: { background_url, grid_visible, grid_size }
 */
router.patch('/campaigns/:campaignId/board', requireGm, async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.campaignId, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    await getOrCreateBoard(req.params.campaignId);
    const { background_url, grid_visible, grid_size } = req.body;
    await pool.query(
      `UPDATE board_states SET
         background_url = COALESCE($1, background_url),
         grid_visible = COALESCE($2, grid_visible),
         grid_size = COALESCE($3, grid_size)
       WHERE campaign_id = $4`,
      [background_url, grid_visible, grid_size, req.params.campaignId]
    );

    const board = await getFullBoard(req.params.campaignId);
    broadcastBoard(req.params.campaignId, board, buildBoardForRole);
    res.json(board);
  } catch (error) {
    console.error('Error PATCH board:', error.message);
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
 * POST /campaigns/:campaignId/board/tokens — GM only
 */
router.post('/campaigns/:campaignId/board/tokens', requireGm, async (req, res) => {
  try {
    const campaign = await findAccessibleCampaign(req.params.campaignId, req.user);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    const board = await getOrCreateBoard(req.params.campaignId);
    const { label, character_id, image_url, color, x, y, visible_to_players } = req.body;

    if (!label) return res.status(400).json({ error: 'Nom du pion requis' });

    await pool.query(
      `INSERT INTO board_tokens (board_state_id, character_id, label, image_url, color, x, y, visible_to_players)
       VALUES ($1, $2, $3, $4, COALESCE($5, '#c65d3b'), COALESCE($6, 50), COALESCE($7, 50), COALESCE($8, true))`,
      [board.id, character_id || null, label, image_url || null, color, x, y, visible_to_players]
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

    const { label, image_url, color, x, y, visible_to_players } = req.body;
    await pool.query(
      `UPDATE board_tokens SET
         label = COALESCE($1, label),
         image_url = COALESCE($2, image_url),
         color = COALESCE($3, color),
         x = COALESCE($4, x),
         y = COALESCE($5, y),
         visible_to_players = COALESCE($6, visible_to_players)
       WHERE id = $7`,
      [label, image_url, color, x, y, visible_to_players, req.params.tokenId]
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

    const { label, color, x, y, size, width, rotation, visible_to_players } = req.body;
    await pool.query(
      `UPDATE board_zones SET
         label = COALESCE($1, label),
         color = COALESCE($2, color),
         x = COALESCE($3, x),
         y = COALESCE($4, y),
         size = COALESCE($5, size),
         width = COALESCE($6, width),
         rotation = COALESCE($7, rotation),
         visible_to_players = COALESCE($8, visible_to_players)
       WHERE id = $9`,
      [label, color, x, y, size, width, rotation, visible_to_players, req.params.zoneId]
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
