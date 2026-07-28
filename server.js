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

app.use(helmet({
  contentSecurityPolicy: false, // keep simple for local/demo use; tighten before real production use
}));
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());

// Stripe webhook needs the raw, untouched request body to verify its
// signature -- must be mounted before express.json() below.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), require('./routes/billing').webhookHandler);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// General API rate limit -- generous enough not to affect normal use, but
// stops unbounded scripted abuse of any endpoint. /api/auth/* has its own
// stricter limiter on top of this (see routes/auth.js).
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Lazily initialize the database (create tables + seed demo data if empty).
// Memoized so it only actually runs once per running process -- this covers
// both `node server.js` locally and a serverless cold start on Vercel.
let dbReadyPromise = null;
app.use((req, res, next) => {
  if (!dbReadyPromise) dbReadyPromise = seed();
  dbReadyPromise.then(() => next()).catch(next);
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Legacy bookmark/link compatibility -- the previous hand-written frontend
// used /portal.html as its app-shell URL; the new SPA's equivalent is /portal.
app.get('/portal.html', (req, res) => res.redirect(301, '/portal'));

// Everything else that isn't an API route or a real static asset falls back
// to the SPA shell, and react-router (client-side) takes it from there.
// Must come after express.static() above so real files (JS/CSS bundles,
// images, favicon) are still served directly instead of hitting this.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// Only actually bind to a port when run directly (local dev). On Vercel, the
// exported `app` is wrapped by api/index.js and invoked per-request instead.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`EthixWeb CRM running at http://localhost:${PORT}`);
  });
}

module.exports = app;
