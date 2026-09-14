// Login only for account creation — accounts are created via campaign invites (no open
// registration). Password reset/change reuses the OVH SMTP mailbox already configured for
// Bartending (tipsy@francony.fr) rather than provisioning a separate one for this project.
import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import pool from '../db/pool.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';
import { claimCharacter } from './invites.js';

const router = Router();
const BCRYPT_ROUNDS = 10;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

const DISCORD_API = 'https://discord.com/api/v10';
// Short-lived nonces for the two OAuth flows that need to resume server-side context after
// the browser round-trips through Discord (a GET redirect can't carry an Authorization
// header) — "login" needs nothing but proof it was us who started it, "link" also carries
// which already-logged-in user initiated it. In-memory is fine at this app's scale (a
// handful of users); worst case a rare process restart mid-flow just means redoing the click.
const discordOauthStates = new Map(); // state -> { mode: 'login' | 'link', userId?, expiresAt }
const DISCORD_STATE_TTL_MS = 5 * 60 * 1000;

function pruneDiscordStates() {
  const now = Date.now();
  for (const [key, value] of discordOauthStates) {
    if (value.expiresAt < now) discordOauthStates.delete(key);
  }
}

function buildDiscordAuthorizeUrl(state) {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', process.env.DISCORD_CLIENT_ID);
  url.searchParams.set('redirect_uri', process.env.DISCORD_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify email');
  url.searchParams.set('state', state);
  return url.toString();
}

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
      `SELECT id, email, display_name, role, created_at, discord_id, discord_username, discord_avatar_hash
       FROM users WHERE id = $1`,
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
 * PATCH /auth/display-name
 * Body: { display_name }
 * generateToken() embeds display_name in the JWT payload itself, so every existing token
 * out there would keep showing the old name (in campaign_notes.updated_by, Discord webhook
 * messages, etc. - anywhere reading req.user.display_name straight from the token) until it
 * expired. Re-issuing a fresh token here and having the caller swap it in immediately (same
 * shape as /login's response) avoids that staleness instead of just living with it.
 */
router.patch('/display-name', authenticateToken, async (req, res) => {
  try {
    const displayName = (req.body.display_name || '').trim();
    if (!displayName) {
      return res.status(400).json({ error: 'Nom d\'affichage requis' });
    }
    if (displayName.length > 100) {
      return res.status(400).json({ error: 'Nom d\'affichage trop long (100 caractères max)' });
    }

    const result = await pool.query(
      'UPDATE users SET display_name = $1 WHERE id = $2 RETURNING id, email, display_name, role',
      [displayName, req.user.id]
    );
    const user = result.rows[0];

    res.json({ user, token: generateToken(user) });
  } catch (error) {
    console.error('Error PATCH /auth/display-name:', error.message);
    res.status(500).json({ error: "Erreur lors du changement de nom" });
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
      subject: "📖 As I've Written — Réinitialisation de mot de passe",
      html: `
        <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; color: #2A2013;">
          <h2 style="color: #A9853D;">Réinitialisation de mot de passe</h2>
          <p>Bonjour <strong>${user.display_name}</strong>,</p>
          <p>Vous avez demandé à réinitialiser votre mot de passe sur As I've Written.</p>
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

/**
 * GET /auth/discord/login-init
 * Public. Returns the Discord authorize URL for "Se connecter avec Discord" — only works if
 * the resulting Discord account was already linked to a COF account beforehand.
 */
router.get('/discord/login-init', (req, res) => {
  pruneDiscordStates();
  const state = crypto.randomBytes(16).toString('hex');
  discordOauthStates.set(state, { mode: 'login', expiresAt: Date.now() + DISCORD_STATE_TTL_MS });
  res.json({ url: buildDiscordAuthorizeUrl(state) });
});

/**
 * GET /auth/discord/invite-init?token=<inviteToken>
 * Public. Returns the Discord authorize URL for "Continuer avec Discord" on an invite —
 * the invite token itself becomes the OAuth state, so no server-side nonce is needed here
 * (whoever holds the invite link already has everything they'd need to accept it anyway).
 */
router.get('/discord/invite-init', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: 'Token d\'invitation requis' });
  }
  res.json({ url: buildDiscordAuthorizeUrl(`invite:${token}`) });
});

/**
 * GET /auth/discord/link-init
 * Authenticated. Returns the Discord authorize URL to link the caller's own account.
 */
router.get('/discord/link-init', authenticateToken, (req, res) => {
  pruneDiscordStates();
  const state = crypto.randomBytes(16).toString('hex');
  discordOauthStates.set(state, { mode: 'link', userId: req.user.id, expiresAt: Date.now() + DISCORD_STATE_TTL_MS });
  res.json({ url: buildDiscordAuthorizeUrl(state) });
});

/**
 * GET /auth/discord/callback
 * Public — Discord redirects here after the user authorizes (or declines). Three cases based
 * on `state`: "invite:<token>" (accepting an invite as a brand new or returning Discord user),
 * a login-init nonce (log in an already-linked account), or a link-init nonce (attach Discord
 * to the caller who started the flow, recovered from discordOauthStates since a GET redirect
 * can't carry their Authorization header). Every branch ends in a redirect back to the SPA —
 * there's no JSON response here for anything to consume.
 */
router.get('/discord/callback', async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || 'https://jdr.francony.fr';
  const { code, state, error } = req.query;

  if (error || !code || !state) {
    return res.redirect(`${frontendUrl}/login?discord=error`);
  }

  try {
    const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
      }),
    });
    if (!tokenResponse.ok) throw new Error(`Discord token exchange failed: ${tokenResponse.status}`);
    const { access_token } = await tokenResponse.json();

    const profileResponse = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!profileResponse.ok) throw new Error(`Discord profile fetch failed: ${profileResponse.status}`);
    const discordUser = await profileResponse.json();

    // --- Case 1: accepting an invite via Discord (new account, or a returning Discord user
    // adding another character to their existing account) ---
    if (state.startsWith('invite:')) {
      const inviteToken = state.slice('invite:'.length);
      const inviteResult = await pool.query(
        `SELECT * FROM campaign_invites WHERE token = $1 AND status = 'pending'`,
        [inviteToken]
      );
      if (inviteResult.rows.length === 0) {
        return res.redirect(`${frontendUrl}/invites/${inviteToken}?discord=invalid`);
      }
      const invite = inviteResult.rows[0];

      let user;
      const byDiscordId = await pool.query('SELECT * FROM users WHERE discord_id = $1', [discordUser.id]);
      if (byDiscordId.rows.length > 0) {
        user = byDiscordId.rows[0];
      } else if (!discordUser.email) {
        // identify+email was granted but Discord has no verified email on file for them.
        return res.redirect(`${frontendUrl}/invites/${inviteToken}?discord=no-email`);
      } else {
        const byEmail = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [discordUser.email]);
        if (byEmail.rows.length > 0) {
          // Same person already has a COF account under this email — attach Discord to it
          // instead of failing on the UNIQUE(email) constraint trying to create a new one.
          user = (await pool.query(
            `UPDATE users SET discord_id = $1, discord_username = $2, discord_avatar_hash = $3
             WHERE id = $4 RETURNING *`,
            [discordUser.id, discordUser.username, discordUser.avatar, byEmail.rows[0].id]
          )).rows[0];
        } else {
          // No password will ever be used to log into this account (Discord is the only way
          // in), but password_hash is NOT NULL — fill it with an unguessable value nobody knows.
          const unusedHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), BCRYPT_ROUNDS);
          user = (await pool.query(
            `INSERT INTO users (email, password_hash, display_name, role, discord_id, discord_username, discord_avatar_hash)
             VALUES ($1, $2, $3, 'player', $4, $5, $6)
             RETURNING *`,
            [discordUser.email, unusedHash, discordUser.username, discordUser.id, discordUser.username, discordUser.avatar]
          )).rows[0];
        }
      }

      await claimCharacter(user.id, invite.character_id, invite.id);
      const token = generateToken(user);
      return res.redirect(`${frontendUrl}/discord-callback?token=${token}`);
    }

    // --- Case 2 & 3: login or link, resolved from the nonce this session issued earlier ---
    pruneDiscordStates();
    const entry = discordOauthStates.get(state);
    if (!entry) {
      return res.redirect(`${frontendUrl}/login?discord=expired`);
    }
    discordOauthStates.delete(state);

    const existingOwner = await pool.query('SELECT id FROM users WHERE discord_id = $1', [discordUser.id]);

    if (entry.mode === 'login') {
      if (existingOwner.rows.length === 0) {
        return res.redirect(`${frontendUrl}/login?discord=not-linked`);
      }
      const user = (await pool.query('SELECT * FROM users WHERE id = $1', [existingOwner.rows[0].id])).rows[0];
      const token = generateToken(user);
      return res.redirect(`${frontendUrl}/discord-callback?token=${token}`);
    }

    // mode === 'link'
    if (existingOwner.rows.length > 0 && existingOwner.rows[0].id !== entry.userId) {
      return res.redirect(`${frontendUrl}/compte?discord=taken`);
    }
    await pool.query(
      'UPDATE users SET discord_id = $1, discord_username = $2, discord_avatar_hash = $3 WHERE id = $4',
      [discordUser.id, discordUser.username, discordUser.avatar, entry.userId]
    );
    return res.redirect(`${frontendUrl}/compte?discord=linked`);
  } catch (error) {
    console.error('Error GET /auth/discord/callback:', error.message);
    return res.redirect(`${frontendUrl}/login?discord=error`);
  }
});

export default router;
