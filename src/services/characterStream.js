// SSE pub/sub for live character-sheet sync — same rationale as boardStream.js/notesStream.js
// (updates only ever flow one editor -> server -> everyone else, no need for a websocket
// dependency). Keyed by character_id rather than campaign_id: a character sheet is viewed by
// at most its owner and the GM, never a whole campaign's worth of subscribers.
import { createHub, writeSseEvent } from './sseHub.js';

const hub = createHub();

export function subscribe(characterId, res) {
  return hub.subscribe(characterId, { res });
}

export function hasSubscribers(characterId) {
  return hub.hasSubscribers(characterId);
}

export function broadcastCharacter(characterId, character) {
  for (const { res } of hub.getSubscribers(characterId)) {
    writeSseEvent(res, 'character', character);
  }
}
