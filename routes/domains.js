'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const approvals = require('../utils/approvals');
const domainWatch = require('../utils/domainWatch');
const { requireAuth, requireRole, requireCSRF, audit } = require('../middleware/auth');
const { requirePage } = require('../utils/clientPages');

router.use(requireAuth);
router.use(requirePage('domains'));

function visibleTo(user, domain) {
  if (['admin', 'sales', 'project_manager'].includes(user.role)) return true;
  if (user.role === 'client') return domain.clientId === user.id;
  return false;
}

router.get('/', async (req, res, next) => {
  try {
    const all = await db.all('domains');
    // Piggyback the expiry sweep on traffic; it rate-limits itself to once an
    // hour and must never delay the response.
    if (['admin', 'sales', 'project_manager'].includes(req.user.role)) void domainWatch.maybeSweep();
    res.json({ domains: all.filter((d) => visibleTo(req.user, d)) });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCSRF, requireRole('admin', 'sales', 'project_manager'), async (req, res, next) => {
  try {
    const { clientId, domainName, platform, hostingProvider, hostingRegion, registrar, expiresAt, notes } = req.body || {};
    if (!clientId || !domainName) return res.status(400).json({ error: 'clientId and domainName are required' });
    const client = await db.find('users', clientId);
    if (!client || client.role !== 'client') return res.status(400).json({ error: 'clientId must reference a client user' });

    const domain = await db.insert('domains', {
      clientId, domainName, platform: platform || 'Custom', hostingProvider: hostingProvider || 'Not set',
      hostingRegion: hostingRegion || '', registrar: registrar || 'Registered externally',
      // 'Unknown', not 'Valid' and 'Propagated'. Both of those were written on
      // creation without anything having looked at the certificate or the DNS,
      // so a client opened their Websites page and read a green certificate
      // claim about a domain nobody had checked -- which is worse than saying
      // nothing, because they would act on it. The watcher sets the real value
      // once it has actually looked.
      sslStatus: 'Unknown', expiresAt: expiresAt || '', autoRenew: false, dnsStatus: 'Unknown',
      notes: notes || '',
    });
    // Tell this client's open tabs, not everyone's.
    res.locals.liveAudience = [clientId];
    await audit(req.user.id, 'create', 'domain', domain.id);
    res.status(201).json({ domain });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireCSRF, requireRole('admin', 'sales', 'project_manager'), async (req, res, next) => {
  try {
    const domain = await db.find('domains', req.params.id);
    if (!domain) return res.status(404).json({ error: 'Domain not found' });
    /**
     * The fields an edit may touch, named rather than subtracted.
     *
     * Spreading the body meant every column was writable by any of the three
     * roles that reach this route, including the ones a watcher owns: a PUT
     * could set `sslStatus: 'Valid'` on a domain with an expired certificate
     * and the client's page would say so.
     */
    const EDITABLE = [
      'clientId', 'domainName', 'platform', 'hostingProvider', 'hostingRegion',
      'registrar', 'expiresAt', 'autoRenew', 'notes',
    ];
    const patch = {};
    for (const field of EDITABLE) {
      if (field in req.body) patch[field] = req.body[field];
    }

    /**
     * Moving a domain to another client is an admin's decision.
     *
     * The same rule tickets already follow, and for the same reason: the
     * client a row belongs to decides whose portal shows it, so moving one
     * puts a customer's hosting details in front of a different customer.
     * Sales could do it with one request.
     */
    const movingClient = 'clientId' in patch && patch.clientId !== domain.clientId;
    if (movingClient && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can move a domain to a different client.' });
    }
    if (movingClient) {
      const nextClient = await db.find('users', patch.clientId);
      if (!nextClient || nextClient.role !== 'client') {
        return res.status(400).json({ error: 'That is not a client account.' });
      }
    }

    const updated = await db.update('domains', req.params.id, patch);
    // Tell this client's open tabs, not everyone's -- both sides when it moved.
    res.locals.liveAudience = [...new Set([domain.clientId, updated.clientId].filter(Boolean))];
    await audit(req.user.id, 'update', 'domain', req.params.id, {
      changed: Object.keys(patch),
      ...(movingClient ? { clientFrom: domain.clientId, clientTo: updated.clientId } : {}),
    });
    res.json({ domain: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * Record that a renewal happened. It does not perform one.
 *
 * Nothing here talks to a registrar and nothing ever has -- this moves a date
 * in our own records so the expiry warnings stop firing for a domain somebody
 * has already renewed elsewhere. It was called "Renew", which reads as an
 * action on the domain itself, and it also set `sslStatus: 'Valid'`, asserting
 * something about a certificate it had not looked at.
 *
 * The date is stored as ISO. It used to be written as 'Oct 10, 2027' -- a
 * different format from every other date in the column, so every comparison
 * against it (the expiry warnings included) was a string comparison against a
 * shape it did not recognise.
 */
router.post('/:id/record-renewal', requireCSRF, requireRole('admin', 'sales', 'project_manager'), async (req, res, next) => {
  try {
    const domain = await db.find('domains', req.params.id);
    if (!domain) return res.status(404).json({ error: 'Domain not found' });

    // From the date it expires, or from today when that is unreadable --
    // a renewal extends the term it had rather than starting one now.
    let current = new Date(domain.expiresAt);
    if (Number.isNaN(current.getTime())) current = new Date();

    const years = Number(req.body?.years);
    const span = Number.isFinite(years) && years >= 1 && years <= 10 ? Math.round(years) : 1;
    current.setFullYear(current.getFullYear() + span);

    const expiresAt = current.toISOString();
    const updated = await db.update('domains', req.params.id, { expiresAt });
    // Tell this client's open tabs, not everyone's.
    res.locals.liveAudience = [domain.clientId];
    await audit(req.user.id, 'renew', 'domain', req.params.id, { expiresAt, years: span });
    res.json({ domain: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireCSRF, requireRole('admin'), async (req, res, next) => {
  try {
    const domain = await db.find('domains', req.params.id);
    if (!domain) return res.status(404).json({ error: 'Domain not found' });

    const gate = await approvals.gate(req, res, {
      action: 'domain.delete',
      summary: `Delete the website address ${domain.domainName}`,
      payload: { domainId: req.params.id },
    });
    if (gate.held) return;

    const ok = await db.remove('domains', req.params.id);
    if (!ok) return res.status(404).json({ error: 'Domain not found' });
    await audit(req.user.id, 'delete', 'domain', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
