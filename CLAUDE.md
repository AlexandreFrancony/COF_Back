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
| FRONTEND_URL | URL du frontend (CORS prod) | https://mj.francony.fr |

## Commandes

```bash
npm install
npm run dev      # hot reload
npm start        # production
docker-compose up -d
```
