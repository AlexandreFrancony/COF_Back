// SSE pub/sub for live board sync — avoids pulling in a websocket dependency
// since updates only ever flow GM (via REST) -> server -> all viewers.

const subscribers = new Map(); // String(campaignId) -> Set<{ res, role }>

// Keys are always coerced to String: the SSE route subscribes with req.params.campaignId
// (a route param, always a string), but token/zone routes (addressed by tokenId/zoneId, not
// campaignId) look up their campaign_id via a SQL join and broadcast with that — a plain
// Postgres integer, i.e. a JS number. Map keys compare by strict equality, so "42" !== 42
// silently dropped every token/zone move's broadcast (grid/camera/background PATCHes, which
// already had campaignId as a route param, were never affected). Normalize here instead of
// trusting every call site to pass the right type.
export function subscribe(campaignId, role, res) {
  const key = String(campaignId);
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  const entry = { res, role };
  subscribers.get(key).add(entry);

  res.on('close', () => {
    subscribers.get(key)?.delete(entry);
  });

  return entry;
}

export function hasSubscribers(campaignId) {
  return (subscribers.get(String(campaignId))?.size ?? 0) > 0;
}

function write(res, board) {
  res.write(`event: board\ndata: ${JSON.stringify(board)}\n\n`);
}

// buildBoardForRole(board, role) -> role-filtered payload
export function broadcastBoard(campaignId, board, buildBoardForRole) {
  const entries = subscribers.get(String(campaignId));
  if (!entries) return;

  for (const { res, role } of entries) {
    write(res, buildBoardForRole(board, role));
  }
}
