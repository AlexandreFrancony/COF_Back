import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { computeDerivedStats } from '../services/characterCalculations.js';

const router = Router();
router.use(authenticateToken);

async function canAccessCharacter(character, user) {
  if (character.user_id === user.id) return true;
  if (user.role !== 'gm') return false;
  const campaign = await pool.query('SELECT gm_id FROM campaigns WHERE id = $1', [character.campaign_id]);
  return campaign.rows[0]?.gm_id === user.id;
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

    const merged = {
      name: name ?? character.name,
      profil_id: profil_id ?? character.profil_id,
      peuple_id: peuple_id ?? character.peuple_id,
      level: level ?? character.level,
      caracteristiques: caracteristiques ?? character.caracteristiques,
    };

    let derived = {};
    if (merged.profil_id) {
      const profil = await pool.query(
        `SELECT p.*, f.pv_base, f.dr_die, f.dr_bonus, f.pc_bonus
         FROM rules_profils p JOIN rules_familles f ON f.id = p.famille_id
         WHERE p.id = $1`,
        [merged.profil_id]
      );

      if (profil.rows.length > 0 && merged.caracteristiques) {
        const sortsCount = await pool.query(
          `SELECT count(*) FROM character_voies cv
           JOIN rules_capacites c ON c.voie_id = cv.voie_id AND c.rang <= cv.rang
           WHERE cv.character_id = $1 AND c.est_sort = true`,
          [character.id]
        );

        derived = computeDerivedStats(
          profil.rows[0],
          merged.caracteristiques,
          merged.level,
          parseInt(sortsCount.rows[0].count, 10)
        );
      }
    }

    const result = await pool.query(
      `UPDATE characters SET
         name = $1, profil_id = $2, peuple_id = $3, level = $4,
         caracteristiques = COALESCE($5, caracteristiques),
         equipement = COALESCE($6, equipement),
         notes = COALESCE($7, notes),
         pv_current = COALESCE($8, pv_current),
         pm_current = COALESCE($9, pm_current),
         pv_max = COALESCE($10, pv_max),
         pm_max = COALESCE($11, pm_max),
         points_chance = COALESCE($12, points_chance),
         de_recuperation = COALESCE($13, de_recuperation),
         defense = COALESCE($14, defense),
         initiative = COALESCE($15, initiative),
         valeurs_attaque = COALESCE($16, valeurs_attaque)
       WHERE id = $17
       RETURNING *`,
      [
        merged.name, merged.profil_id, merged.peuple_id, merged.level,
        caracteristiques ? JSON.stringify(caracteristiques) : null,
        equipement ? JSON.stringify(equipement) : null,
        notes, pv_current, pm_current,
        derived.pv_max, derived.pm_max, derived.points_chance,
        derived.de_recuperation, derived.defense, derived.initiative,
        derived.valeurs_attaque ? JSON.stringify(derived.valeurs_attaque) : null,
        req.params.id,
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error PATCH /characters/:id:', error.message);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du personnage' });
  }
});

/**
 * POST /characters/:id/voies
 * Assigns a voie (rang 1) to a character — used during creation and level-up.
 * Body: { voie_id, obtained_at_level }
 */
router.post('/characters/:id/voies', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM characters WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Personnage non trouvé' });
    }
    if (!(await canAccessCharacter(existing.rows[0], req.user))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const { voie_id, obtained_at_level } = req.body;
    if (!voie_id || !obtained_at_level) {
      return res.status(400).json({ error: 'voie_id et obtained_at_level requis' });
    }

    const result = await pool.query(
      `INSERT INTO character_voies (character_id, voie_id, rang, obtained_at_level)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (character_id, voie_id) DO NOTHING
       RETURNING *`,
      [req.params.id, voie_id, obtained_at_level]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error POST /characters/:id/voies:', error.message);
    res.status(500).json({ error: 'Erreur lors de l\'ajout de la voie' });
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
