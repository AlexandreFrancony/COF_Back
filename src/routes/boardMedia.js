import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import pool from '../db/pool.js';
import { authenticateToken, requireGm } from '../middleware/auth.js';

const router = Router();
router.use(authenticateToken);

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Separate from board.js's image-only uploader (token portraits): the media library also
// accepts mp4 ambiance videos, which need a much higher size limit than a token/background image.
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^(image\/(png|jpe?g|webp|gif)|video\/mp4)$/.test(file.mimetype)) {
      return cb(new Error('Format non supporté (image ou vidéo mp4 uniquement)'));
    }
    cb(null, true);
  },
});

/**
 * GET /board-media — GM only. Lists the reusable background library (images + videos),
 * newest first, so a GM can pick a fond/ambiance already uploaded instead of re-uploading it.
 */
router.get('/board-media', requireGm, async (req, res) => {
  try {
    const media = await pool.query('SELECT * FROM board_media ORDER BY created_at DESC');
    res.json(media.rows);
  } catch (error) {
    console.error('Error GET board-media:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /board-media — GM only, multipart field "file". Uploads an image or mp4 video into
 * the library and returns the created record; the caller still has to PATCH a board's
 * background_url/background_type to actually use it.
 */
router.post('/board-media', requireGm, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier fourni' });

    const type = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    const url = `/uploads/${req.file.filename}`;
    const label = req.body.label || req.file.originalname;

    const created = await pool.query(
      'INSERT INTO board_media (type, url, label) VALUES ($1, $2, $3) RETURNING *',
      [type, url, label]
    );
    res.status(201).json(created.rows[0]);
  } catch (error) {
    console.error('Error POST board-media:', error.message);
    res.status(500).json({ error: "Erreur lors de l'upload" });
  }
});

/**
 * DELETE /board-media/:id — GM only. Removes the library entry and its file on disk.
 * Boards already using this URL as their background keep working (the URL string itself
 * stays valid until the file is gone) — this only removes it from future picks.
 */
router.delete('/board-media/:id', requireGm, async (req, res) => {
  try {
    const existing = await pool.query('DELETE FROM board_media WHERE id = $1 RETURNING url', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Média non trouvé' });

    const filePath = path.join(UPLOADS_DIR, path.basename(existing.rows[0].url));
    fs.unlink(filePath, () => {});
    res.json({ message: 'Média supprimé' });
  } catch (error) {
    console.error('Error DELETE board-media:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
