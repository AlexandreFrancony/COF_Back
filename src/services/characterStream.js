// SSE pub/sub for live character-sheet sync — same rationale as boardStream.js/notesStream.js
// (updates only ever flow one editor -> server -> everyone else, no need for a websocket
// dependency). Keyed by character_id rather than campaign_id: a character sheet is viewed by
// at most its owner and the GM, never a whole campaign's worth of subscribers.

const subscribers = new Map(); // String(characterId) -> Set<res>

export function subscribe(characterId, res) {
  const key = String(characterId);
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key).add(res);

  res.on('close', () => {
    subscribers.get(key)?.delete(res);
  });
}

export function hasSubscribers(characterId) {
  return (subscribers.get(String(characterId))?.size ?? 0) > 0;
}

export function broadcastCharacter(characterId, character) {
  const entries = subscribers.get(String(characterId));
  if (!entries) return;

  for (const res of entries) {
    res.write(`event: character\ndata: ${JSON.stringify(character)}\n\n`);
  }
}
