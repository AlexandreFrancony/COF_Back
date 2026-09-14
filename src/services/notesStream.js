// SSE pub/sub for live shared-notes sync — same rationale as boardStream.js (updates only
// ever flow one editor -> server -> everyone else, no need for a websocket dependency).
// Unlike the board, notes have no role-based filtering: every viewer gets the same content.

const subscribers = new Map(); // String(campaignId) -> Set<res>

export function subscribe(campaignId, res) {
  const key = String(campaignId);
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key).add(res);

  res.on('close', () => {
    subscribers.get(key)?.delete(res);
  });
}

export function broadcastNotes(campaignId, notes) {
  const entries = subscribers.get(String(campaignId));
  if (!entries) return;

  for (const res of entries) {
    res.write(`event: notes\ndata: ${JSON.stringify(notes)}\n\n`);
  }
}
