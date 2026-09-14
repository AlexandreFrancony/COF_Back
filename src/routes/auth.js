// Login only for now — accounts are created via campaign invites (no open registration).
import { Router } from 'express';
import bcrypt from 'bcrypt';
import pool from '../db/pool.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';

const router = Router();
const BCRYPT_ROUNDS = 10;

/**
 * POST /auth/login
 * Body: { email, password }
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const result = await pool.query(
      `SELECT id, email, display_name, password_hash, role
       FROM users WHERE LOWER(email) = LOWER($1)`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const token = generateToken(user);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
      },
      token,
    });
  } catch (error) {
    console.error('Error POST /auth/login:', error.message);
    res.status(500).json({ error: 'Erreur lors de la connexion' });
  }
});

/**
 * GET /auth/me
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, display_name, role, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Error GET /auth/me:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * PATCH /auth/password
 * Body: { currentPassword, newPassword }
 * Self-service change only — no "forgot password" flow yet (no SMTP wired up), so a locked-out
 * player still goes through the GM to reset their password directly in the database.
 */
router.patch('/password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe requis' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 8 caractères' });
    }

    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];

    const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error PATCH /auth/password:', error.message);
    res.status(500).json({ error: 'Erreur lors du changement de mot de passe' });
  }
});

export default router;
