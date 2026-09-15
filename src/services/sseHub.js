// Generic SSE pub/sub, shared by every *Stream.js service (board, notes, character) so the
// subscriber bookkeeping — a Map<channel, Set<entry>>, String-coercion, cleanup on close —
// exists in exactly one place instead of being copy-pasted per channel. Each *Stream.js module
// still owns its own broadcast* function: what an "entry" carries (just a res, or a res+role
// for the board's per-viewer filtering) and what shape gets written to the wire differ enough
// per channel that forcing them through one generic broadcast signature would cost more
// readability than the dozen shared lines are worth.
//
// Channel ids are always coerced to String: a route param is already a string, but a value
// resolved via a SQL join (e.g. a token/zone mutation looking up which board/campaign it
// belongs to) comes back as a JS number — Map keys compare by strict equality, so "42" !== 42
// would silently drop that broadcast if left uncoerced (bit us once for board_tokens/zones).
export function createHub() {
  const subscribers = new Map(); // String(channelId) -> Set<entry>

  function subscribe(channelId, entry) {
    const key = String(channelId);
    if (!subscribers.has(key)) subscribers.set(key, new Set());
    subscribers.get(key).add(entry);

    entry.res.on('close', () => {
      subscribers.get(key)?.delete(entry);
    });

    return entry;
  }

  function hasSubscribers(channelId) {
    return (subscribers.get(String(channelId))?.size ?? 0) > 0;
  }

  function getSubscribers(channelId) {
    return subscribers.get(String(channelId)) ?? new Set();
  }

  return { subscribe, hasSubscribers, getSubscribers };
}

// The one line every channel's broadcast ends up doing per subscriber — pulled out purely to
// avoid re-typing the SSE wire format (`event: X\ndata: ...\n\n`) at each call site.
export function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
