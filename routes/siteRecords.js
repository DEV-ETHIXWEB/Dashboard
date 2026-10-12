'use strict';

/**
 * The record of work done on a client's site.
 *
 * Seven panels read from here -- backups, uptime, security, SEO, performance,
 * plugin updates and the monthly health check -- and each is gated on the
 * entitlement of the same name. The gate is here, on the server, and not only
 * on the panel that hides itself: a client who is not paying for uptime
 * monitoring is refused the rows, not merely shown a cover over them.
 *
 * What a locked client gets instead is nothing from this endpoint at all. The
 * example rows in a locked panel are written in the browser and labelled as
 * examples, because sending a client plausible-looking data they do not own is
 * the one thing a screen like this must never do.
 */

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit } = require('../middleware/auth');
const plans = require('../lib/plans');
const subscriptions = require('../utils/subscriptions');
const live = require('../utils/liveBus');

router.use(requireAuth);

/** The entitlement keys that have a panel behind them. */
const PANEL_KINDS = plans.ENTITLEMENTS.filter((e) => e.locked).map((e) => e.key);

/**
 * Which client's records this request is about.
 *
 * A client is only ever shown their own, whatever they put in the query
 * string. Staff name the client they are looking at.
 */
async function subjectFor(req) {
  if (req.user.role === 'client') return req.user;
  if (!['admin', 'sales', 'project_manager'].includes(req.user.role)) return null;
  const requested = req.query.clientId || req.body?.clientId || null;
  if (!requested) return null;
  const client = await db.find('users', requested);
  return client && client.role === 'client' ? client : null;
}

/**
 * One panel's rows, newest first.
 *
 * Answers 200 with `locked: true` and no rows rather than 403, because this is
 * not an error: the panel is a real part of the client's dashboard that their
 * plan does not include yet, and the screen needs to render the locked state
 * rather than an error state. The rows are absent either way, which is the
 * part that matters.
 */
router.get('/', async (req, res, next) => {
  try {
    const kind = String(req.query.kind || '');
    if (!PANEL_KINDS.includes(kind)) {
      return res.status(400).json({ error: 'Unknown panel.' });
    }

    const subject = await subjectFor(req);
    if (!subject) return res.json({ records: [], locked: false, kind });

    // Staff see everything; a client sees what they are paying for.
    let locked = false;
    if (req.user.role === 'client') {
      const state = await subscriptions.stateFor(subject);
      locked = !subscriptions.has(state, kind);
      if (locked) {
        return res.json({
          records: [],
          locked: true,
          kind,
          recommended: plans.recommendedUpgradeFor(state.effectivePlanKey) || 'unlimited',
        });
      }
    }

    const rows = await db.filter(
      'site_records',
      (r) => r.clientId === subject.id && r.kind === kind,
    );

    res.json({
      records: rows
        .sort((a, b) => String(b.occurredAt || b.createdAt || '').localeCompare(
          String(a.occurredAt || a.createdAt || ''),
        ))
        .slice(0, 50),
      locked,
      kind,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Log something we did. Staff only -- a client cannot write their own history,
 * and nothing here is ever generated to fill a panel out.
 */
router.post('/', requireCSRF, requireRole('admin', 'project_manager'), async (req, res, next) => {
  try {
    const { clientId, kind, title, detail, status, occurredAt, meta } = req.body || {};

    if (!PANEL_KINDS.includes(String(kind))) {
      return res.status(400).json({ error: 'Unknown panel.' });
    }
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'A title is required.' });
    }

    const client = clientId ? await db.find('users', clientId) : null;
    if (!client || client.role !== 'client') {
      return res.status(404).json({ error: 'No such client.' });
    }

    const record = await db.insert('site_records', {
      clientId: client.id,
      kind: String(kind),
      title: String(title).trim(),
      detail: detail ? String(detail) : null,
      status: status ? String(status) : null,
      occurredAt: occurredAt || new Date().toISOString(),
      meta: meta && typeof meta === 'object' ? meta : null,
      createdBy: req.user.id,
      createdAt: new Date().toISOString(),
    });

    await audit(req.user.id, 'create', 'site_record', record.id, { clientId: client.id, kind });
    res.locals.liveAudience = [client.id];
    live.publish('domains', { to: [client.id] });

    res.status(201).json({ record });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireCSRF, requireRole('admin'), async (req, res, next) => {
  try {
    const record = await db.find('site_records', req.params.id);
    if (!record) return res.status(404).json({ error: 'No such record.' });

    await db.remove('site_records', record.id);
    await audit(req.user.id, 'delete', 'site_record', record.id, { clientId: record.clientId });
    res.locals.liveAudience = [record.clientId];
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.PANEL_KINDS = PANEL_KINDS;
