'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const { seed } = require('./db/setup');

const app = express();
const PORT = process.env.PORT || 4000;

if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

const firebaseAuthDomain = process.env.FIREBASE_AUTH_DOMAIN;
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://accounts.google.com', 'https://apis.google.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: [
        "'self'",
        'https://identitytoolkit.googleapis.com',
        'https://securetoken.googleapis.com',
        'https://www.googleapis.com',
      ].concat(firebaseAuthDomain ? [`https://${firebaseAuthDomain}`] : []),
      frameSrc: ["'self'", 'https://accounts.google.com']
        .concat(firebaseAuthDomain ? [`https://${firebaseAuthDomain}`] : []),
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"], // no embedding this app in someone else's page
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
}));

const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (corsOrigins.length > 0) {
  app.use(cors({ origin: corsOrigins, credentials: true }));
}

app.use(cookieParser());

app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), require('./routes/billing').webhookHandler);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
}));

let dbReadyPromise = null;
app.use((req, res, next) => {
  if (!dbReadyPromise) {
    dbReadyPromise = seed().catch((err) => {
      dbReadyPromise = null;
      throw err;
    });
  }
  dbReadyPromise.then(() => next(), next);
});

app.use('/api/config', require('./routes/config'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/domains', require('./routes/domains'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/budget', require('./routes/budget'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/integrations', require('./routes/integrations'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/portal.html', (req, res) => res.redirect(301, '/portal'));

app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`EthixWeb CRM running at http://localhost:${PORT}`);
  });
}

module.exports = app;
