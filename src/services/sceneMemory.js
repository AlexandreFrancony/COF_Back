// Scene memory for the live board. A scene is a prepared scenario; the board remembers which one
// it shows (board_states.active_scenario_id) and, when the GM moves to another, keeps a snapshot
// of the one being left in board_scene_memories. Coming back restores that snapshot.
//
// The party (PJ pawns and the creatures they own: familiar, golem...) is never deleted when the
// scene changes: it follows the group. Only its positions are remembered per scene, keyed by
// character rather than by token id, so a pawn removed and re-added later still finds its spot.

// Every function takes `db`: a client inside a transaction, so a failed switch leaves nothing half done.

const IS_PARTY = `(t.owner_character_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM characters c WHERE c.id = t.character_id AND NOT c.is_npc))`;
const PARTY_KEY = `CASE WHEN t.owner_character_id IS NOT NULL
  THEN 'own:' || t.owner_character_id || ':' || t.label ELSE 'pc:' || t.character_id END`;

// Adding a column to board_tokens/board_zones? Add it here too, or a restored scene drops it.
const TOKEN_COLUMNS = 'character_id, label, image_url, color, x, y, visible_to_players, hp_current, hp_max, owner_character_id, monstre_id, hide_hp_from_players, player_hp_label, status_icons';
const ZONE_COLUMNS = 'shape, label, color, x, y, size, width, rotation, visible_to_players';

export async function rememberActiveScene(db, boardId) {
  await db.query(
    `INSERT INTO board_scene_memories (board_state_id, scenario_id, snapshot)
     SELECT b.id, b.active_scenario_id, jsonb_build_object(
       'background_url', b.background_url, 'background_type', b.background_type,
       'grid_visible', b.grid_visible, 'grid_size', b.grid_size, 'token_size', b.token_size,
       'labels_visible', b.labels_visible,
       'fog_enabled', b.fog_enabled, 'fog_revealed', b.fog_revealed, 'drawings', b.drawings,
       'tokens', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]') FROM board_tokens t
                  WHERE t.board_state_id = b.id AND NOT ${IS_PARTY}),
       'party', (SELECT COALESCE(jsonb_object_agg(${PARTY_KEY}, jsonb_build_object('x', t.x, 'y', t.y)), '{}')
                 FROM board_tokens t WHERE t.board_state_id = b.id AND ${IS_PARTY}),
       'zones', (SELECT COALESCE(jsonb_agg(to_jsonb(z) ORDER BY z.id), '[]') FROM board_zones z
                 WHERE z.board_state_id = b.id))
     FROM board_states b WHERE b.id = $1 AND b.active_scenario_id IS NOT NULL
     ON CONFLICT (board_state_id, scenario_id)
     DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = CURRENT_TIMESTAMP`,
    [boardId]
  );
}

// Empties the place, not the group: everything but the party goes, fog/drawings/document/initiative reset.
export async function clearScene(db, boardId, activeScenarioId) {
  await db.query(`DELETE FROM board_tokens t WHERE t.board_state_id = $1 AND NOT ${IS_PARTY}`, [boardId]);
  await db.query('DELETE FROM board_zones WHERE board_state_id = $1', [boardId]);
  await db.query(
    `UPDATE board_states SET
       fog_enabled = false, fog_revealed = '[]', drawings = '[]', handout_url = NULL,
       initiative_current_token_id = NULL, initiative_round = 1, active_scenario_id = $2
     WHERE id = $1`,
    [boardId, activeScenarioId]
  );
}

export async function getSceneMemory(db, boardId, scenarioId) {
  const result = await db.query(
    'SELECT snapshot FROM board_scene_memories WHERE board_state_id = $1 AND scenario_id = $2',
    [boardId, scenarioId]
  );
  return result.rows[0]?.snapshot || null;
}

export async function restoreScene(db, boardId, snapshot) {
  await db.query(
    `UPDATE board_states SET
       background_url = $2::jsonb->>'background_url', background_type = $2::jsonb->>'background_type',
       grid_visible = ($2::jsonb->>'grid_visible')::boolean, grid_size = ($2::jsonb->>'grid_size')::int,
       token_size = ($2::jsonb->>'token_size')::int, labels_visible = ($2::jsonb->>'labels_visible')::boolean,
       fog_enabled = ($2::jsonb->>'fog_enabled')::boolean, fog_revealed = $2::jsonb->'fog_revealed',
       drawings = $2::jsonb->'drawings'
     WHERE id = $1`,
    [boardId, JSON.stringify(snapshot)]
  );
  await db.query(
    `INSERT INTO board_tokens (board_state_id, ${TOKEN_COLUMNS})
     SELECT $1, ${TOKEN_COLUMNS} FROM jsonb_populate_recordset(NULL::board_tokens, $2::jsonb)`,
    [boardId, JSON.stringify(snapshot.tokens)]
  );
  await db.query(
    `INSERT INTO board_zones (board_state_id, ${ZONE_COLUMNS})
     SELECT $1, ${ZONE_COLUMNS} FROM jsonb_populate_recordset(NULL::board_zones, $2::jsonb)`,
    [boardId, JSON.stringify(snapshot.zones)]
  );
  await db.query(
    `UPDATE board_tokens t SET x = (p.value->>'x')::real, y = (p.value->>'y')::real
     FROM jsonb_each($2::jsonb) p
     WHERE t.board_state_id = $1 AND ${IS_PARTY} AND p.key = ${PARTY_KEY}`,
    [boardId, JSON.stringify(snapshot.party)]
  );
}
