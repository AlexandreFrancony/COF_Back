import pool from '../db/pool.js';

// Fire-and-forget history logging — a failed log write should never break the action it
// describes, so callers don't await error handling here beyond the console warning.
export async function logEvent(campaignId, characterId, type, message) {
  try {
    await pool.query(
      'INSERT INTO session_events (campaign_id, character_id, type, message) VALUES ($1, $2, $3, $4)',
      [campaignId, characterId, type, message]
    );
  } catch (error) {
    console.error('Error logging session event:', error.message);
  }
}
