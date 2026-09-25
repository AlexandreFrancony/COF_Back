import { Router } from 'express';
import crypto from 'crypto';
import pool from '../db/pool.js';
import { canAccessCharacter, getCharacterWithVoies } from './characters.js';

// Server-to-server API for Torgal, the Discord bot. Each call acts on behalf of the Discord
// user who ran the command, with exactly that user's rights on the site: the user is resolved
// from the discord_id they linked on /compte, never trusted from anything else in the request.
const router = Router();

function requireBotToken(req, res, next) {
  const expected = process.env.BOT_API_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Bot API disabled' });

  const [scheme, token = ''] = (req.headers.authorization || '').split(' ');
  const given = Buffer.from(token);
  const wanted = Buffer.from(expected);
  if (scheme !== 'Bot' || given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    return res.status(401).json({ error: 'Invalid bot token' });
  }
  next();
}

router.use(requireBotToken);

async function findLinkedUser(discordId) {
  if (!discordId) return null;
  const result = await pool.query(
    'SELECT id, role, display_name FROM users WHERE discord_id = $1',
    [discordId]
  );
  return result.rows[0] || null;
}

/**
 * GET /bot/characters?discord_id=
 * Characters that user can see: their own, plus every character of the campaigns they GM
 * (same visibility as the site). 404 not_linked if no account has this Discord ID.
 */
router.get('/characters', async (req, res) => {
  try {
    const user = await findLinkedUser(req.query.discord_id);
    if (!user) return res.status(404).json({ error: 'not_linked' });

    const result = await pool.query(
      `SELECT c.id, c.name, c.level, c.is_npc, k.name AS campaign_name, (c.user_id = $1) AS owned
       FROM characters c JOIN campaigns k ON k.id = c.campaign_id
       WHERE c.user_id = $1 OR ($2 AND k.gm_id = $1)
       ORDER BY (c.user_id = $1) DESC, k.name, c.name`,
      [user.id, user.role === 'gm']
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error GET /bot/characters:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /bot/characters/:id?discord_id=
 * Read-only sheet, same access rule as GET /characters/:id. Answers 404 rather than 403 when
 * the character exists but isn't theirs, so the bot can't be used to probe other sheets.
 */
router.get('/characters/:id', async (req, res) => {
  try {
    const user = await findLinkedUser(req.query.discord_id);
    if (!user) return res.status(404).json({ error: 'not_linked' });
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Personnage non trouvé' });

    const character = await getCharacterWithVoies(req.params.id);
    if (!character || !(await canAccessCharacter(character, user))) {
      return res.status(404).json({ error: 'Personnage non trouvé' });
    }

    const names = await pool.query(
      `SELECT (SELECT name FROM rules_profils WHERE id = $1) AS profil_name,
              (SELECT name FROM rules_peuples WHERE id = $2) AS peuple_name,
              (SELECT name FROM campaigns WHERE id = $3) AS campaign_name`,
      [character.profil_id, character.peuple_id, character.campaign_id]
    );
    // Capacité texts are long and the embed only lists voies with their rang
    const voies = character.voies.map(({ capacites, ...voie }) => voie);
    res.json({ ...character, ...names.rows[0], voies });
  } catch (error) {
    console.error('Error GET /bot/characters/:id:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
