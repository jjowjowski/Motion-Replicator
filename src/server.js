'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');

const { config, requireConfig } = require('./config');
const db = require('./db');
const { migrate } = require('./migrate');
const auth = require('./auth');
const tasksRouter = require('./routes/tasks');
const scheduleRouter = require('./routes/schedule');
const googleRoutes = require('./routes/google');

function createApp() {
  const app = express();

  // Railway terminates TLS at its proxy; trust it so secure cookies work.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          manifestSrc: ["'self'"],
          workerSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.isProduction ? [] : null,
        },
      },
      hsts: config.isProduction,
    }),
  );

  app.use(express.json({ limit: '100kb' }));

  app.use(
    session({
      name: 'mr.sid',
      store: new PgSession({ pool: db.getPool(), tableName: 'session', createTableIfMissing: false }),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: config.isProduction,
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      },
    }),
  );

  app.get('/healthz', async (req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true });
  });

  // Auth
  app.use('/api', auth.requireSameOriginJson);
  app.get('/api/me', (req, res) => res.json({ authenticated: auth.isAuthenticated(req) }));
  app.post('/api/login', auth.login);
  app.post('/api/logout', auth.logout);

  // Google OAuth
  app.use(googleRoutes.pages);
  app.use('/api/google', googleRoutes.api);

  // App API
  app.use('/api/tasks', auth.requireAuth, tasksRouter);
  app.use('/api/schedule', auth.requireAuth, scheduleRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Static PWA shell. Contains no data; everything sensitive is behind /api.
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      setHeaders(res, filePath) {
        if (filePath.endsWith('sw.js') || filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Errors from Google's API carry Google's HTTP status; report them as a
    // bad gateway so e.g. a Google 401 is not mistaken for "not logged in".
    const fromGoogle = err.name === 'GaxiosError' || Boolean(err.response && err.config);
    const status = fromGoogle ? 502 : err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const message = fromGoogle
      ? `Google Calendar error: ${err.message}`
      : status >= 500 && !err.status
        ? 'Internal server error'
        : err.message;
    if (req.path.startsWith('/api')) return res.status(status).json({ error: message });
    res.status(status).type('text').send(message);
  });

  return app;
}

async function main() {
  requireConfig(['databaseUrl', 'appPassword', 'sessionSecret', 'tokenEncryptionKey']);
  await migrate();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`Motion Replicator listening on port ${config.port} (${config.baseUrl})`);
  });
  const shutdown = () => {
    server.close(() => db.close().then(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createApp };
