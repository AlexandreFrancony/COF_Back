# COF - Site MJ (Backend)

API Express pour l'outil de maître du jeu Chroniques Oubliées Fantasy. Voir [CLAUDE.md](./CLAUDE.md) pour l'architecture détaillée.

## Développement

```bash
npm install
cp .env.example .env   # renseigner DATABASE_URL et JWT_SECRET
npm run dev
```

## Base de données

Le schéma est dans [`db/schema.sql`](./db/schema.sql). En local, créez une base Postgres et appliquez-le :

```bash
psql "$DATABASE_URL" -f db/schema.sql
```
