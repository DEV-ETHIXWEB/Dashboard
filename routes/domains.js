'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
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
      sslStatus: 'Valid', expiresAt: expiresAt || '', autoRenew: false, dnsStatus: 'Propagated',
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
    const patch = { ...req.body };
    delete patch.id;
    const updated = await db.update('domains', req.params.id, patch);
    // Tell this client's open tabs, not everyone's.
    res.locals.liveAudience = [domain.clientId];
    await audit(req.user.id, 'update', 'domain', req.params.id);
    res.json({ domain: updated });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/renew', requireCSRF, requireRole('admin', 'sales', 'project_manager'), async (req, res, next) => {
  try {
    const domain = await db.find('domains', req.params.id);
    if (!domain) return res.status(404).json({ error: 'Domain not found' });
    let current = new Date(domain.expiresAt);
    if (isNaN(current.getTime())) current = new Date();
    current.setFullYear(current.getFullYear() + 1);
    const expiresAt = current.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const updated = await db.update('domains', req.params.id, { expiresAt, sslStatus: 'Valid' });
    // Tell this client's open tabs, not everyone's.
    res.locals.liveAudience = [domain.clientId];
    await audit(req.user.id, 'renew', 'domain', req.params.id);
    res.json({ domain: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireCSRF, requireRole('admin'), async (req, res, next) => {
  try {
    const ok = await db.remove('domains', req.params.id);
    if (!ok) return res.status(404).json({ error: 'Domain not found' });
    await audit(req.user.id, 'delete', 'domain', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
