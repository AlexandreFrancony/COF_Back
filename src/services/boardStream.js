// SSE pub/sub for live board sync — avoids pulling in a websocket dependency
// since updates only ever flow GM (via REST) -> server -> all viewers.

const subscribers = new Map(); // campaignId -> Set<{ res, role }>

export function subscribe(campaignId, role, res) {
  if (!subscribers.has(campaignId)) subscribers.set(campaignId, new Set());
  const entry = { res, role };
  subscribers.get(campaignId).add(entry);

  res.on('close', () => {
    subscribers.get(campaignId)?.delete(entry);
  });

  return entry;
}

export function hasSubscribers(campaignId) {
  return (subscribers.get(campaignId)?.size ?? 0) > 0;
}

function write(res, board) {
  res.write(`event: board\ndata: ${JSON.stringify(board)}\n\n`);
}

// buildBoardForRole(board, role) -> role-filtered payload
export function broadcastBoard(campaignId, board, buildBoardForRole) {
  const entries = subscribers.get(campaignId);
  if (!entries) return;

  for (const { res, role } of entries) {
    write(res, buildBoardForRole(board, role));
  }
}
