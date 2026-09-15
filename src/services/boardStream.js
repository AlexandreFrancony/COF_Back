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
