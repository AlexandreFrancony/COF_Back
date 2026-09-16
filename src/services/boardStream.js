// SSE pub/sub for live board sync — avoids pulling in a websocket dependency
// since updates only ever flow GM (via REST) -> server -> all viewers.
import { createHub, writeSseEvent } from './sseHub.js';

const hub = createHub();

export function subscribe(campaignId, role, res) {
  return hub.subscribe(campaignId, { res, role });
}

export function hasSubscribers(campaignId) {
  return hub.hasSubscribers(campaignId);
}

// buildBoardForRole(board, role) -> role-filtered payload, applied per subscriber since a
// player and the GM never see the same content for the same board.
export function broadcastBoard(campaignId, board, buildBoardForRole) {
  for (const { res, role } of hub.getSubscribers(campaignId)) {
    writeSseEvent(res, 'board', buildBoardForRole(board, role));
  }
}

// A transient pointer ("look here") — never persisted, same (x, y) reaches every viewer
// (GM included, via their own board-stream connection) as a one-off 'ping' event on the same
// SSE connection as 'board'. No role-filtering: where the GM points is never sensitive.
export function broadcastPing(campaignId, x, y) {
  for (const { res } of hub.getSubscribers(campaignId)) {
    writeSseEvent(res, 'ping', { x, y });
  }
}
