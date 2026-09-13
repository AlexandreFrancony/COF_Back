import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken, requireGm } from '../middleware/auth.js';
import {
  computeDerivedStats, computePvBodyGain, seedPvBodyTotal, NIVEAU_REQUIS_PAR_RANG,
} from '../services/characterCalculations.js';
import { logEvent } from '../services/eventLog.js';
import { hasSubscribers, broadcastBoard } from '../services/boardStream.js';
import { getFullBoard, buildBoardForRole } from './board.js';

const router = Router();
router.use(authenticateToken);

async function canAccessCharacter(character, user) {
  if (character.user_id === user.id) return true;
  if (user.role !== 'gm') return false;
  const campaign = await pool.query('SELECT gm_id FROM campaigns WHERE id = $1', [character.campaign_id]);
  return campaign.rows[0]?.gm_id === user.id;
}

// Shared shape for every route that returns a character: the raw row plus its voies, each
// with the capacités owned up to their current rang. Used consistently everywhere (not just
// GET) so a frontend handler can never accidentally drop the voies by using a mutation
// endpoint's response directly instead of re-fetching.
async function getCharacterWithVoies(characterId) {
  const result = await pool.query('SELECT * FROM characters WHERE id = $1', [characterId]);
  const character = result.rows[0];
  if (!character) return null;

  const voies = await pool.query(
    `SELECT cv.rang, cv.rang_cap, cv.obtained_at_level, v.id AS voie_id, v.code, v.name, v.type
     FROM character_voies cv JOIN rules_voies v ON v.id = cv.voie_id
     WHERE cv.character_id = $1`,
    [characterId]
  );

  const capacites = voies.rows.length > 0
    ? await pool.query(
        `SELECT c.* FROM rules_capacites c
         JOIN character_voies cv ON cv.voie_id = c.voie_id AND c.rang <= cv.rang
         WHERE cv.character_id = $1
         ORDER BY c.voie_id, c.rang`,
        [characterId]
      )
    : { rows: [] };

  const capacitesByVoie = {};
  for (const cap of capacites.rows) {
    (capacitesByVoie[cap.voie_id] ??= []).push(cap);
  }

  return { ...character, voies: voies.rows.map((v) => ({ ...v, capacites: capacitesByVoie[v.voie_id] || [] })) };
}

// Pushes the campaign's board over SSE whenever a character's live stats change, so the
// board HUD (PV/PM/etc next to each token) stays in sync without a manual board refresh.
// No-ops if nobody has the board open — cheap enough to call after every recompute.
async function broadcastCharacterChange(campaignId) {
  const key = String(campaignId);
  if (!hasSubscribers(key)) return;
  const board = await getFullBoard(campaignId);
  broadcastBoard(key, board, buildBoardForRole);
}

/**
 * Recomputes pv_max/pm_max/points_chance/de_recuperation/defense/initiative/valeurs_attaque
 * for a character and persists them, carrying forward the *gain* into pv_current/pm_current
 * (leveling up or learning a spell heals/refills by the amount gained, per the rulebook).
 * Always returns the character with its nested voies (see getCharacterWithVoies).
 */
async function recomputeAndPersist(characterId) {
  const charResult = await pool.query('SELECT * FROM characters WHERE id = $1', [characterId]);
  const character = charResult.rows[0];
  const finish = async () => {
    const updated = await getCharacterWithVoies(characterId);
    if (character?.campaign_id) await broadcastCharacterChange(character.campaign_id);
    return updated;
  };

  if (!character?.profil_id) return finish();

  const profil = await pool.query(
    `SELECT p.*, f.pv_base, f.dr_die, f.dr_bonus, f.pc_bonus
     FROM rules_profils p JOIN rules_familles f ON f.id = p.famille_id
     WHERE p.id = $1`,
    [character.profil_id]
  );
  if (profil.rows.length === 0) return finish();

  const sortsCount = await pool.query(
    `SELECT count(*) FROM character_voies cv
     JOIN rules_capacites c ON c.voie_id = cv.voie_id AND c.rang <= cv.rang
     WHERE cv.character_id = $1 AND c.est_sort = true`,
    [characterId]
  );

  // The +1 PC from the Voie de l'Humain's rang-1 "Diversité" (p.46) — gated on actually owning
  // that capacité, not just being peuple=Humain, since the mage exception can replace it with
  // the voie du mage (though it keeps the rang-1 capacité, per p.60's own carve-out).
  const humanOrigin = await pool.query(
    `SELECT 1 FROM character_voies cv JOIN rules_voies v ON v.id = cv.voie_id
     WHERE cv.character_id = $1 AND v.code = 'peuple-humain' AND cv.rang >= 1`,
    [characterId]
  );

  const derived = computeDerivedStats(
    profil.rows[0], character, parseInt(sortsCount.rows[0].count, 10), humanOrigin.rows.length > 0
  );

  const pvGain = Math.max(0, derived.pv_max - character.pv_max);
  const pmGain = Math.max(0, derived.pm_max - character.pm_max);

  await pool.query(
    `UPDATE characters SET
       pv_max = $1, pm_max = $2, points_chance = $3, de_recuperation = $4,
       defense = $5, initiative = $6, valeurs_attaque = $7,
       pv_current = LEAST($1, pv_current + $8),
       pm_current = LEAST($2, pm_current + $9)
     WHERE id = $10`,
    [
      derived.pv_max, derived.pm_max, derived.points_chance, derived.de_recuperation,
      derived.defense, derived.initiative, JSON.stringify(derived.valeurs_attaque),
      pvGain, pmGain, characterId,
    ]
  );

  return finish();
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
    const character = await getCharacterWithVoies(req.params.id);
    if (!character) {
      return res.status(404).json({ error: 'Personnage non trouvé' });
    }
    if (!(await canAccessCharacter(character, req.user))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    res.json(character);
  } catch (error) {
    console.error('Error GET /characters/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * PATCH /characters/:id
 * Updates character fields and recomputes derived stats (pv_max, pm_max, defense, etc.)
 * whenever profil, peuple, caracteristiques or level change.
 * Body: any subset of { name, profil_id, peuple_id, level, caracteristiques, equipement, notes, pv_current, pm_current, origine_humaine }
 * GM only, additionally: { capacity_points_available, forgets_available, pv_body_total,
 * pc_bonus_orphan, dr_bonus_orphan, pm_bonus_orphan } — raw ledger overrides for the GM editor
 * (fixing a mis-built character, migrating an existing PJ's real state, etc.). Silently ignored
 * for a non-GM caller rather than erroring, since a player's own PATCH calls never send them.
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
    const isGm = req.user.role === 'gm';

    const {
      name, profil_id, peuple_id, level, caracteristiques,
      equipement, notes, pv_current, pm_current, origine_humaine,
    } = req.body;
    const {
      capacity_points_available, forgets_available, pv_body_total,
      pc_bonus_orphan, dr_bonus_orphan, pm_bonus_orphan,
    } = isGm ? req.body : {};

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
         pm_current = COALESCE($9, pm_current),
         capacity_points_available = COALESCE($10, capacity_points_available),
         forgets_available = COALESCE($11, forgets_available),
         pv_body_total = COALESCE($12, pv_body_total),
         pc_bonus_orphan = COALESCE($13, pc_bonus_orphan),
         dr_bonus_orphan = COALESCE($14, dr_bonus_orphan),
         pm_bonus_orphan = COALESCE($15, pm_bonus_orphan),
         origine_humaine = COALESCE($16, origine_humaine)
       WHERE id = $17`,
      [
        name, profil_id, peuple_id, level,
        caracteristiques ? JSON.stringify(caracteristiques) : null,
        equipement ? JSON.stringify(equipement) : null,
        notes, pv_current, pm_current,
        capacity_points_available, forgets_available, pv_body_total,
        pc_bonus_orphan, dr_bonus_orphan, pm_bonus_orphan,
        origine_humaine,
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
 * A type='prestige' voie opens directly at rang 4 for 2 points, gated on
 * niveau_prestige_requis and limited to one per career (p.39).
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

    const isGm = req.user.role === 'gm';
    if (!spend_points) {
      // Free grants are for the creation wizard (player, level 1 only — the mage bonus rang-2
      // exception) or the GM editor's unrestricted overrides — never a way for a player to
      // dodge the point economy once they've actually started playing.
      const isOwnCreationWindow = character.user_id === req.user.id && character.level === 1;
      if (!isGm && !isOwnCreationWindow) {
        return res.status(403).json({ error: 'Voie gratuite non autorisée en dehors de la création initiale' });
      }
    }

    let voieName;
    // The GM editor can grant any rang directly; the player-facing creation flow stays
    // restricted to rang 1 (or 2, the mage bonus exception).
    let grantedRang = 1;
    if (!spend_points) grantedRang = isGm ? rang : (rang === 2 ? 2 : 1);
    let cost = 1;

    if (spend_points) {
      const voieRow = await pool.query(
        'SELECT name, type, profil_id, niveau_prestige_requis FROM rules_voies WHERE id = $1',
        [voie_id]
      );
      const voie = voieRow.rows[0];
      voieName = voie?.name;

      const isForeignProfilVoie = voie?.type === 'profil' && voie.profil_id && voie.profil_id !== character.profil_id;
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

      // A prestige voie opens directly at rang 4 (not rang 1) and costs the rang 3+ price
      // (2 points) — one per career (p.39), gated on the character's own niveau_prestige_requis.
      if (voie?.type === 'prestige') {
        if (character.level < voie.niveau_prestige_requis) {
          return res.status(400).json({
            error: `Niveau ${voie.niveau_prestige_requis} requis pour cette voie de prestige`,
          });
        }
        const existingPrestige = await pool.query(
          `SELECT 1 FROM character_voies cv JOIN rules_voies v ON v.id = cv.voie_id
           WHERE cv.character_id = $1 AND v.type = 'prestige'`,
          [req.params.id]
        );
        if (existingPrestige.rows.length > 0) {
          return res.status(400).json({ error: 'Une seule voie de prestige est possible par carrière' });
        }
        grantedRang = 4;
        cost = 2;
      }

      if (character.capacity_points_available < cost) {
        return res.status(400).json({ error: `Pas assez de points de capacité (${cost} requis)` });
      }
    }

    const result = await pool.query(
      `INSERT INTO character_voies (character_id, voie_id, rang, rang_cap, obtained_at_level)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (character_id, voie_id) DO NOTHING
       RETURNING *`,
      [req.params.id, voie_id, grantedRang, rang_cap, obtained_at_level]
    );

    if (spend_points && result.rows.length > 0) {
      await pool.query(
        'UPDATE characters SET capacity_points_available = capacity_points_available - $1 WHERE id = $2',
        [cost, req.params.id]
      );
      await recordVoieFamilyForLeveling(req.params.id, voie_id);
      await maybeFinalizeLevelPv(req.params.id);
      await logEvent(character.campaign_id, character.id, 'voie_added',
        `${character.name} acquiert ${voieName}`);
    }

    const updated = await recomputeAndPersist(req.params.id); // a spell-granting voie changes pm_max
    res.status(201).json(updated);
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
 * GM only: passing an explicit { rang } sets it directly instead — no cost, no niveau check,
 * no PV-ledger/family side effects (a raw correction, not real in-play progression); a rang
 * of 0 or less removes the voie entirely. For the GM editor.
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

    if (req.user.role === 'gm' && req.body.rang !== undefined) {
      if (req.body.rang <= 0) {
        await pool.query(
          'DELETE FROM character_voies WHERE character_id = $1 AND voie_id = $2',
          [req.params.id, req.params.voieId]
        );
      } else {
        await pool.query(
          'UPDATE character_voies SET rang = $1 WHERE character_id = $2 AND voie_id = $3',
          [req.body.rang, req.params.id, req.params.voieId]
        );
      }
      const updated = await recomputeAndPersist(req.params.id);
      return res.json(updated);
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

    // Changement d'orientation (p.42-43): +1 forget-and-replace token per level, +2 if INT>=+2.
    const forgetsGained = character.caracteristiques.INT >= 2 ? 2 : 1;
    await pool.query(
      `UPDATE characters SET level = level + 1, capacity_points_available = capacity_points_available + 2,
         level_up_families = '{}', forgets_available = forgets_available + $2
       WHERE id = $1`,
      [req.params.id, forgetsGained]
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
 * POST /characters/:id/voies/:voieId/forget
 * "Changement d'orientation" (p.42-43): forgets the voie's current (highest) rang, refunding
 * its point cost to spend elsewhere — enforces no holes in a voie automatically, since it
 * always removes the top rang rather than an arbitrary one.
 * Consumes 1 of the character's forgets_available (granted +1 per level, +2 if INT>=+2).
 * Blocked below rang 1 for a voie granted for free at creation (obtained_at_level=1) — "il
 * n'est pas possible d'oublier sa jeunesse". Known minor gap: the mage's bonus rang-2 grant at
 * creation is also obtained_at_level=1 but starts at rang 2, not 1 — forgetting it down to
 * rang 1 isn't blocked, refunding a point that was never actually spent. Accepted as a rare,
 * low-stakes edge case rather than adding a column just to track each voie's starting rang.
 */
router.post('/characters/:id/voies/:voieId/forget', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM characters WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Personnage non trouvé' });
    }
    const character = existing.rows[0];
    if (!(await canAccessCharacter(character, req.user))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    if (character.forgets_available < 1) {
      return res.status(400).json({ error: 'Aucun changement d\'orientation disponible' });
    }

    const current = await pool.query(
      'SELECT * FROM character_voies WHERE character_id = $1 AND voie_id = $2',
      [req.params.id, req.params.voieId]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Le personnage ne possède pas cette voie' });
    }
    const cv = current.rows[0];

    if (cv.obtained_at_level === 1 && cv.rang <= 1) {
      return res.status(400).json({
        error: 'Impossible d\'oublier une capacité acquise gratuitement à la création',
      });
    }

    const voieRow = await pool.query('SELECT name FROM rules_voies WHERE id = $1', [req.params.voieId]);
    const refund = cv.rang <= 2 ? 1 : 2;
    const newRang = cv.rang - 1;

    if (newRang <= 0) {
      await pool.query(
        'DELETE FROM character_voies WHERE character_id = $1 AND voie_id = $2',
        [req.params.id, req.params.voieId]
      );
    } else {
      await pool.query(
        'UPDATE character_voies SET rang = $1 WHERE character_id = $2 AND voie_id = $3',
        [newRang, req.params.id, req.params.voieId]
      );
    }

    await pool.query(
      `UPDATE characters SET
         forgets_available = forgets_available - 1,
         capacity_points_available = capacity_points_available + $1
       WHERE id = $2`,
      [refund, req.params.id]
    );

    const updated = await recomputeAndPersist(req.params.id); // losing a sort-granting capacité changes pm_max
    await logEvent(character.campaign_id, character.id, 'voie_forgotten',
      `${character.name} oublie ${voieRow.rows[0]?.name} (rang ${cv.rang}) — +${refund} point${refund > 1 ? 's' : ''} de capacité`);
    res.json(updated);
  } catch (error) {
    console.error('Error POST /characters/:id/voies/:voieId/forget:', error.message);
    res.status(500).json({ error: 'Erreur lors du changement d\'orientation' });
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
