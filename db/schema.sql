-- COF - Site MJ - Database schema
-- Applied on first init via Infra/database/NN-create-cof-database.sh

-- ============================================================================
-- USERS & CAMPAIGNS
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'player' CHECK (role IN ('gm', 'player')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaigns (
    id SERIAL PRIMARY KEY,
    gm_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaign_scenarios (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- RULES REFERENCE (COF2 ruleset — filled in incrementally, see project docs)
-- ============================================================================

CREATE TABLE IF NOT EXISTS rules_familles (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    pv_base INTEGER,
    dr_die VARCHAR(10),
    dr_bonus INTEGER NOT NULL DEFAULT 0,
    pc_bonus INTEGER NOT NULL DEFAULT 0,
    caracteristique_commune VARCHAR(10)
);

CREATE TABLE IF NOT EXISTS rules_profils (
    id SERIAL PRIMARY KEY,
    famille_id INTEGER NOT NULL REFERENCES rules_familles(id),
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    caracteristiques_prioritaires TEXT[] NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS rules_peuples (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    ajustements JSONB NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS rules_voies (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('profil', 'peuple', 'prestige', 'custom', 'mage')),
    profil_id INTEGER REFERENCES rules_profils(id),
    peuple_id INTEGER REFERENCES rules_peuples(id),
    niveau_prestige_requis INTEGER,
    origine_pj VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS rules_capacites (
    id SERIAL PRIMARY KEY,
    voie_id INTEGER NOT NULL REFERENCES rules_voies(id) ON DELETE CASCADE,
    rang INTEGER NOT NULL,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    action_type VARCHAR(20) CHECK (action_type IN ('limitee', 'action', 'passive')),
    est_sort BOOLEAN NOT NULL DEFAULT false,
    description TEXT NOT NULL,
    -- Short keyword-style summary shown everywhere a capacité is listed (character sheet,
    -- level-up panel), so reading a build doesn't mean reading the full rulebook paragraph
    -- every time. The full description stays the source of truth, always one click away via
    -- the "glossaire des voies" page (a separate reference tab, not tied to any character).
    resume VARCHAR(200),
    effect JSONB
);

CREATE TABLE IF NOT EXISTS rules_sorts (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    niveau INTEGER NOT NULL,
    pm_cost INTEGER NOT NULL,
    description TEXT NOT NULL
);

-- Armures + boucliers (p.188) — a character can equip one of each (they stack). Only
-- defense_bonus is actually applied by computeDefenseBase; agi_max and prix are reference
-- info shown in the UI, not enforced — the AGI cap/encumbrance malus mechanic (p.188) and the
-- PM spellcasting surcharge for an unauthorized armor (p.177-178) stay out of scope, same call
-- as profils hybrides: left to the GM's own judgment at the table. Seeded from the rulebook's
-- own table (not hardcoded guesses); the GM can still add homebrew entries via the same list.
CREATE TABLE IF NOT EXISTS rules_armures (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(10) NOT NULL DEFAULT 'armure' CHECK (type IN ('armure', 'bouclier')),
    defense_bonus INTEGER NOT NULL DEFAULT 0,
    agi_max INTEGER, -- informational only, e.g. 3 for "AGI max +3"
    prix VARCHAR(20), -- informational only, e.g. "25 pa"
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Armes de contact et à distance (p.182-184). Unlike armor, nothing here feeds a stored/
-- computed stat — damage is rolled live at the table, not persisted — so every column is
-- reference info surfaced on the sheet (dice, DM type, portée, price, notes like "arme à deux
-- mains" or "critique sur 19-20"); for_applies is the one bit actually used by the frontend
-- display (it adds FOR to the shown damage for a contact weapon, per p.183 — false for the
-- rare book exception, e.g. Stylet). Two-handed restrictions, encumbrance etc. stay
-- unenforced, same deliberate scope cut as rules_armures.
CREATE TABLE IF NOT EXISTS rules_armes (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(10) NOT NULL DEFAULT 'contact' CHECK (category IN ('contact', 'distance')),
    damage_dice VARCHAR(20) NOT NULL,
    type_degats VARCHAR(20), -- Contondants / Perforants / Tranchants, informational
    portee INTEGER, -- meters, informational, distance weapons only
    prix VARCHAR(20),
    for_applies BOOLEAN NOT NULL DEFAULT true,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- CHARACTERS
-- ============================================================================

CREATE TABLE IF NOT EXISTS characters (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(100) NOT NULL,
    is_npc BOOLEAN NOT NULL DEFAULT false, -- GM-controlled, never claimed via an invite
    -- Avatar shown wherever the character appears as a pawn (board token, HUD card): a real
    -- photo takes priority when set, an emoji is the lightweight fallback, plain color/initial
    -- if neither is set. Editable by the owning player or the GM, same as equipement/notes.
    avatar_url TEXT,
    avatar_emoji VARCHAR(8),
    profil_id INTEGER REFERENCES rules_profils(id),
    peuple_id INTEGER REFERENCES rules_peuples(id),
    level INTEGER NOT NULL DEFAULT 1,
    caracteristiques JSONB NOT NULL DEFAULT '{}',
    pv_current INTEGER NOT NULL DEFAULT 0,
    pv_max INTEGER NOT NULL DEFAULT 0,
    pm_current INTEGER NOT NULL DEFAULT 0,
    pm_max INTEGER NOT NULL DEFAULT 0,
    points_chance INTEGER NOT NULL DEFAULT 0, -- max, from the formula (p.29)
    points_chance_current INTEGER NOT NULL DEFAULT 0, -- spent/regained during play, like pv_current/pm_current
    dr_max INTEGER NOT NULL DEFAULT 0, -- count of recovery dice, from the formula (p.22)
    dr_current INTEGER NOT NULL DEFAULT 0, -- spent/regained during play, like pv_current/pm_current
    dr_die VARCHAR(10), -- die size (e.g. 'd10'), fixed per the principal profil's famille
    defense INTEGER NOT NULL DEFAULT 0,
    initiative INTEGER NOT NULL DEFAULT 0,
    capacity_points_available INTEGER NOT NULL DEFAULT 0,
    valeurs_attaque JSONB NOT NULL DEFAULT '{}',
    equipement JSONB NOT NULL DEFAULT '[]',
    -- Currency kept separate from the free-text equipement list, one column per denomination
    -- (p.23) — no conversion between them is modeled, the table tracks each pile as-is.
    pieces_cuivre INTEGER NOT NULL DEFAULT 0,
    pieces_argent INTEGER NOT NULL DEFAULT 0,
    pieces_or INTEGER NOT NULL DEFAULT 0,
    pieces_platine INTEGER NOT NULL DEFAULT 0,
    armure_id INTEGER REFERENCES rules_armures(id) ON DELETE SET NULL, -- flat DEF bonus, see rules_armures
    bouclier_id INTEGER REFERENCES rules_armures(id) ON DELETE SET NULL, -- stacks with armure_id (p.188)
    arme_principale_id INTEGER REFERENCES rules_armes(id) ON DELETE SET NULL,
    arme_secondaire_id INTEGER REFERENCES rules_armes(id) ON DELETE SET NULL, -- e.g. dual-wielding
    notes TEXT,
    -- The human peuple's rang-1 "Diversité" capacité (p.46) requires picking a geographic/social
    -- origin (or a custom gagne-pain) — free text since the +3 bonus it grants is to narrative
    -- skill domains the app doesn't model; only the flat +1 PC it also grants is computed
    -- (characterCalculations.js, gated on actually owning that capacité).
    origine_humaine TEXT,
    -- PV ledger (replaces the old single-family closed formula so a profil hybride can mix
    -- families across levels, p.176-177): pv_max = pv_body_total + CON*level.
    pv_body_total INTEGER NOT NULL DEFAULT 0,
    pv_pending_half BOOLEAN NOT NULL DEFAULT false, -- alternating floor/ceil carry for half-PV levels
    level_up_families TEXT[] NOT NULL DEFAULT '{}', -- famille codes touched since the last level-up, reset once spent
    -- Orphan capacity point bonuses (p.39) — additive on top of the derived stat, since a raw
    -- override on pv_max/pm_max/etc. gets silently clobbered by the next recompute otherwise.
    pc_bonus_orphan INTEGER NOT NULL DEFAULT 0,
    dr_bonus_orphan INTEGER NOT NULL DEFAULT 0,
    pm_bonus_orphan INTEGER NOT NULL DEFAULT 0,
    -- Changement d'orientation (p.42-43): +1 per level-up (+2 if INT>=+2), consumed by
    -- forgetting a capacité to refund its point cost and spend it elsewhere.
    forgets_available INTEGER NOT NULL DEFAULT 0,
    -- Escape hatch for one-off homebrew mechanics too narrow to deserve their own columns
    -- (e.g. Augustin Moëdec's dual-facette schizophrenia — see CharacterSheet.jsx's
    -- FACETTE_VOIE_GROUPS/threshold_percent handling, hardcoded to this one character's voies,
    -- not a general system). Empty object for every other character.
    custom_data JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS character_voies (
    id SERIAL PRIMARY KEY,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    voie_id INTEGER NOT NULL REFERENCES rules_voies(id),
    rang INTEGER NOT NULL DEFAULT 1,
    rang_cap INTEGER, -- e.g. a peuple voie frozen at rang 1 after being replaced by the voie du mage
    obtained_at_level INTEGER NOT NULL,
    -- Some capacités let a character fetch ONE specific capacité from elsewhere (e.g. the Gnome
    -- peuple's rang-1 "Don étrange" lets you pick a rang-1 ensorceleur capacité) — rather than
    -- show the whole donor voie as its own top-level entry, add it as a normal character_voies
    -- row but restricted to only_capacite_id (hides every other capacité <= rang from that voie)
    -- and flagged nested_under_capacite_id so the sheet renders it indented under the capacité
    -- that granted it instead of as a separate accordion item.
    only_capacite_id INTEGER REFERENCES rules_capacites(id) ON DELETE SET NULL,
    nested_under_capacite_id INTEGER REFERENCES rules_capacites(id) ON DELETE SET NULL,
    UNIQUE (character_id, voie_id)
);

CREATE TABLE IF NOT EXISTS campaign_invites (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    token VARCHAR(64) UNIQUE NOT NULL,
    email VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    accepted_at TIMESTAMP
);

-- ============================================================================
-- LIVE BOARD (phase 2) — one active board per campaign, GM-controlled tokens
-- ============================================================================

CREATE TABLE IF NOT EXISTS board_states (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER UNIQUE NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    background_url TEXT,
    background_type VARCHAR(10) NOT NULL DEFAULT 'image' CHECK (background_type IN ('image', 'video')),
    grid_visible BOOLEAN NOT NULL DEFAULT false,
    grid_size INTEGER NOT NULL DEFAULT 20, -- number of grid columns across the board width
    -- Camera: the window of the full scene actually shown on the projector, independent from
    -- what the GM sees (always the full scene). x/y is the window's center (% of the scene);
    -- width is its width as % of the scene width. Since the scene and the projector output
    -- share the same 16:9 ratio, a window of width w% is exactly w% tall too (no correction
    -- needed, unlike board_zones' shapes) — see BoardCanvas.jsx's crop transform.
    camera_x REAL NOT NULL DEFAULT 50,
    camera_y REAL NOT NULL DEFAULT 50,
    camera_width REAL NOT NULL DEFAULT 100,
    token_size INTEGER NOT NULL DEFAULT 40, -- token/pawn circle diameter in px, GM-adjustable
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Reusable library of uploaded backgrounds (images and ambiance videos) a GM can pick from
-- across campaigns/scenarios instead of re-uploading the same file every time.
CREATE TABLE IF NOT EXISTS board_media (
    id SERIAL PRIMARY KEY,
    type VARCHAR(10) NOT NULL CHECK (type IN ('image', 'video')),
    url TEXT NOT NULL,
    label VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS board_tokens (
    id SERIAL PRIMARY KEY,
    board_state_id INTEGER NOT NULL REFERENCES board_states(id) ON DELETE CASCADE,
    character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
    label VARCHAR(100) NOT NULL,
    image_url TEXT,
    color VARCHAR(20) NOT NULL DEFAULT '#c65d3b',
    x REAL NOT NULL DEFAULT 50,
    y REAL NOT NULL DEFAULT 50,
    visible_to_players BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- A scenario can prepare a background ahead of time (picked from the shared board_media
-- library) — "launching" the scenario later copies it onto the campaign's live board_states.
ALTER TABLE campaign_scenarios ADD COLUMN IF NOT EXISTS background_media_id INTEGER REFERENCES board_media(id) ON DELETE SET NULL;
-- Same prep-ahead-of-time reasoning extended to grid/token size: a scenario is a full mini
-- board_states, not just a background — "launching" copies these onto the live board too.
-- Deliberately nullable with NO default (unlike board_states' own NOT NULL DEFAULT columns):
-- NULL means "never customized for this scenario", so launching an otherwise-untouched scenario
-- doesn't silently reset the live board's grid to hidden / token size to 40. Only a value the
-- GM actually set here (grid toggled, or the token-size +/- touched at least once) travels.
ALTER TABLE campaign_scenarios ADD COLUMN IF NOT EXISTS grid_visible BOOLEAN;
ALTER TABLE campaign_scenarios ADD COLUMN IF NOT EXISTS grid_size INTEGER;
ALTER TABLE campaign_scenarios ADD COLUMN IF NOT EXISTS token_size INTEGER;

-- Prepared tokens for a scenario — same shape as board_tokens, but scoped to a scenario
-- instead of a live board_state, so the GM can lay out an encounter ahead of time without
-- touching the current game. "Launching" the scenario copies these onto board_tokens.
CREATE TABLE IF NOT EXISTS scenario_tokens (
    id SERIAL PRIMARY KEY,
    scenario_id INTEGER NOT NULL REFERENCES campaign_scenarios(id) ON DELETE CASCADE,
    character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
    label VARCHAR(100) NOT NULL,
    image_url TEXT,
    color VARCHAR(20) NOT NULL DEFAULT '#c65d3b',
    x REAL NOT NULL DEFAULT 50,
    y REAL NOT NULL DEFAULT 50,
    visible_to_players BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Area-of-effect markers (explosion, cone, line...) drawn over the board, same visibility
-- model as tokens. x/y is the anchor point (center for circle, origin for rectangle/cone);
-- size/width are percentages of the board width; rotation in degrees orients rectangle/cone.
CREATE TABLE IF NOT EXISTS board_zones (
    id SERIAL PRIMARY KEY,
    board_state_id INTEGER NOT NULL REFERENCES board_states(id) ON DELETE CASCADE,
    shape VARCHAR(20) NOT NULL CHECK (shape IN ('circle', 'rectangle', 'cone')),
    label VARCHAR(100),
    color VARCHAR(20) NOT NULL DEFAULT '#c65d3b',
    x REAL NOT NULL DEFAULT 50,
    y REAL NOT NULL DEFAULT 50,
    size REAL NOT NULL DEFAULT 10,
    width REAL NOT NULL DEFAULT 10,
    rotation REAL NOT NULL DEFAULT 0,
    visible_to_players BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Same shape as board_zones, scoped to a scenario instead of a live board_state — see
-- scenario_tokens above for the same prep-ahead-of-time reasoning. Launching copies these onto
-- board_zones.
CREATE TABLE IF NOT EXISTS scenario_zones (
    id SERIAL PRIMARY KEY,
    scenario_id INTEGER NOT NULL REFERENCES campaign_scenarios(id) ON DELETE CASCADE,
    shape VARCHAR(20) NOT NULL CHECK (shape IN ('circle', 'rectangle', 'cone')),
    label VARCHAR(100),
    color VARCHAR(20) NOT NULL DEFAULT '#c65d3b',
    x REAL NOT NULL DEFAULT 50,
    y REAL NOT NULL DEFAULT 50,
    size REAL NOT NULL DEFAULT 10,
    width REAL NOT NULL DEFAULT 10,
    rotation REAL NOT NULL DEFAULT 0,
    visible_to_players BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- SESSION HISTORY (phase 3) — auto-logged character events + free-form GM notes
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_events (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
    type VARCHAR(30) NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_characters_updated_at ON characters;
CREATE TRIGGER trigger_characters_updated_at
    BEFORE UPDATE ON characters
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trigger_board_states_updated_at ON board_states;
CREATE TRIGGER trigger_board_states_updated_at
    BEFORE UPDATE ON board_states
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
