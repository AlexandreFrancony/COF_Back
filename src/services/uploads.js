import path from 'path';
import fs from 'fs';
import multer from 'multer';

// Shared disk-storage multer instance for every image upload in the app (board backgrounds/
// token images, and now a bestiary entry's own image) — one uploads dir, one filename scheme,
// one file-type/size policy, instead of a second multer() config drifting out of sync with the
// first the next time an upload endpoint is added.
export const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) {
      return cb(new Error("Format d'image non supporté"));
    }
    cb(null, true);
  },
});
