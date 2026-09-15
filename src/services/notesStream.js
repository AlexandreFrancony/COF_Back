// SSE pub/sub for live shared-notes sync — same rationale as boardStream.js (updates only
// ever flow one editor -> server -> everyone else, no need for a websocket dependency).
// Unlike the board, notes have no role-based filtering: every viewer gets the same content.
import { createHub, writeSseEvent } from './sseHub.js';

const hub = createHub();

export function subscribe(campaignId, res) {
  return hub.subscribe(campaignId, { res });
}

export function broadcastNotes(campaignId, notes) {
  for (const { res } of hub.getSubscribers(campaignId)) {
    writeSseEvent(res, 'notes', notes);
  }
}
