import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import pool from '../db/pool.js';
import { authenticateToken, requireGm } from '../middleware/auth.js';
import { mediaUpload as upload, UPLOADS_DIR } from '../services/uploads.js';

const router = Router();
router.use(authenticateToken);

/**
 * GET /board-media — GM only. Lists the reusable media library (images, videos, audio tracks),
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
 * POST /board-media — GM only, multipart field "file", optional field "kind". Uploads an image,
 * mp4 video, or audio track into the library and returns the created record; the caller still
 * has to PATCH a board's background_url/background_type (image/video), music_url (audio), or
 * handout_url (handout) to actually use it.
 * kind: 'handout' tags a plain image as a document to show players, kept in its own bucket
 * separate from 'image' backgrounds — the mimetype alone can't say which one an image is for,
 * so the uploader (which panel the GM used) has to say. Ignored for video/audio, which are only
 * ever backgrounds/ambiance.
 */
router.post('/board-media', requireGm, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier fourni' });

    const type = req.file.mimetype.startsWith('video/') ? 'video'
      : req.file.mimetype.startsWith('audio/') ? 'audio'
      : req.body.kind === 'handout' ? 'handout' : 'image';
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
