import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken, requireGm } from '../middleware/auth.js';

const router = Router();
router.use(authenticateToken);

/**
 * GET /rules/armures — any authenticated user. The shared armor library (name + flat DEF
 * bonus) a character can equip from. Deliberately minimal — see the schema.sql comment on
 * rules_armures for why there's no AGI cap or PM spellcasting surcharge.
 */
router.get('/rules/armures', async (req, res) => {
  try {
    const armures = await pool.query('SELECT * FROM rules_armures ORDER BY name');
    res.json(armures.rows);
  } catch (error) {
    console.error('Error GET rules/armures:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /rules/armures — GM only. Body: { name, defense_bonus }.
 */
router.post('/rules/armures', requireGm, async (req, res) => {
  try {
    const { name, defense_bonus = 0 } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom requis' });

    const created = await pool.query(
      'INSERT INTO rules_armures (name, defense_bonus) VALUES ($1, $2) RETURNING *',
      [name, defense_bonus]
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
