'use strict';

/**
 * The admin Mail page: what the app sends, what it looks like, and what
 * actually left the building.
 *
 * Admin-only. Rendered previews come straight from utils/emailMessages.js, so
 * what an admin reviews here is byte-for-byte what a client receives.
 */

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit } = require('../middleware/auth');
const mailer = require('../utils/mailer');
const messages = require('../utils/emailMessages');
const admins = require('../utils/admins');
const slaWatch = require('../utils/slaWatch');
const domainWatch = require('../utils/domainWatch');
const serviceDigest = require('../utils/serviceDigest');
const serviceLaunch = require('../utils/serviceLaunch');
const cronAuth = require('../utils/cronAuth');
const roles = require('../utils/roles');

/**
 * The monthly service summaries, for a scheduler outside the app.
 *
 * Declared above the admin guard below, and therefore deliberately outside it:
 * the caller is a cron with no session and no cookie, so it authenticates with
 * a shared secret instead -- the same one the outbox sweep uses, see
 * utils/cronAuth.js. This is the only route in this file that is not
 * admin-only, and it is placed first so that fact is visible rather than
 * buried three hundred lines down among the admin ones.
 *
 * Safe to call daily. The sweep itself decides what is actually due, sends each
 * client at most one of each summary per calendar month, and does nothing at
 * all after the tenth.
 */
async function serviceSweepCron(req, res, next) {
  if (!cronAuth.authorisedCron(req)) return res.status(401).json({ error: 'Not authorised' });
  try {
    res.status(202).json(await serviceDigest.runSweep());
  } catch (err) {
    next(err);
  }
}

// Both verbs, for the same reason the outbox sweep takes both: Vercel's cron
// fetches the path with a GET, and a POST-only endpoint would simply never run
// on the platform this app deploys to.
router.get('/cron/service-sweep', serviceSweepCron);
router.post('/cron/service-sweep', serviceSweepCron);

router.use(requireAuth, requireRole('admin'));

/** Clearing the mail log is a super admin's call -- an ordinary admin can read it, not empty it. */
function requireSuperAdmin(req, res, next) {
  if (!roles.isSuperAdmin(req.user)) {
    return res.status(403).json({ error: 'Only a super admin can delete mail log entries.' });
  }
  next();
}

router.get('/status', async (req, res, next) => {
  try {
    const inboxes = await admins.adminEmails();
    res.json({
      configured: mailer.isEnabled(),
      transport: mailer.transportName(),
      from: mailer.fromAddress(),
      adminInboxes: inboxes,
      adminCount: await admins.countAdmins(),
      extraRecipients: mailer.adminRecipients(),
      smtp: mailer.smtpSummary(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Every template, and the grouping the page draws it under.
 *
 * `groups` is sent alongside the flat list rather than instead of it: the page
 * renders the groups, and anything that wants one template by key -- the
 * preview pane, a deep link -- still has the list. Both come from the server
 * because the page used to keep its own hard-coded grouping, and every template
 * added after it was written quietly stopped being drawn.
 */
router.get('/templates', (req, res) => {
  res.json({ templates: messages.listTemplates(), groups: messages.listGroups() });
});

/** JSON preview: subject, HTML, and the plain-text twin side by side. */
/**
 * A browser cannot resolve cid: -- those only exist inside a sent message.
 * Point them at the same files on this server so the on-page preview shows
 * the artwork an inbox will actually get.
 */
function previewable(html) {
  return String(html || '')
    // Match the full asset name: hyphens ("web-corner") and digits ("bar-030")
    // both appear in it. A narrower class stops mid-name and yields a 404.
    .replace(/cid:ethixweb-icon-([a-z0-9-]+)/g, '/mail-icons/$1.png')
    .replace(/cid:ethixweb-logo/g, '/ethixweb.png');
}

/**
 * The policy the two HTML preview routes serve themselves under.
 *
 * Setting this header replaces helmet's entirely rather than adding to it, so
 * every directive these documents need has to be named here -- `frame-ancestors`
 * included. Leaving it out dropped the clickjacking guard from the only two
 * pages in the app that render stored, third-party-influenced markup.
 *
 * `img-src 'self'` matters in development: the preview loads the emblem from
 * this same origin over plain http, which an https-only img-src silently blocks.
 */
const PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: https:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

router.get('/templates/:key/preview', (req, res) => {
  const preview = messages.renderPreview(req.params.key);
  if (!preview) return res.status(404).json({ error: 'Unknown email template' });
  res.json({ ...preview, html: previewable(preview.html) });
});

/**
 * The same preview as a real HTML document, for an iframe.
 *
 * Served with a sandbox-friendly CSP of its own: the markup is generated by
 * this app, but rendering it in a frame should still be able to do nothing
 * except display text.
 */
router.get('/templates/:key/preview.html', (req, res) => {
  const preview = messages.renderPreview(req.params.key);
  if (!preview) return res.status(404).send('Unknown email template');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Content-Security-Policy', PREVIEW_CSP);
  res.send(previewable(preview.html));
});

/** Newest first. The stored HTML is dropped here to keep the list light. */
router.get('/log', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const rows = await mailer.recentLog(limit);
    res.json({
      entries: rows.map(({ html, ...rest }) => ({ ...rest, hasHtml: Boolean(html) })),
      configured: mailer.isEnabled(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Clear mail log entries so the table does not grow without bound.
 *
 * Two ways to pick what goes, matching what the Mail page offers: an explicit
 * set of ids (checked by hand), or a date range (`from`/`to`, inclusive,
 * matched against createdAt). Exactly one of the two must be given -- mixing
 * them would let a date range silently expand a hand-picked set, which is not
 * what "select these" or "select this range" separately promised.
 */
router.delete('/log', requireCSRF, requireSuperAdmin, async (req, res, next) => {
  try {
    const { ids, from, to } = req.body || {};
    const hasIds = Array.isArray(ids) && ids.length > 0;
    const hasRange = typeof from === 'string' && from && typeof to === 'string' && to;

    if (hasIds && hasRange) {
      return res.status(400).json({ error: 'Choose either specific messages or a date range, not both.' });
    }
    if (!hasIds && !hasRange) {
      return res.status(400).json({ error: 'Give either a list of message ids or a from/to date range.' });
    }

    let removed;
    let criteria;
    if (hasIds) {
      const idSet = new Set(ids.map(String));
      removed = await db.removeWhere('email_log', (e) => idSet.has(e.id));
      criteria = { mode: 'ids', count: idSet.size };
    } else {
      const fromTime = new Date(from);
      const toTime = new Date(to);
      if (Number.isNaN(fromTime.getTime()) || Number.isNaN(toTime.getTime())) {
        return res.status(400).json({ error: 'from and to must be valid dates.' });
      }
      // Inclusive of the whole "to" day, not just midnight of it.
      const fromIso = new Date(fromTime.setHours(0, 0, 0, 0)).toISOString();
      const toIso = new Date(toTime.setHours(23, 59, 59, 999)).toISOString();
      if (fromIso > toIso) return res.status(400).json({ error: 'from must not be after to.' });
      removed = await db.removeWhere('email_log', (e) => e.createdAt >= fromIso && e.createdAt <= toIso);
      criteria = { mode: 'range', from: fromIso, to: toIso };
    }

    await audit(req.user.id, 'delete', 'email_log', null, { removed, ...criteria });
    res.json({ ok: true, removed });
  } catch (err) {
    next(err);
  }
});

/** One logged message, including exactly what was rendered. */
router.get('/log/:id', async (req, res, next) => {
  try {
    const entry = await db.find('email_log', req.params.id);
    if (!entry) return res.status(404).json({ error: 'No such message' });
    res.json({ entry });
  } catch (err) {
    next(err);
  }
});

router.get('/log/:id/body.html', async (req, res, next) => {
  try {
    const entry = await db.find('email_log', req.params.id);
    if (!entry) return res.status(404).send('No such message');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Content-Security-Policy', PREVIEW_CSP);
    res.send(entry.html || '<p style="font-family:sans-serif;padding:24px;">This message was logged without a stored body.</p>');
  } catch (err) {
    next(err);
  }
});

/**
 * Check the credentials without sending anything. For SMTP this opens a real
 * connection and authenticates, so a wrong password fails here rather than
 * silently on the first ticket.
 */
router.post('/verify', requireCSRF, async (req, res, next) => {
  try {
    const result = await mailer.verifyTransport();
    await audit(req.user.id, 'update', 'email_transport', result.transport, { ok: result.ok });
    if (!result.ok) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** Fire a real message at an inbox to prove the transport works end to end. */
router.post('/test', requireCSRF, async (req, res, next) => {
  try {
    const to = (req.body?.to || req.user.email || '').trim();
    if (!mailer.isAddress(to)) return res.status(400).json({ error: 'Give a valid email address to send the test to.' });
    if (!mailer.isEnabled()) {
      return res.status(503).json({
        error: 'No email transport is configured. Set SMTP2GO_API_KEY, or SMTP_HOST (plus SMTP_USER and SMTP_PASSWORD), or MAIL_WEBHOOK_URL, then restart the server.',
      });
    }

    // An optional template key sends that exact message instead of the generic
    // test one, so an admin can check how a real notification lands in a real
    // inbox rather than trusting the on-page preview.
    const key = req.body?.template || null;
    const message = key ? messages.renderMessage(key) : messages.testEmail({ requestedBy: req.user.name });
    if (!message) return res.status(404).json({ error: 'Unknown email template' });

    const result = await mailer.sendTemplate({
      to,
      message,
      template: key || 'test',
      entity: 'user',
      entityId: req.user.id,
      // Inline, not queued. The entire point of this button is to answer
      // "does the transport work", and "it is in the queue" is not an answer
      // to that -- the admin would have to go and look at the Mail page to
      // find out what this request was for.
      queue: false,
    });
    await audit(req.user.id, 'send', 'email_test', to, { template: key || 'test' });

    if (!result.ok) return res.status(502).json({ error: result.error || 'The message could not be sent.' });
    res.json({ ok: true, to, transport: result.transport });
  } catch (err) {
    next(err);
  }
});

/** Run the first-response deadline sweep now instead of waiting for traffic. */
router.post('/sla-sweep', requireCSRF, async (req, res, next) => {
  try {
    const result = await slaWatch.runSweep();
    await audit(req.user.id, 'send', 'sla_sweep', String(result.warned));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Run the monthly service summaries now.
 *
 * The admin door to the same sweep the cron calls. `force` is what an admin
 * reaches for after fixing whatever stopped a month going out: it ignores both
 * the day-of-month window and the already-sent check, so it can and will send a
 * second copy. That is why it is a deliberate flag rather than the default.
 */
router.post('/service-sweep', requireCSRF, async (req, res, next) => {
  try {
    const force = req.body?.force === true;
    const result = await serviceDigest.runSweep({ force });
    await audit(req.user.id, 'send', 'service_sweep', String(result.sent), force ? { force: true } : undefined);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Send one project's launch announcement now.
 *
 * For the project that went live before anybody set its service key, and for
 * the one whose email failed while the mail server was down. `force` re-sends
 * one the client has already had, which is occasionally what is wanted and
 * never what is wanted by accident.
 */
router.post('/announce/:projectId', requireCSRF, async (req, res, next) => {
  try {
    const project = await db.find('projects', req.params.projectId);
    if (!project) return res.status(404).json({ error: 'No such project' });

    const result = await serviceLaunch.announce(project, { force: req.body?.force === true });
    if (!result.sent) return res.status(409).json({ error: result.reason, ...result });

    await audit(req.user.id, 'send', 'service_launch', project.id, { template: result.template });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** Run the domain expiry sweep now instead of waiting for traffic. */
router.post('/domain-sweep', requireCSRF, async (req, res, next) => {
  try {
    const result = await domainWatch.runSweep();
    await audit(req.user.id, 'send', 'domain_sweep', String(result.sent));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Send a client their progress summary now, rather than waiting for whatever
 * schedule the deployment runs this on.
 */
router.post('/digest/:clientId', requireCSRF, async (req, res, next) => {
  try {
    const client = await db.find('users', req.params.clientId);
    if (!client || client.role !== 'client') return res.status(404).json({ error: 'No such client' });
    if (!mailer.isAddress(client.email)) return res.status(400).json({ error: 'That client has no usable email address.' });

    const [tickets, projects] = await Promise.all([
      db.filter('tickets', (t) => t.clientId === client.id),
      db.filter('projects', (p) => p.clientId === client.id),
    ]);

    const result = await mailer.sendTemplate({
      to: client.email,
      message: messages.progressDigest({
        clientName: client.name,
        tickets,
        projects: projects.map((p) => ({ name: p.name, status: p.status })),
        period: 'this week',
      }),
      template: 'progress_digest',
      entity: 'user',
      entityId: client.id,
    });
    await audit(req.user.id, 'send', 'email_digest', client.id);

    if (!result.ok && !result.skipped) return res.status(502).json({ error: result.error || 'The summary could not be sent.' });
    res.json({
      ok: Boolean(result.ok),
      // Accepted into the outbound queue rather than already in the inbox, so
      // the page can say "sending" instead of claiming it has landed.
      queued: Boolean(result.queued),
      skipped: result.skipped || null,
      to: client.email,
      redirectedTo: result.redirectedTo || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
