// Login only for account creation — accounts are created via campaign invites (no open
// registration). Password reset/change reuses the OVH SMTP mailbox already configured for
// Bartending (tipsy@francony.fr) rather than provisioning a separate one for this project.
import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import pool from '../db/pool.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';

const router = Router();
const BCRYPT_ROUNDS = 10;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

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
 * Self-service change while logged in — see /forgot-password below for the logged-out case.
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

/**
 * POST /auth/forgot-password
 * Body: { email }
 * Always responds with a generic success message, whether or not the email matches an
 * account — otherwise the response itself would let anyone probe which emails have accounts.
 */
router.post('/forgot-password', async (req, res) => {
  const genericMessage = 'Si un compte existe avec cet email, un lien de réinitialisation a été envoyé.';
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email requis' });
    }

    const result = await pool.query(
      'SELECT id, email, display_name FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    if (result.rows.length === 0) {
      return res.json({ message: genericMessage });
    }

    const user = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await pool.query(
      'UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
      [resetTokenHash, resetTokenExpiry, user.id]
    );

    const frontendUrl = process.env.FRONTEND_URL || 'https://jdr.francony.fr';
    const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'tipsy@francony.fr',
      to: user.email,
      subject: '📖 COF — Réinitialisation de mot de passe',
      html: `
        <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; color: #2A2013;">
          <h2 style="color: #A9853D;">Réinitialisation de mot de passe</h2>
          <p>Bonjour <strong>${user.display_name}</strong>,</p>
          <p>Vous avez demandé à réinitialiser votre mot de passe sur le site MJ COF.</p>
          <p style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}"
               style="background-color: #A9853D; color: white; padding: 12px 24px;
                      text-decoration: none; border-radius: 8px; display: inline-block;">
              Réinitialiser mon mot de passe
            </a>
          </p>
          <p style="color: #6E5F45; font-size: 14px;">
            Ce lien expire dans 1 heure.<br>
            Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.
          </p>
        </div>
      `,
    });

    res.json({ message: genericMessage });
  } catch (error) {
    console.error('Error POST /auth/forgot-password:', error.message);
    res.status(500).json({ error: "Erreur lors de l'envoi de l'email" });
  }
});

/**
 * POST /auth/reset-password
 * Body: { token, password }
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Token et nouveau mot de passe requis' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()',
      [tokenHash]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Lien invalide ou expiré. Veuillez faire une nouvelle demande.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2',
      [passwordHash, result.rows[0].id]
    );

    res.json({ message: 'Mot de passe réinitialisé avec succès. Vous pouvez maintenant vous connecter.' });
  } catch (error) {
    console.error('Error POST /auth/reset-password:', error.message);
    res.status(500).json({ error: 'Erreur lors de la réinitialisation du mot de passe' });
  }
});

export default router;
