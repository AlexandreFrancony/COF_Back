import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();
router.use(authenticateToken);

router.get('/familles', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rules_familles ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error GET /rules/familles:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/profils', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, f.code AS famille_code, f.name AS famille_name, f.pv_base
       FROM rules_profils p JOIN rules_familles f ON f.id = p.famille_id
       ORDER BY f.name, p.name`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error GET /rules/profils:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/peuples', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rules_peuples ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error GET /rules/peuples:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /voies?profil_id=&peuple_id=&type=
 * Returns voies with their capacités nested, optionally filtered.
 */
router.get('/voies', async (req, res) => {
  try {
    const { profil_id, peuple_id, type } = req.query;
    const conditions = [];
    const params = [];

    if (profil_id) {
      params.push(profil_id);
      conditions.push(`profil_id = $${params.length}`);
    }
    if (peuple_id) {
      params.push(peuple_id);
      conditions.push(`peuple_id = $${params.length}`);
    }
    if (type) {
      params.push(type);
      conditions.push(`type = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const voies = await pool.query(`SELECT * FROM rules_voies ${where} ORDER BY name`, params);

    const voieIds = voies.rows.map((v) => v.id);
    const capacites = voieIds.length > 0
      ? await pool.query(
          'SELECT * FROM rules_capacites WHERE voie_id = ANY($1) ORDER BY rang',
          [voieIds]
        )
      : { rows: [] };

    const capacitesByVoie = {};
    for (const cap of capacites.rows) {
      (capacitesByVoie[cap.voie_id] ??= []).push(cap);
    }

    res.json(voies.rows.map((v) => ({ ...v, capacites: capacitesByVoie[v.id] || [] })));
  } catch (error) {
    console.error('Error GET /rules/voies:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
