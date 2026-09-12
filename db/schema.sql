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
    type VARCHAR(20) NOT NULL CHECK (type IN ('profil', 'peuple', 'prestige', 'custom')),
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS character_voies (
    id SERIAL PRIMARY KEY,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    voie_id INTEGER NOT NULL REFERENCES rules_voies(id),
    rang INTEGER NOT NULL DEFAULT 1,
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
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
