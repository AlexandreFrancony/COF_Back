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

-- ============================================================================
-- CHARACTERS
-- ============================================================================

CREATE TABLE IF NOT EXISTS characters (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(100) NOT NULL,
    is_npc BOOLEAN NOT NULL DEFAULT false, -- GM-controlled, never claimed via an invite
    profil_id INTEGER REFERENCES rules_profils(id),
    peuple_id INTEGER REFERENCES rules_peuples(id),
    level INTEGER NOT NULL DEFAULT 1,
    caracteristiques JSONB NOT NULL DEFAULT '{}',
    pv_current INTEGER NOT NULL DEFAULT 0,
    pv_max INTEGER NOT NULL DEFAULT 0,
    pm_current INTEGER NOT NULL DEFAULT 0,
    pm_max INTEGER NOT NULL DEFAULT 0,
    points_chance INTEGER NOT NULL DEFAULT 0,
    de_recuperation VARCHAR(10),
    defense INTEGER NOT NULL DEFAULT 0,
    initiative INTEGER NOT NULL DEFAULT 0,
    capacity_points_available INTEGER NOT NULL DEFAULT 0,
    valeurs_attaque JSONB NOT NULL DEFAULT '{}',
    equipement JSONB NOT NULL DEFAULT '[]',
    notes TEXT,
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
