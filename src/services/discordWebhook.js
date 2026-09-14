import pool from '../db/pool.js';

// Fire-and-forget campaign notifications — a missing/broken webhook (or Discord being down)
// must never break the game action it's reacting to, so callers don't await error handling
// here beyond the console warning. GM sets discord_webhook_url per campaign; a null one is
// the common case (feature opted out of) and silently no-ops.
export async function notifyCampaign(campaignId, content) {
  try {
    const result = await pool.query('SELECT discord_webhook_url FROM campaigns WHERE id = $1', [campaignId]);
    const url = result.rows[0]?.discord_webhook_url;
    if (!url) return;

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (error) {
    console.error('Error sending Discord webhook notification:', error.message);
  }
}
