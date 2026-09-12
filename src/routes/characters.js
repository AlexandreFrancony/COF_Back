import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken, requireGm } from '../middleware/auth.js';
import {
  computeDerivedStats, computePvBodyGain, seedPvBodyTotal, NIVEAU_REQUIS_PAR_RANG,
} from '../services/characterCalculations.js';
import { logEvent } from '../services/eventLog.js';

const router = Router();
router.use(authenticateToken);

async function canAccessCharacter(character, user) {
  if (character.user_id === user.id) return true;
  if (user.role !== 'gm') return false;
  const campaign = await pool.query('SELECT gm_id FROM campaigns WHERE id = $1', [character.campaign_id]);
  return campaign.rows[0]?.gm_id === user.id;
}

/**
 * Recomputes pv_max/pm_max/points_chance/de_recuperation/defense/initiative/valeurs_attaque
 * for a character and persists them, carrying forward the *gain* into pv_current/pm_current
 * (leveling up or learning a spell heals/refills by the amount gained, per the rulebook).
 */
async function recomputeAndPersist(characterId) {
  const charResult = await pool.query('SELECT * FROM characters WHERE id = $1', [characterId]);
  const character = charResult.rows[0];
  if (!character?.profil_id) return character;

  const profil = await pool.query(
    `SELECT p.*, f.pv_base, f.dr_die, f.dr_bonus, f.pc_bonus
     FROM rules_profils p JOIN rules_familles f ON f.id = p.famille_id
     WHERE p.id = $1`,
    [character.profil_id]
  );
  if (profil.rows.length === 0) return character;

  const sortsCount = await pool.query(
    `SELECT count(*) FROM character_voies cv
     JOIN rules_capacites c ON c.voie_id = cv.voie_id AND c.rang <= cv.rang
     WHERE cv.character_id = $1 AND c.est_sort = true`,
    [characterId]
  );

  const derived = computeDerivedStats(profil.rows[0], character, parseInt(sortsCount.rows[0].count, 10));

  const pvGain = Math.max(0, derived.pv_max - character.pv_max);
  const pmGain = Math.max(0, derived.pm_max - character.pm_max);

  const result = await pool.query(
    `UPDATE characters SET
       pv_max = $1, pm_max = $2, points_chance = $3, de_recuperation = $4,
       defense = $5, initiative = $6, valeurs_attaque = $7,
       pv_current = LEAST($1, pv_current + $8),
       pm_current = LEAST($2, pm_current + $9)
     WHERE id = $10
     RETURNING *`,
    [
      derived.pv_max, derived.pm_max, derived.points_chance, derived.de_recuperation,
      derived.defense, derived.initiative, JSON.stringify(derived.valeurs_attaque),
      pvGain, pmGain, characterId,
    ]
  );

  return result.rows[0];
}

// Records which famille a just-purchased voie belongs to, for this level-up cycle's PV
// averaging (p.176). Peuple/mage/custom/prestige-without-profil voies don't carry a famille
// and are silently excluded from the mix — only type='profil' voies with a profil_id count.
async function recordVoieFamilyForLeveling(characterId, voieId) {
  const voie = await pool.query(
    `SELECT f.code AS famille_code FROM rules_voies v
     LEFT JOIN rules_profils p ON p.id = v.profil_id
     LEFT JOIN rules_familles f ON f.id = p.famille_id
     WHERE v.id = $1`,
    [voieId]
  );
  const familleCode = voie.rows[0]?.famille_code;
  if (!familleCode) return;

  await pool.query(
    'UPDATE characters SET level_up_families = array_append(level_up_families, $1) WHERE id = $2',
    [familleCode, characterId]
  );
}

// Once every capacity point from a level-up has been spent, settles that level's PV gain
// from the distinct familles touched (p.176-177) into the pv_body_total ledger.
async function maybeFinalizeLevelPv(characterId) {
  const result = await pool.query(
    'SELECT profil_id, capacity_points_available, level_up_families, pv_pending_half, pv_body_total FROM characters WHERE id = $1',
    [characterId]
  );
  const character = result.rows[0];
  if (character.capacity_points_available > 0) return;

  let familleCodes = [...new Set(character.level_up_families)];
  if (familleCodes.length === 0) {
    // Nothing profil-tied was purchased this level (e.g. only a peuple/mage/custom voie rang) —
    // fall back to the principal profil's own family rather than silently losing this level's PV.
    const ownFamille = await pool.query(
      'SELECT f.code FROM rules_profils p JOIN rules_familles f ON f.id = p.famille_id WHERE p.id = $1',
      [character.profil_id]
    );
    familleCodes = ownFamille.rows.map((f) => f.code);
  }
  if (familleCodes.length === 0) return; // no profil at all — shouldn't happen post-creation

  const familles = await pool.query(
    'SELECT pv_base FROM rules_familles WHERE code = ANY($1)',
    [familleCodes]
  );
  const { gain, pendingHalf } = computePvBodyGain(familles.rows.map((f) => f.pv_base), character.pv_pending_half);

  await pool.query(
    `UPDATE characters SET
       pv_body_total = $1, pv_pending_half = $2, level_up_families = '{}'
     WHERE id = $3`,
    [character.pv_body_total + gain, pendingHalf, characterId]
  );
}

/**
 * GET /campaigns/:campaignId/characters
 */
router.get('/campaigns/:campaignId/characters', async (req, res) => {
  try {
    const campaign = await pool.query('SELECT gm_id FROM campaigns WHERE id = $1', [req.params.campaignId]);
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const isGm = req.user.role === 'gm' && campaign.rows[0].gm_id === req.user.id;
    const result = isGm
      ? await pool.query('SELECT * FROM characters WHERE campaign_id = $1 ORDER BY name', [req.params.campaignId])
      : await pool.query(
          'SELECT * FROM characters WHERE campaign_id = $1 AND user_id = $2 ORDER BY name',
          [req.params.campaignId, req.user.id]
        );

    res.json(result.rows);
  } catch (error) {
    console.error('Error GET /campaigns/:campaignId/characters:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /campaigns/:campaignId/characters
 * GM only. Creates a bare character with no invite attached — either a PJ built ahead of
 * time (an invite can be attached to it later via POST /campaigns/:id/invites with
 * character_id) or a permanent PNJ that only the GM ever controls.
 * Body: { name, is_npc }
 */
router.post('/campaigns/:campaignId/characters', requireGm, async (req, res) => {
  try {
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND gm_id = $2',
      [req.params.campaignId, req.user.id]
    );
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const { name, is_npc } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom du personnage requis' });

    const result = await pool.query(
      'INSERT INTO characters (campaign_id, name, is_npc) VALUES ($1, $2, $3) RETURNING *',
      [req.params.campaignId, name, !!is_npc]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error POST /campaigns/:campaignId/characters:', error.message);
    res.status(500).json({ error: 'Erreur lors de la création du personnage' });
  }
});

/**
 * GET /characters/:id
 */
router.get('/characters/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM characters WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Personnage non trouvé' });
    }

    const character = result.rows[0];
    if (!(await canAccessCharacter(character, req.user))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const voies = await pool.query(
      `SELECT cv.rang, cv.rang_cap, cv.obtained_at_level, v.id AS voie_id, v.code, v.name, v.type
       FROM character_voies cv JOIN rules_voies v ON v.id = cv.voie_id
       WHERE cv.character_id = $1`,
      [character.id]
    );

    const capacites = voies.rows.length > 0
      ? await pool.query(
          `SELECT c.* FROM rules_capacites c
           JOIN character_voies cv ON cv.voie_id = c.voie_id AND c.rang <= cv.rang
           WHERE cv.character_id = $1
           ORDER BY c.voie_id, c.rang`,
          [character.id]
        )
      : { rows: [] };

    const capacitesByVoie = {};
    for (const cap of capacites.rows) {
      (capacitesByVoie[cap.voie_id] ??= []).push(cap);
    }

    res.json({
      ...character,
      voies: voies.rows.map((v) => ({ ...v, capacites: capacitesByVoie[v.voie_id] || [] })),
    });
  } catch (error) {
    console.error('Error GET /characters/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * PATCH /characters/:id
 * Updates character fields and recomputes derived stats (pv_max, pm_max, defense, etc.)
 * whenever profil, peuple, caracteristiques or level change.
 * Body: any subset of { name, profil_id, peuple_id, level, caracteristiques, equipement, notes, pv_current, pm_current }
 */
router.patch('/characters/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM characters WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Personnage non trouvé' });
    }

    const character = existing.rows[0];
    if (!(await canAccessCharacter(character, req.user))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const {
      name, profil_id, peuple_id, level, caracteristiques,
      equipement, notes, pv_current, pm_current,
    } = req.body;

    // Character-creation finalize: profil_id goes from unset to set. Seed the PV ledger here
    // since pv_body_total otherwise never gets its level-1 baseline (2x the principal profil's
    // family pv_base, p.28) — a hybrid pick can only ever happen on a later level-up.
    const isInitialCreation = !character.profil_id && profil_id;

    await pool.query(
      `UPDATE characters SET
         name = COALESCE($1, name),
         profil_id = COALESCE($2, profil_id),
         peuple_id = COALESCE($3, peuple_id),
         level = COALESCE($4, level),
         caracteristiques = COALESCE($5, caracteristiques),
         equipement = COALESCE($6, equipement),
         notes = COALESCE($7, notes),
         pv_current = COALESCE($8, pv_current),
         pm_current = COALESCE($9, pm_current)
       WHERE id = $10`,
      [
        name, profil_id, peuple_id, level,
        caracteristiques ? JSON.stringify(caracteristiques) : null,
        equipement ? JSON.stringify(equipement) : null,
        notes, pv_current, pm_current,
        req.params.id,
      ]
    );

    if (isInitialCreation) {
      const famille = await pool.query(
        `SELECT f.pv_base FROM rules_profils p JOIN rules_familles f ON f.id = p.famille_id WHERE p.id = $1`,
        [profil_id]
      );
      await pool.query(
        'UPDATE characters SET pv_body_total = $1 WHERE id = $2',
        [seedPvBodyTotal(famille.rows[0].pv_base), req.params.id]
      );
    }

    const updated = await recomputeAndPersist(req.params.id);

    if (!isInitialCreation) {
      if (pv_current !== undefined && pv_current !== character.pv_current) {
        const delta = pv_current - character.pv_current;
        await logEvent(character.campaign_id, character.id, 'pv_change',
          `${character.name} : PV ${character.pv_current} → ${pv_current} (${delta > 0 ? '+' : ''}${delta})`);
      }
      if (pm_current !== undefined && pm_current !== character.pm_current) {
        const delta = pm_current - character.pm_current;
        await logEvent(character.campaign_id, character.id, 'pm_change',
          `${character.name} : PM ${character.pm_current} → ${pm_current} (${delta > 0 ? '+' : ''}${delta})`);
      }
    }

    res.json(updated);
  } catch (error) {
    console.error('Error PATCH /characters/:id:', error.message);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du personnage' });
  }
});

/**
 * POST /characters/:id/voies
 * Assigns a voie to a character.
 * Body: { voie_id, obtained_at_level, spend_points, rang, rang_cap }
 * spend_points (default true) costs 1 capacity point — pass false for the
 * 3 free voies granted automatically at character creation (level 1).
 * rang (default 1) may only be 2 when spend_points is false — the mage
 * exception where one of the two profil voies (or the voie du mage) starts
 * at rang 2 (p.29/39).
 * rang_cap freezes the voie at that rang forever — used for a peuple voie
 * once its owner replaces it with the voie du mage (p.60): the character
 * keeps the rang-1 capacité but can never raise it further.
 * A type='profil' voie whose profil_id differs from the character's own is a profil hybride
 * pick (p.176) — allowed only while at least one of the principal profil's 5 voies is still
 * completely untouched.
 */
router.post('/characters/:id/voies', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM characters WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Personnage non trouvé' });
    }
    const character = existing.rows[0];
    if (!(await canAccessCharacter(character, req.user))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const { voie_id, obtained_at_level, spend_points = true, rang = 1, rang_cap = null } = req.body;
    if (!voie_id || !obtained_at_level) {
      return res.status(400).json({ error: 'voie_id et obtained_at_level requis' });
    }
    if (spend_points && character.capacity_points_available < 1) {
      return res.status(400).json({ error: 'Pas assez de points de capacité (1 requis)' });
    }

    let voieName;
    if (spend_points) {
      const voieRow = await pool.query('SELECT name, type, profil_id FROM rules_voies WHERE id = $1', [voie_id]);
      voieName = voieRow.rows[0]?.name;
      const isForeignProfilVoie = voieRow.rows[0]?.type === 'profil'
        && voieRow.rows[0].profil_id
        && voieRow.rows[0].profil_id !== character.profil_id;

      if (isForeignProfilVoie) {
        const ownProfilCount = await pool.query(
          `SELECT count(*) FROM character_voies cv JOIN rules_voies v ON v.id = cv.voie_id
           WHERE cv.character_id = $1 AND v.profil_id = $2`,
          [req.params.id, character.profil_id]
        );
        if (parseInt(ownProfilCount.rows[0].count, 10) >= 5) {
          return res.status(400).json({
            error: 'Profil hybride impossible : les 5 voies du profil principal ont déjà été entamées',
          });
        }
      }
    }

    const grantedRang = !spend_points && rang === 2 ? 2 : 1;

    const result = await pool.query(
      `INSERT INTO character_voies (character_id, voie_id, rang, rang_cap, obtained_at_level)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (character_id, voie_id) DO NOTHING
       RETURNING *`,
      [req.params.id, voie_id, grantedRang, rang_cap, obtained_at_level]
    );

    if (spend_points && result.rows.length > 0) {
      await pool.query(
        'UPDATE characters SET capacity_points_available = capacity_points_available - 1 WHERE id = $1',
        [req.params.id]
      );
      await recordVoieFamilyForLeveling(req.params.id, voie_id);
      await maybeFinalizeLevelPv(req.params.id);
      if (result.rows.length > 0) {
        await logEvent(character.campaign_id, character.id, 'voie_added',
          `${character.name} acquiert ${voieName}`);
      }
    }

    await recomputeAndPersist(req.params.id); // a spell-granting voie changes pm_max
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error POST /characters/:id/voies:', error.message);
    res.status(500).json({ error: 'Erreur lors de l\'ajout de la voie' });
  }
});

/**
 * PATCH /characters/:id/voies/:voieId
 * Raises a voie's rang by 1. Body: {} (no fields needed, always +1 rang).
 * Enforces: prerequisite rang already held, niveau requirement, and cost
 * (1 point for rang 1-2, 2 points for rang 3+), taken from capacity_points_available.
 */
router.patch('/characters/:id/voies/:voieId', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM characters WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Personnage non trouvé' });
    }
    const character = existing.rows[0];
    if (!(await canAccessCharacter(character, req.user))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const current = await pool.query(
      'SELECT * FROM character_voies WHERE character_id = $1 AND voie_id = $2',
      [req.params.id, req.params.voieId]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Le personnage ne possède pas cette voie' });
    }

    const { rang_cap: rangCap } = current.rows[0];
    if (rangCap !== null && current.rows[0].rang >= rangCap) {
      return res.status(400).json({ error: 'Cette voie a été remplacée et ne peut plus progresser' });
    }

    const newRang = current.rows[0].rang + 1;
    const niveauRequis = NIVEAU_REQUIS_PAR_RANG[newRang];
    if (!niveauRequis) {
      return res.status(400).json({ error: 'Rang maximal déjà atteint' });
    }
    if (character.level < niveauRequis) {
      return res.status(400).json({ error: `Niveau ${niveauRequis} requis pour ce rang` });
    }

    const cost = newRang <= 2 ? 1 : 2;
    if (character.capacity_points_available < cost) {
      return res.status(400).json({ error: `Pas assez de points de capacité (${cost} requis)` });
    }

    await pool.query(
      'UPDATE character_voies SET rang = $1 WHERE character_id = $2 AND voie_id = $3',
      [newRang, req.params.id, req.params.voieId]
    );
    await pool.query(
      'UPDATE characters SET capacity_points_available = capacity_points_available - $1 WHERE id = $2',
      [cost, req.params.id]
    );
    await recordVoieFamilyForLeveling(req.params.id, req.params.voieId);
    await maybeFinalizeLevelPv(req.params.id);

    const voieRow = await pool.query('SELECT name FROM rules_voies WHERE id = $1', [req.params.voieId]);
    await logEvent(character.campaign_id, character.id, 'voie_rang_up',
      `${character.name} : ${voieRow.rows[0]?.name} passe au rang ${newRang}`);

    const updated = await recomputeAndPersist(req.params.id); // a newly-unlocked sort changes pm_max
    res.json(updated);
  } catch (error) {
    console.error('Error PATCH /characters/:id/voies/:voieId:', error.message);
    res.status(500).json({ error: 'Erreur lors de la montée de rang' });
  }
});

/**
 * POST /characters/:id/level-up
 * Advances the character by 1 level: +2 capacity points, recomputed PV/PM/etc.
 */
router.post('/characters/:id/level-up', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM characters WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Personnage non trouvé' });
    }
    const character = existing.rows[0];
    if (!(await canAccessCharacter(character, req.user))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    if (character.capacity_points_available > 0) {
      return res.status(400).json({
        error: 'Dépensez d\'abord les points de capacité restants avant de monter de niveau',
      });
    }

    await pool.query(
      `UPDATE characters SET level = level + 1, capacity_points_available = capacity_points_available + 2,
         level_up_families = '{}'
       WHERE id = $1`,
      [req.params.id]
    );

    const updated = await recomputeAndPersist(req.params.id);
    await logEvent(character.campaign_id, character.id, 'level_up',
      `${character.name} passe au niveau ${character.level + 1}`);
    res.json(updated);
  } catch (error) {
    console.error('Error POST /characters/:id/level-up:', error.message);
    res.status(500).json({ error: 'Erreur lors du passage de niveau' });
  }
});

/**
 * POST /characters/:id/orphan-exchange
 * Spends 1 orphan capacity point for: 1 PC, 1 DR, 2 PV (max), or 2 PM (max).
 * Body: { choice: 'pc' | 'dr' | 'pv' | 'pm' }
 */
router.post('/characters/:id/orphan-exchange', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM characters WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Personnage non trouvé' });
    }
    const character = existing.rows[0];
    if (!(await canAccessCharacter(character, req.user))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    if (character.capacity_points_available < 1) {
      return res.status(400).json({ error: 'Aucun point de capacité disponible' });
    }

    const { choice } = req.body;
    // Bonuses go through the same additive ledger columns recomputeAndPersist reads, rather
    // than overriding pv_max/pm_max/etc. directly — a direct override gets silently clobbered
    // by the next recompute triggered by any other action (new voie, rang increase...).
    const updates = { capacity_points_available: character.capacity_points_available - 1 };
    const choiceLabels = { pc: '+1 Chance', dr: '+1 Récupération', pv: '+2 PV', pm: '+2 PM' };

    if (choice === 'pc') {
      updates.pc_bonus_orphan = character.pc_bonus_orphan + 1;
    } else if (choice === 'dr') {
      updates.dr_bonus_orphan = character.dr_bonus_orphan + 1;
    } else if (choice === 'pv') {
      updates.pv_body_total = character.pv_body_total + 2;
    } else if (choice === 'pm') {
      updates.pm_bonus_orphan = character.pm_bonus_orphan + 2;
    } else {
      return res.status(400).json({ error: "choice doit être 'pc', 'dr', 'pv' ou 'pm'" });
    }

    const keys = Object.keys(updates);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    await pool.query(
      `UPDATE characters SET ${setClause} WHERE id = $${keys.length + 1}`,
      [...keys.map((k) => updates[k]), req.params.id]
    );

    const updated = await recomputeAndPersist(req.params.id); // carries the PV/PM gain into current, like a level-up
    await logEvent(character.campaign_id, character.id, 'orphan_exchange',
      `${character.name} échange un point orphelin contre ${choiceLabels[choice]}`);
    res.json(updated);
  } catch (error) {
    console.error('Error POST /characters/:id/orphan-exchange:', error.message);
    res.status(500).json({ error: 'Erreur lors de l\'échange du point orphelin' });
  }
});

/**
 * DELETE /characters/:id/voies/:voieId
 */
router.delete('/characters/:id/voies/:voieId', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM characters WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Personnage non trouvé' });
    }
    if (!(await canAccessCharacter(existing.rows[0], req.user))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    await pool.query(
      'DELETE FROM character_voies WHERE character_id = $1 AND voie_id = $2',
      [req.params.id, req.params.voieId]
    );

    res.json({ message: 'Voie retirée' });
  } catch (error) {
    console.error('Error DELETE /characters/:id/voies/:voieId:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * DELETE /characters/:id
 * GM only. Removes a character (PNJ, an abandoned pre-built PJ, a mis-clicked creation...).
 * Cascades to character_voies and campaign_invites; board_tokens keep the token, unlinked.
 */
router.delete('/characters/:id', requireGm, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM characters ch USING campaigns c
       WHERE ch.id = $1 AND ch.campaign_id = c.id AND c.gm_id = $2
       RETURNING ch.id`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Personnage non trouvé' });
    }
    res.json({ message: 'Personnage supprimé' });
  } catch (error) {
    console.error('Error DELETE /characters/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
