import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { computeDerivedStats, NIVEAU_REQUIS_PAR_RANG } from '../services/characterCalculations.js';

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

  const derived = computeDerivedStats(
    profil.rows[0],
    character.caracteristiques,
    character.level,
    parseInt(sortsCount.rows[0].count, 10)
  );

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
      `SELECT cv.rang, cv.obtained_at_level, v.id AS voie_id, v.code, v.name, v.type
       FROM character_voies cv JOIN rules_voies v ON v.id = cv.voie_id
       WHERE cv.character_id = $1`,
      [character.id]
    );

    res.json({ ...character, voies: voies.rows });
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

    const updated = await recomputeAndPersist(req.params.id);
    res.json(updated);
  } catch (error) {
    console.error('Error PATCH /characters/:id:', error.message);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du personnage' });
  }
});

/**
 * POST /characters/:id/voies
 * Assigns a voie at rang 1 to a character.
 * Body: { voie_id, obtained_at_level, spend_points }
 * spend_points (default true) costs 1 capacity point — pass false for the
 * 3 free voies granted automatically at character creation (level 1).
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

    const { voie_id, obtained_at_level, spend_points = true } = req.body;
    if (!voie_id || !obtained_at_level) {
      return res.status(400).json({ error: 'voie_id et obtained_at_level requis' });
    }
    if (spend_points && character.capacity_points_available < 1) {
      return res.status(400).json({ error: 'Pas assez de points de capacité (1 requis)' });
    }

    const result = await pool.query(
      `INSERT INTO character_voies (character_id, voie_id, rang, obtained_at_level)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (character_id, voie_id) DO NOTHING
       RETURNING *`,
      [req.params.id, voie_id, obtained_at_level]
    );

    if (spend_points && result.rows.length > 0) {
      await pool.query(
        'UPDATE characters SET capacity_points_available = capacity_points_available - 1 WHERE id = $1',
        [req.params.id]
      );
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
      `UPDATE characters SET level = level + 1, capacity_points_available = capacity_points_available + 2
       WHERE id = $1`,
      [req.params.id]
    );

    const updated = await recomputeAndPersist(req.params.id);
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
    const updates = { capacity_points_available: character.capacity_points_available - 1 };

    if (choice === 'pc') {
      updates.points_chance = character.points_chance + 1;
    } else if (choice === 'dr') {
      const match = character.de_recuperation?.match(/^(\d+)(d\d+)$/);
      if (!match) return res.status(400).json({ error: 'Dé de récupération invalide' });
      updates.de_recuperation = `${parseInt(match[1], 10) + 1}${match[2]}`;
    } else if (choice === 'pv') {
      updates.pv_max = character.pv_max + 2;
      updates.pv_current = character.pv_current + 2;
    } else if (choice === 'pm') {
      updates.pm_max = character.pm_max + 2;
      updates.pm_current = character.pm_current + 2;
    } else {
      return res.status(400).json({ error: "choice doit être 'pc', 'dr', 'pv' ou 'pm'" });
    }

    const keys = Object.keys(updates);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const result = await pool.query(
      `UPDATE characters SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map((k) => updates[k]), req.params.id]
    );

    res.json(result.rows[0]);
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

export default router;
