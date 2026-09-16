import path from 'path';
import fs from 'fs';
import multer from 'multer';

export const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Every upload endpoint in the app shares this disk-storage/filename scheme — only the
// file-type allowlist and size limit actually differ per use case (a small token portrait vs.
// a multi-minute mp4/audio ambiance track), so those are the only knobs a caller supplies.
function createUploader({ mimeTypePattern, mimeTypeErrorMessage, fileSize }) {
  return multer({
    storage: multer.diskStorage({
      destination: UPLOADS_DIR,
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
      },
    }),
    limits: { fileSize },
    fileFilter: (req, file, cb) => {
      if (!mimeTypePattern.test(file.mimetype)) return cb(new Error(mimeTypeErrorMessage));
      cb(null, true);
    },
  });
}

// Token/monster portraits — small, images only.
export const upload = createUploader({
  mimeTypePattern: /^image\/(png|jpe?g|webp|gif)$/,
  mimeTypeErrorMessage: "Format d'image non supporté",
  fileSize: 10 * 1024 * 1024,
});

// Board media library — images, mp4 ambiance video, and audio tracks; a much higher size cap
// than a portrait needs.
export const mediaUpload = createUploader({
  mimeTypePattern: /^(image\/(png|jpe?g|webp|gif)|video\/mp4|audio\/(mpeg|mp3|ogg|wav|x-wav))$/,
  mimeTypeErrorMessage: 'Format non supporté (image, vidéo mp4 ou audio mp3/ogg/wav)',
  fileSize: 200 * 1024 * 1024,
});
