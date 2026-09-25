# COF - Site MJ (Backend)

## Project Overview

Express.js REST API pour l'outil de gestion de sessions de jeu de rôle (Chroniques Oubliées Fantasy). Gère les comptes (MJ/joueurs), les campagnes, les personnages et le référentiel de règles COF2.

## Architecture

Projet split en 2 repos :
- **COF_Back** (ce repo) : API Express
- **COF_Front** : Frontend React

Pas de repo DB séparé — le schéma vit dans `db/schema.sql` de ce repo.

## Tech Stack

- **Runtime** : Node.js 20 (Alpine)
- **Framework** : Express.js (ESM)
- **Base de données** : PostgreSQL centralisée (via `pg`, SQL brut, pas d'ORM)
- **Auth** : JWT + bcrypt, rôles `gm` / `player`

## Structure

```
COF_Back/
├── db/
│   └── schema.sql          # Schéma complet (users, campagnes, persos, référentiel de règles)
├── src/
│   ├── index.js            # Entrée, app Express
│   ├── db/pool.js          # Pool PostgreSQL
│   ├── middleware/
│   │   ├── auth.js         # JWT (authenticateToken, requireGm, generateToken)
│   │   └── rateLimiter.js
│   └── routes/
│       └── auth.js         # /auth/login, /auth/me
```

## Modèle de comptes

Pas d'inscription publique ouverte. Le MJ crée une campagne + une fiche de personnage, génère un lien d'invitation (`campaign_invites`), et le joueur crée son compte en acceptant l'invitation (route à venir : `POST /invites/:token/accept`). Le compte MJ est créé manuellement en base au bootstrap (un seul MJ, pas de multi-tenant).

## Référentiel de règles COF2

Les tables `rules_familles`, `rules_profils`, `rules_peuples`, `rules_voies`, `rules_capacites`, `rules_sorts` sont la source de vérité pour les calculs (PV, PM, défense, initiative...). Elles sont vides au départ et remplies progressivement à partir de `COF2-RèglesBasiques.pdf`, en commençant par les profils/peuples déjà utilisés par les PJ des campagnes en cours (Osgild, Akilène) pour valider le modèle sur des cas réels.

## Variables d'environnement

| Variable | Description | Défaut |
|----------|-------------|--------|
| PORT | Port de l'API | 3001 |
| DATABASE_URL | Connexion PostgreSQL | - |
| JWT_SECRET | Secret de signature JWT | - |
| JWT_EXPIRES_IN | Durée de validité du token | 30d |
| FRONTEND_URL | URL du frontend (CORS prod) | https://jdr.francony.fr |
| SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / SMTP_FROM | Envoi d'email (mot de passe oublié) — mailbox OVH `tipsy@francony.fr`, partagée avec Bartending | - |
| DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / DISCORD_REDIRECT_URI | Connexion « Se connecter avec Discord » — application Discord **Torgal** (depuis 2026-09-25) | - |
| BOT_API_TOKEN | Jeton partagé avec le bot Torgal pour `/bot/*` (en-tête `Authorization: Bot <jeton>`) ; absent = API bot désactivée (503) | - |

> Toute nouvelle variable doit aussi être listée dans le bloc `environment:` du service `api` de `Infra/compose/cof.yml`, sinon `cof.env` ne suffit pas.

## API du bot Discord (Torgal)

`/bot/*` est monté avant les routeurs `/` (même raison que `sseStreams.js`). Chaque appel agit au nom de l'utilisateur Discord qui a lancé la commande, avec exactement ses droits sur le site, retrouvé via `users.discord_id` (lié sur `/compte`).
- `GET /bot/characters?discord_id=` — ses personnages + ceux des campagnes dont il est MJ (404 `not_linked` si aucun compte lié)
- `GET /bot/characters/:id?discord_id=` — fiche en lecture seule (même règle d'accès que `GET /characters/:id`, 404 si non accessible)

## Commandes

```bash
npm install
npm run dev      # hot reload
npm start        # production
docker-compose up -d
```
