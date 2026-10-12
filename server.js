'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const { seed } = require('./db/setup');

const app = express();
const PORT = process.env.PORT || 4000;

/**
 * The settings without which this application is quietly wrong, checked before
 * anything else happens.
 *
 * At import rather than in the `app.listen` branch below, because on Vercel
 * nothing calls `listen`: the function imports this file and handles a
 * request. Every boot warning in that branch has therefore never run in the
 * environment it was written for. In production a missing setting throws and
 * fails the deployment, which is the only place a configuration mistake can be
 * caught by somebody who can fix it. See utils/bootConfig.js.
 */
require('./utils/bootConfig').verify();

/**
 * Catch what escapes every try/catch.
 *
 * This codebase starts a lot of work with `void somethingAsync()` so that
 * nobody waits on an email, and an unhandled rejection in one of those is
 * otherwise a line Node prints on its way out. Installed at import, which on a
 * serverless platform is the only moment that reliably happens.
 */
require('./utils/errorReporter').install();

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
      frameAncestors: ["'none'"], // nobody embeds this app, not even us
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  // DENY rather than helmet's SAMEORIGIN default. Nothing in this application
  // frames anything of its own, so the stricter value costs nothing and closes
  // the clickjacking surface on the login page for browsers that read the
  // header and not the CSP.
  frameguard: { action: 'deny' },
  // A year, which is what every preload list asks for; helmet's default is
  // 180 days.
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
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

/**
 * Nothing may touch the database until the schema exists and the first boot has
 * finished. Defined here rather than mounted inline further down because the
 * webhooks below need the same guarantee: on a serverless platform a cold boot
 * can begin with a Twilio POST, and a handler that reads a table before this has
 * run finds nothing there.
 */
let dbReadyPromise = null;
function dbReady(req, res, next) {
  if (!dbReadyPromise) {
    dbReadyPromise = seed()
      // A workspace with admins but no super admin has nobody who can appoint
      // one, so the first boot after this feature shipped elects the
      // longest-standing admin (or SUPER_ADMIN_EMAIL, when it is set).
      .then(() => require('./utils/roles').ensureSuperAdmin())
      // Watches client Slack channels and pushes changes down the live
      // wire, so no browser has to poll Slack for itself.
      .then(() => require('./utils/slackWatch').start())
      // Says out loud whether the SMS bridge can actually do its job -- a
      // missing scope or an uninvited bot is otherwise completely silent, and
      // looks identical to "no texts have come in yet". Never fatal: the rest
      // of the app has no business failing to start over it.
      .then(() => require('./utils/smsBridgePreflight').reportAtBoot().catch(() => null))
      .catch((err) => {
        dbReadyPromise = null;
        throw err;
      });
  }
  dbReadyPromise.then(() => next(), next);
}

app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), require('./routes/billing').webhookHandler);

// Twilio posts form-encoded, and signs the parsed fields -- so this needs its
// own parser ahead of express.json(), for the same reason the Stripe line above
// needs a raw one. Nothing may consume the body before the signature check.
app.post(
  '/api/sms/webhook',
  express.urlencoded({ extended: false, limit: '256kb' }),
  dbReady,
  require('./routes/sms').webhookHandler,
);

// What became of a message we sent. Signed and parsed exactly like the line
// above, but against its own URL -- Twilio signs the address it called.
app.post(
  '/api/sms/status',
  express.urlencoded({ extended: false, limit: '256kb' }),
  dbReady,
  require('./routes/sms').statusHandler,
);

// Slack posts JSON and signs the exact bytes it sent, so this needs the raw
// body too -- same reasoning as the two webhooks above, ahead of express.json().
app.post(
  '/api/slack/events',
  express.raw({ type: 'application/json', limit: '256kb' }),
  dbReady,
  require('./routes/slackEvents').eventsHandler,
);

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

/**
 * The ceiling on ordinary API traffic.
 *
 * Counted per session where there is one, and per IP otherwise. By IP alone an
 * office behind a single address shared one budget between everybody in it,
 * and in the browser test one admin hit 429s after about sixty-five page
 * views and was dropped to the login screen -- a rate limit that logs your own
 * staff out is a denial of service you are running against yourself.
 *
 * A signed-in request also gets a much higher ceiling than an anonymous one.
 * This limiter exists to blunt scraping and brute force, and both of those
 * arrive without a session; the strict limits that actually matter are on the
 * auth routes, where they are counted per account.
 *
 * Note this is still a per-instance memory store: see utils/rateLimits.js for
 * why that is weaker than it looks on Vercel, and what the auth routes do
 * about it.
 */
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: (req) => (req.cookies?.ew_sid ? 3000 : 300),
  // The session, so one person's heavy afternoon is their own budget and not
  // their colleagues'. Falling back to the IP for anybody with no session at
  // all, which is who this limit is really for.
  keyGenerator: (req) => {
    // Hashed, not the cookie itself: a rate-limit key lives in this process's
    // memory and gets printed in diagnostics, and the cookie is a live
    // credential. Truncated because a limiter key only has to be unique.
    const sid = req.cookies?.ew_sid;
    if (!sid) return `ip:${req.ip}`;
    return `sid:${crypto.createHash('sha256').update(sid).digest('hex').slice(0, 32)}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Give it a minute and try again.' },
}));

app.use(dbReady);

// Every successful write nudges the open browsers on the live wire. Mounted
// before the routers so the finish handler is in place when they reply.
app.use(require('./middleware/live').broadcastChanges);

// Ordinary traffic drives the outbound queue.
//
// On a platform where no process is guaranteed to live between requests, a
// timer at boot is not a scheduler, so the sweep has to be able to ride on a
// request. Mounted here rather than inside one router because it is not any
// one page's business: whichever request happens to arrive first after a
// message came due is the one that sends it.
//
// Deliberately not awaited -- the reply must not wait on an SMTP handshake --
// and throttled to once a minute inside `maybeSweep`, with an in-flight guard,
// so a busy dashboard cannot start a second one. The atomic claim in
// utils/outbox.js is what makes it safe for two *processes* to race here.
app.use('/api', (req, res, next) => {
  void require('./utils/outbox').maybeSweep();
  // And the monthly service summaries, on the same principle and for the same
  // reason: a deployment that never set up the cron should still send them.
  // Throttled to once an hour and a no-op after the tenth of the month, so on
  // the other twenty days of the year this costs one comparison.
  void require('./utils/serviceDigest').maybeSweep();
  // And requests a client held until their allowance reset: one that lands
  // and nobody picks up is worse than having refused it. Throttled to once a
  // minute inside maybeSweep, so on ordinary traffic this is one comparison.
  void require('./utils/updateRequests').maybeSweep();
  // And the reminder that a multi-month plan renews in a week. Throttled to
  // once an hour inside the sweep: a renewal seven days out does not get
  // closer any faster than that.
  void require('./utils/subscriptions').maybeSweepRenewals();
  next();
});

app.use('/api/events', require('./routes/events'));
app.use('/api/config', require('./routes/config'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/sms', require('./routes/sms'));
app.use('/api/domains', require('./routes/domains'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/budget', require('./routes/budget'));
app.use('/api/billing', require('./routes/billing'));
// The plan catalogue, and what one client's membership currently unlocks. Kept
// separate from /api/billing because that router is Stripe's mirror and is
// gated on the Billing page being switched on, and neither is true of these.
app.use('/api/plans', require('./routes/plans'));
app.use('/api/membership', require('./routes/membership'));
// Backups, uptime, security, SEO, performance, plugin updates and health
// checks: one record shape behind seven panels, each gated on its own
// entitlement. See routes/siteRecords.js.
app.use('/api/site-records', require('./routes/siteRecords'));
app.use('/api/integrations', require('./routes/integrations'));
app.use('/api/mail', require('./routes/mail'));
app.use('/api/client', require('./routes/client'));
app.use('/api/approvals', require('./routes/approvals'));
app.use('/api/credentials', require('./routes/credentials'));
app.use('/api/outbox', require('./routes/outbox'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/portal.html', (req, res) => res.redirect(301, '/portal'));

/**
 * An API path nobody routed is a 404 in JSON, not the app's HTML.
 *
 * Everything under /api is answered by a router above. Anything still here is
 * a path that does not exist, and it used to fall through to the single-page
 * app -- so a typo'd endpoint, or a client calling a route that was renamed,
 * came back as 200 with a page of HTML. Every caller then failed at
 * `JSON.parse`, somewhere far away from the cause.
 */
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} /api${req.path}` });
});

/**
 * Paths that are not this application's, answered as what they are.
 *
 * Every non-API path returned the app page with status 200, `/.env` and
 * `/.git/config` included. Nothing was leaked -- the response is the same
 * HTML everybody gets -- but a scanner reads 200 as "this file exists" and
 * flags the deployment, and a person reading the report then has to prove it
 * is nothing. Saying 404 to a request for a file we do not serve is both true
 * and quieter.
 */
const NOT_OURS = /^\/(\.|wp-|wordpress|xmlrpc\.php|vendor\/|phpmyadmin|admin\.php|config\.(json|yml|yaml|php)$|backup|\.well-known\/security\.txt$)/i;

app.get(/^\/(?!api\/).*/, (req, res) => {
  if (NOT_OURS.test(req.path)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  // The document naming this deploy's hashed bundles. Revalidated every time,
  // so a deploy reaches a returning visitor on their next load.
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * The last handler. Reports the failure somewhere a person looks, then answers
 * the same generic 500 it always did.
 *
 * `console.error(err)` was the whole of this, which on a serverless platform
 * means a line in a log nobody opens -- so the first person to learn about a
 * broken deploy was a client, by telephone. See utils/errorReporter.js: it
 * still writes to the console, and posts to ERROR_WEBHOOK_URL when one is set.
 */
app.use(require('./utils/errorReporter').middleware);

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
    // The outbound queue. Traffic drives it too, but a message that came due
    // at 3am on a quiet workspace should not wait for the first person to
    // sign in -- which, without this, is exactly what it would do.
    require('./utils/outbox').startTimer();
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
    // The three settings that decide whether a client's email arrives looking
    // like a real message or like a broken one. Each is silent when wrong --
    // the send succeeds, the inbox shows the damage -- so they are named at
    // boot rather than discovered by a customer.
    require('./utils/mailAutomation').warnIfRisky();
  });
}

module.exports = app;
