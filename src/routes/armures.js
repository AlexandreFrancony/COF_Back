import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken, requireGm } from '../middleware/auth.js';

const router = Router();
router.use(authenticateToken);

/**
 * GET /rules/armures — any authenticated user. The shared armor + shield library (p.188) a
 * character can equip one of each from. Seeded from the rulebook's own table; agi_max/prix
 * are reference info only — see the schema.sql comment on rules_armures for what's enforced.
 */
router.get('/rules/armures', async (req, res) => {
  try {
    const armures = await pool.query('SELECT * FROM rules_armures ORDER BY type, defense_bonus');
    res.json(armures.rows);
  } catch (error) {
    console.error('Error GET rules/armures:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /rules/armures — GM only. Body: { name, type ('armure'|'bouclier'), defense_bonus,
 * agi_max, prix } — for adding a homebrew entry alongside the seeded rulebook ones.
 */
router.post('/rules/armures', requireGm, async (req, res) => {
  try {
    const { name, type = 'armure', defense_bonus = 0, agi_max = null, prix = null } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    if (!['armure', 'bouclier'].includes(type)) {
      return res.status(400).json({ error: "Type invalide (attendu 'armure' ou 'bouclier')" });
    }

    const created = await pool.query(
      'INSERT INTO rules_armures (name, type, defense_bonus, agi_max, prix) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, type, defense_bonus, agi_max, prix]
    );
    res.status(201).json(created.rows[0]);
  } catch (error) {
    console.error('Error POST rules/armures:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * DELETE /rules/armures/:id — GM only. Any character wearing it is unequipped automatically
 * (armure_id references this table ON DELETE SET NULL).
 */
router.delete('/rules/armures/:id', requireGm, async (req, res) => {
  try {
    await pool.query('DELETE FROM rules_armures WHERE id = $1', [req.params.id]);
    res.json({ message: 'Armure supprimée' });
  } catch (error) {
    console.error('Error DELETE rules/armures:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
