'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const compression = require('compression');
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
      manifestSrc: ["'self'"],
      workerSrc: ["'self'"], // the offline shell service worker, nothing else
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"], // no embedding this app in someone else's page
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
}));

// A named list only. `*` is refused outright rather than quietly passed to the
// cors package: paired with `credentials: true` it would let any site on the
// internet make authenticated admin requests with the reader's own cookie.
const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((origin) => {
    if (origin === '*') {
      console.warn('[cors] CORS_ORIGINS contains "*", which cannot be combined with credentials. Ignoring it.');
      return false;
    }
    return true;
  });
if (corsOrigins.length > 0) {
  app.use(cors({ origin: corsOrigins, credentials: true }));
}

app.use(cookieParser());

// Gzip/brotli-negotiated compression for every response this server sends --
// JSON API payloads and static assets alike. Vite's own hashed output is
// already minified but not compressed on disk, so this is the only place
// that shrinks it in transit.
app.use(compression());

// Emails carry absolute links and the emblem from public/. When APP_BASE_URL
// is not set, the first request teaches the app what its own origin is.
const appUrl = require('./utils/appUrl');
app.use((req, res, next) => {
  appUrl.rememberFromRequest(req);
  next();
});

app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), require('./routes/billing').webhookHandler);

app.use(express.json({ limit: '2mb' }));

// A body the parser could not read is a bad request, not a server fault. It
// used to fall through to the catch-all below and answer 500, which says "we
// broke" about something the caller did -- and buries real faults in noise.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'That request body is not valid JSON.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That request body is too large.' });
  }
  return next(err);
});

/**
 * How long the browser may keep each kind of static file.
 *
 * Without this every asset carries no Cache-Control, so a returning visitor
 * revalidates the whole bundle on every load -- a round trip per file to be
 * told nothing changed. The build already names its output by content hash, so
 * those files can be kept for a year and never asked about again; a deploy
 * changes the name, not the contents of a name.
 *
 * The two files that must never be cached that way are the ones that point at
 * the hashed names: index.html and the service worker. Cache either of them and
 * a deploy is invisible to anyone who has been here before.
 */
function staticCacheControl(filePath) {
  const name = path.basename(filePath);
  if (name === 'index.html' || name === 'sw.js') return 'no-cache';
  // Vite writes /assets/<name>-<hash>.<ext>; the hash is the version.
  if (filePath.includes(`${path.sep}assets${path.sep}`)) return 'public, max-age=31536000, immutable';
  if (name === 'manifest.webmanifest') return 'public, max-age=3600';
  // Brand artwork and icons: named by hand, so they can be replaced in place.
  // A day is long enough to stop the repeat requests and short enough that a
  // new logo is not stuck on somebody's phone for a week.
  return 'public, max-age=86400';
}

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', staticCacheControl(filePath));
    // Helmet defaults every response to Cross-Origin-Resource-Policy:
    // same-origin, which is right for the app bundle but wrong for the brand
    // artwork: it is embedded by email clients and by the Mail page preview,
    // both of which are a different origin. Only these files opt out.
    if (['ethixweb.png', 'emblem-mark.png'].includes(path.basename(filePath))) {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
  },
}));

// Signed-in answers are held in the tab's memory by React Query, which is
// where the speed comes from -- see frontend/src/lib/queryCache.ts. None of it
// belongs in the browser's own on-disk cache, where it would outlive the
// session and be readable by the next person to pick the laptop up. Saying so
// explicitly also stops a proxy in the middle from deciding for itself: without
// a Cache-Control header, a shared cache is free to apply its own heuristic to
// a 200 that has no expiry, and one client's invoices are not a page it should
// ever be guessing about.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
}));

let dbReadyPromise = null;
app.use((req, res, next) => {
  if (!dbReadyPromise) {
    dbReadyPromise = seed()
      // A workspace with admins but no super admin has nobody who can appoint
      // one, so the first boot after this feature shipped elects the
      // longest-standing admin (or SUPER_ADMIN_EMAIL, when it is set).
      .then(() => require('./utils/roles').ensureSuperAdmin())
      // Watches client Slack channels and pushes changes down the live
      // wire, so no browser has to poll Slack for itself.
      .then(() => require('./utils/slackWatch').start())
      .catch((err) => {
        dbReadyPromise = null;
        throw err;
      });
  }
  dbReadyPromise.then(() => next(), next);
});

// Every successful write nudges the open browsers on the live wire. Mounted
// before the routers so the finish handler is in place when they reply.
app.use(require('./middleware/live').broadcastChanges);

app.use('/api/events', require('./routes/events'));
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
app.use('/api/mail', require('./routes/mail'));
app.use('/api/client', require('./routes/client'));
app.use('/api/approvals', require('./routes/approvals'));
app.use('/api/credentials', require('./routes/credentials'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/portal.html', (req, res) => res.redirect(301, '/portal'));

app.get(/^\/(?!api\/).*/, (req, res) => {
  // The document naming this deploy's hashed bundles. Revalidated every time,
  // so a deploy reaches a returning visitor on their next load.
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`EthixWeb CRM running at http://localhost:${PORT}`);
    // A real process is alive here, so the scheduled work can have a real
    // timer. Deliberately only in this branch: importing the app -- which is
    // what the serverless entrypoint and the test suites do -- must never
    // start a timer nobody is going to stop. On a platform with no long-lived
    // process the same sweeps still run, driven by traffic and by the Mail
    // page's run button. Both timers are unref'd, so neither holds the process
    // open on its own.
    require('./utils/credentialScheduler').startTimer();
    require('./utils/passwordWatch').startTimer();
    // Sign-in codes go out by email. With no transport configured, a client
    // cannot sign in without an admin reading a code out of the Login Codes
    // page -- which is the fallback, not the plan. Say so loudly at boot
    // rather than letting the first client discover it.
    appUrl.warnIfUnset();
    if (!require('./utils/mailer').isEnabled()) {
      console.warn(
        '[mail] No mail transport is configured, so sign-in codes cannot be delivered. ' +
          'Clients will be stuck waiting on an admin. Set SMTP2GO_API_KEY (or SMTP_*, or MAIL_WEBHOOK_URL) in .env.',
      );
      console.warn(
        '[mail] Administrators now sign in with a password AND an emailed code, like everyone else. ' +
          'Without a transport they cannot complete a sign-in either. Configure mail before restarting in production.',
      );
    }
  });
}

module.exports = app;
