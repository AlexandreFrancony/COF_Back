import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken, requireGm } from '../middleware/auth.js';

const router = Router();
router.use(authenticateToken);

/**
 * GET /rules/armes — any authenticated user. The shared weapon library (p.182-184: contact
 * and distance weapons) a character can equip up to two of (arme_principale/arme_secondaire —
 * dual-wielding etc., unenforced). Everything here is reference info shown on the sheet —
 * nothing feeds a stored/computed stat, damage is rolled live at the table.
 */
router.get('/rules/armes', async (req, res) => {
  try {
    const armes = await pool.query('SELECT * FROM rules_armes ORDER BY category, name');
    res.json(armes.rows);
  } catch (error) {
    console.error('Error GET rules/armes:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /rules/armes — GM only. Body: { name, category ('contact'|'distance'), damage_dice,
 * type_degats, portee, prix, for_applies, notes } — for adding a homebrew weapon.
 */
router.post('/rules/armes', requireGm, async (req, res) => {
  try {
    const {
      name, category = 'contact', damage_dice, type_degats = null,
      portee = null, prix = null, for_applies = true, notes = null,
    } = req.body;
    if (!name || !damage_dice) return res.status(400).json({ error: 'Nom et dé de dégâts requis' });
    if (!['contact', 'distance'].includes(category)) {
      return res.status(400).json({ error: "Catégorie invalide (attendu 'contact' ou 'distance')" });
    }

    const created = await pool.query(
      `INSERT INTO rules_armes (name, category, damage_dice, type_degats, portee, prix, for_applies, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, category, damage_dice, type_degats, portee, prix, for_applies, notes]
    );
    res.status(201).json(created.rows[0]);
  } catch (error) {
    console.error('Error POST rules/armes:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * DELETE /rules/armes/:id — GM only. Any character wielding it is unequipped automatically
 * (arme_principale_id/arme_secondaire_id reference this table ON DELETE SET NULL).
 */
router.delete('/rules/armes/:id', requireGm, async (req, res) => {
  try {
    await pool.query('DELETE FROM rules_armes WHERE id = $1', [req.params.id]);
    res.json({ message: 'Arme supprimée' });
  } catch (error) {
    console.error('Error DELETE rules/armes:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
