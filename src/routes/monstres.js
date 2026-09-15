import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();
router.use(authenticateToken);

/**
 * GET /rules/monstres — any authenticated user. The bestiary (Chapitre 3 "Opposition",
 * p.258-303), grouped by category client-side. Optional ?search= filters by name (used by the
 * board's "Bibliothèque d'ennemis" picker to narrow ~90 entries).
 */
router.get('/rules/monstres', async (req, res) => {
  try {
    const { search } = req.query;
    const monstres = search
      ? await pool.query('SELECT * FROM rules_monstres WHERE name ILIKE $1 ORDER BY category, name', [`%${search}%`])
      : await pool.query('SELECT * FROM rules_monstres ORDER BY category, name');
    res.json(monstres.rows);
  } catch (error) {
    console.error('Error GET rules/monstres:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /rules/monstre-capacites — the GM-facing glossary of named monster abilities (Embuscade,
 * Enragé, Imparable...), distinct from a voie's capacités (see rules_monstre_capacites'
 * schema.sql comment) since several monsters share the exact same ability verbatim.
 */
router.get('/rules/monstre-capacites', async (req, res) => {
  try {
    const capacites = await pool.query('SELECT * FROM rules_monstre_capacites ORDER BY name');
    res.json(capacites.rows);
  } catch (error) {
    console.error('Error GET rules/monstre-capacites:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
