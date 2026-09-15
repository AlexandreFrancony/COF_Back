// Shared SQL fragment for enriching a pion row (board_tokens or scenario_tokens — the caller
// must alias its base table as `t`) with its owner-derived and bestiary-derived stats. Used
// identically by board.js's getFullBoard and scenarios.js's attachTokens: a golem/monster pawn
// carries no stats of its own, it looks them up live (never a snapshot) from whichever of
// owner_character_id/monstre_id it was spawned from, so a later fix to either data source
// reaches every pawn already on a board or in a scenario without touching them individually.
export const TOKEN_ENRICHMENT_COLUMNS = `
              owner.name AS owner_character_name,
              ogv.rang AS owner_golem_rang,
              (owner.valeurs_attaque->>'magique')::int AS owner_attaque_magique,
              m.name AS monstre_name, m.category AS monstre_category, m.nc AS monstre_nc,
              m.caracteristiques AS monstre_caracteristiques, m.defense AS monstre_defense,
              m.initiative AS monstre_initiative, m.attaques AS monstre_attaques,
              m.capacites AS monstre_capacites`;

export const TOKEN_ENRICHMENT_JOINS = `
       LEFT JOIN characters owner ON owner.id = t.owner_character_id
       LEFT JOIN LATERAL (
         SELECT cv.rang FROM character_voies cv
         JOIN rules_voies v ON v.id = cv.voie_id
         WHERE cv.character_id = owner.id AND v.name = 'Voie du golem'
         LIMIT 1
       ) ogv ON true
       LEFT JOIN rules_monstres m ON m.id = t.monstre_id`;
