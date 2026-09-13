import 'dotenv/config';

import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import pool, { testConnection } from './db/pool.js';
import { apiLimiter, authLimiter } from './middleware/rateLimiter.js';

import authRouter from './routes/auth.js';
import campaignsRouter from './routes/campaigns.js';
import invitesRouter from './routes/invites.js';
import charactersRouter from './routes/characters.js';
import rulesRouter from './routes/rules.js';
import boardRouter from './routes/board.js';
import boardMediaRouter from './routes/boardMedia.js';
import armuresRouter from './routes/armures.js';
import armesRouter from './routes/armes.js';
import scenariosRouter from './routes/scenarios.js';
import eventsRouter from './routes/events.js';

const app = express();
const PORT = process.env.PORT || 3001;

if (!process.env.DATABASE_URL) {
  console.error('❌ ERROR: DATABASE_URL is not defined in .env');
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  console.error('❌ ERROR: JWT_SECRET is not defined in .env');
  process.exit(1);
}

// Trust reverse proxy (Pangolin/Traefik) for correct client IP detection
app.set('trust proxy', 1);

app.use(helmet());

const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? process.env.FRONTEND_URL || 'https://jdr.francony.fr'
    : true,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));

app.use(express.json());
app.use('/api', apiLimiter);
app.use('/uploads', express.static(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')));

if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

app.use('/auth', authLimiter, authRouter);
app.use('/campaigns', campaignsRouter);
app.use('/', invitesRouter); // mounts /campaigns/:id/invites and /invites/:token
// boardRouter must be mounted before charactersRouter: charactersRouter has a blanket
// router.use(authenticateToken) (mounted at '/', so it runs for every path regardless of
// whether any of its own routes match), which would otherwise 401 the board SSE stream —
// the one endpoint that authenticates via a ?token= query param instead of a header, since
// EventSource can't set one — before boardRouter's own bypass for it ever gets a chance to
// run. Same failure mode already hit once before with scenariosRouter's blanket requireGm.
app.use('/', boardRouter); // mounts /campaigns/:id/board and /board/tokens/:id
app.use('/', charactersRouter); // mounts /campaigns/:id/characters and /characters/:id
app.use('/rules', rulesRouter);
app.use('/', boardMediaRouter); // mounts /board-media
app.use('/', armuresRouter); // mounts /rules/armures
app.use('/', armesRouter); // mounts /rules/armes
app.use('/', scenariosRouter); // mounts /campaigns/:id/scenarios and /scenarios/:id
app.use('/', eventsRouter); // mounts /campaigns/:id/events

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

async function startServer() {
  try {
    const connected = await testConnection();
    if (!connected) {
      console.error('❌ Cannot start server without database connection');
      process.exit(1);
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🎲 COF API running on port ${PORT}`);
      console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
    });
  } catch (error) {
    console.error('❌ Server startup failed:', error.message);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...');
  await pool.end();
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error.message);
  process.exit(1);
});

startServer();
