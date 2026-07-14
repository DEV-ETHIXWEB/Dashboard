'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { seed } = require('./db/setup');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(helmet({
  contentSecurityPolicy: false, // keep simple for local/demo use; tighten before real production use
}));
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Lazily initialize the database (create tables + seed demo data if empty).
// Memoized so it only actually runs once per running process -- this covers
// both `node server.js` locally and a serverless cold start on Vercel.
let dbReadyPromise = null;
app.use((req, res, next) => {
  if (!dbReadyPromise) dbReadyPromise = seed();
  dbReadyPromise.then(() => next()).catch(next);
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/notifications', require('./routes/notifications'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Anything else under /portal falls back to the SPA shell.
app.get('/portal.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
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
