import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken, requireGm } from '../middleware/auth.js';
import { upload } from '../services/uploads.js';

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

/**
 * PATCH /rules/monstres/:id — GM only. Body: { emoji }. The bestiary is global reference data
 * (shared across every campaign), not scoped to one — same reasoning as rules_armures/
 * rules_armes having no ownership check beyond "is this user a GM at all".
 */
router.patch('/rules/monstres/:id', requireGm, async (req, res) => {
  try {
    const { emoji } = req.body;
    const result = await pool.query(
      'UPDATE rules_monstres SET emoji = COALESCE($1, emoji) WHERE id = $2 RETURNING *',
      [emoji, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Monstre non trouvé' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error PATCH rules/monstres/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /rules/monstres/:id/image — GM only, multipart field "image". Sets this bestiary
 * entry's own illustration, joined live into every pawn already spawned from it (same as its
 * other stats) — no separate per-pawn snapshot to keep in sync.
 */
router.post('/rules/monstres/:id/image', requireGm, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucune image fournie' });
    const result = await pool.query(
      'UPDATE rules_monstres SET image_url = $1 WHERE id = $2 RETURNING *',
      [`/uploads/${req.file.filename}`, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Monstre non trouvé' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error POST rules/monstres/:id/image:', error.message);
    res.status(500).json({ error: "Erreur lors de l'upload" });
  }
});

export default router;
