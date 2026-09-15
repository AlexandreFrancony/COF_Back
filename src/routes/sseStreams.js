// Every route here authenticates via ?token= instead of an Authorization header, since
// EventSource can't set custom headers — so none of them can sit behind ANY blanket
// authenticateToken middleware, including their own. Board and notes used to each carry
// their own SSE route behind a "bypass this one path, authenticateToken everything else"
// guard inside their own router — which worked in isolation, but broke the *other* one the
// moment both existed: whichever router was mounted first only knew to exempt its own path,
// so it authenticateToken'd (and 401'd) the other router's query-token request before that
// router's own bypass ever got a chance to run. Pulling every such route out into this one
// dedicated, blanket-free router — mounted before anything else in index.js — sidesteps the
// whole class of bug instead of re-solving it per SSE endpoint.
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { writeSseEvent } from '../services/sseHub.js';
import { getFullBoard, buildBoardForRole, resolveRole } from './board.js';
import { subscribe as subscribeBoard } from '../services/boardStream.js';
import { resolveAccess as resolveNotesAccess } from './notes.js';
import pool from '../db/pool.js';
import { subscribe as subscribeNotes } from '../services/notesStream.js';
import { getCharacterWithVoies, canAccessCharacter } from './characters.js';
import { subscribe as subscribeCharacter } from '../services/characterStream.js';

const router = Router();

function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

// Shared boilerplate across every SSE route below: open the stream, send a comment so the
// client knows the connection is live, and keep it alive with a periodic ping (proxies/browsers
// tend to silently drop an idle HTTP connection well before either side means to close it).
// What differs per route — the access check and the initial payload — stays in the route itself.
function startSseResponse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':ok\n\n');

  const heartbeat = setInterval(() => res.write(':ping\n\n'), 25000);
  req.on('close', () => clearInterval(heartbeat));
}

/**
 * GET /board-stream/:campaignId — SSE, token passed as ?token=
 */
router.get('/board-stream/:campaignId', async (req, res) => {
  try {
    const user = req.query.token && verifyToken(req.query.token);
    if (!user) return res.status(401).end();

    const role = await resolveRole(req.params.campaignId, user);
    if (!role) return res.status(404).end();

    startSseResponse(req, res);
    const board = await getFullBoard(req.params.campaignId);
    writeSseEvent(res, 'board', buildBoardForRole(board, role));

    subscribeBoard(req.params.campaignId, role, res);
  } catch (error) {
    console.error('Error SSE board stream:', error.message);
    res.status(500).end();
  }
});

/**
 * GET /notes-stream/:campaignId — SSE, token passed as ?token=
 */
router.get('/notes-stream/:campaignId', async (req, res) => {
  try {
    const user = req.query.token && verifyToken(req.query.token);
    if (!user) return res.status(401).end();

    if (!(await resolveNotesAccess(req.params.campaignId, user))) return res.status(404).end();

    startSseResponse(req, res);
    const result = await pool.query(
      'SELECT content, updated_at, updated_by FROM campaign_notes WHERE campaign_id = $1',
      [req.params.campaignId]
    );
    const notes = result.rows[0] || { content: '', updated_at: null, updated_by: null };
    writeSseEvent(res, 'notes', notes);

    subscribeNotes(req.params.campaignId, res);
  } catch (error) {
    console.error('Error SSE notes stream:', error.message);
    res.status(500).end();
  }
});

/**
 * GET /character-stream/:characterId — SSE, token passed as ?token=. Only the owner or the
 * campaign's GM can subscribe (same check as GET /characters/:id) — a character sheet has at
 * most two possible viewers, never a whole campaign's worth like the board.
 */
router.get('/character-stream/:characterId', async (req, res) => {
  try {
    const user = req.query.token && verifyToken(req.query.token);
    if (!user) return res.status(401).end();

    const character = await getCharacterWithVoies(req.params.characterId);
    if (!character) return res.status(404).end();
    if (!(await canAccessCharacter(character, user))) return res.status(403).end();

    startSseResponse(req, res);
    writeSseEvent(res, 'character', character);

    subscribeCharacter(req.params.characterId, res);
  } catch (error) {
    console.error('Error SSE character stream:', error.message);
    res.status(500).end();
  }
});

export default router;
