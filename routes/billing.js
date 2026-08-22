'use strict';

/**
 * Money, as Stripe sees it.
 *
 * Nothing in this file invents a figure. Every amount a client reads comes
 * from a Stripe object mirrored into `payments` and `billing` by
 * utils/stripeSync.js, so "what have I paid you" and "what does Stripe say I
 * paid you" can never drift apart. Webhooks keep the mirror current; the
 * admin's sync endpoint repairs it when one goes missing.
 */

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit, notify } = require('../middleware/auth');
const { requirePage } = require('../utils/clientPages');
const stripeSync = require('../utils/stripeSync');
const mailer = require('../utils/mailer');
const messages = require('../utils/emailMessages');
const appUrl = require('../utils/appUrl');
const live = require('../utils/liveBus');

function getStripe() {
  return stripeSync.getStripe();
}

router.use(requireAuth);
router.use(requirePage('billing'));

/** Clients see themselves; staff see everyone, or one named account. */
async function scopeFor(req) {
  if (req.user.role === 'client') return req.user;
  const requested = req.query.clientId;
  if (!requested) return null;
  const client = await db.find('users', requested);
  return client && client.role === 'client' ? client : null;
}

router.get('/status', async (req, res, next) => {
  try {
    const enabled = stripeSync.isEnabled();

    if (req.user.role === 'client') {
      const existing = await stripeSync.billingForClient(req.user.id);
      const summary = await stripeSync.summariseForClient(req.user.id);
      return res.json({
        enabled,
        billing: existing || { status: 'no_subscription' },
        summary: { total: summary.total, currency: summary.currency, count: summary.count, lastPaidAt: summary.lastPaidAt },
      });
    }

    const all = await db.all('billing');
    res.json({ enabled, billing: all });
  } catch (err) {
    next(err);
  }
});

/**
 * The payment history behind every money figure in the portal.
 *
 * Same shape for both audiences; only the scope differs. Staff without a
 * `clientId` get the whole workspace, which is what the finance view wants.
 */
router.get('/payments', async (req, res, next) => {
  try {
    if (req.user.role === 'client') {
      const summary = await stripeSync.summariseForClient(req.user.id);
      return res.json({ enabled: stripeSync.isEnabled(), ...summary });
    }

    const client = await scopeFor(req);
    if (client) {
      const summary = await stripeSync.summariseForClient(client.id);
      return res.json({ enabled: stripeSync.isEnabled(), client: { id: client.id, name: client.name }, ...summary });
    }

    const rows = (await db.all('payments')).sort((a, b) =>
      String(b.paidAt || b.createdAt).localeCompare(String(a.paidAt || a.createdAt)));
    const paid = rows.filter((p) => p.status === 'paid');
    res.json({
      enabled: stripeSync.isEnabled(),
      total: paid.reduce((sum, p) => sum + Number(p.amount || 0), 0),
      currency: paid[0]?.currency || 'usd',
      count: paid.length,
      categories: [],
      payments: rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Pull everything Stripe has and mirror it locally.
 *
 * Admin-only and idempotent: this is the repair path for a webhook that never
 * arrived, and the first-run path for a workspace whose Stripe account already
 * has history.
 */
router.post('/sync', requireCSRF, requireRole('admin'), async (req, res, next) => {
  try {
    if (!stripeSync.isEnabled()) {
      return res.status(503).json({ error: 'Stripe is not configured yet. Set STRIPE_SECRET_KEY (see README).' });
    }

    const one = req.body?.clientId ? await db.find('users', req.body.clientId) : null;
    const clients = one && one.role === 'client'
      ? [one]
      : await db.filter('users', (u) => u.role === 'client');

    const results = [];
    for (const client of clients) {
      try {
        const result = await stripeSync.backfillClient(client);
        results.push({ clientId: client.id, name: client.name, ...result });
      } catch (err) {
        results.push({ clientId: client.id, name: client.name, error: err.message });
      }
    }

    await audit(req.user.id, 'sync', 'billing', one?.id || 'all', { clients: results.length });
    res.locals.liveAudience = clients.map((c) => c.id);
    res.json({ ok: true, synced: results });
  } catch (err) {
    next(err);
  }
});

router.post('/checkout', requireCSRF, requireRole('client'), async (req, res, next) => {
  try {
    const stripe = getStripe();
    if (!stripe || !process.env.STRIPE_PRICE_ID) {
      return res.status(503).json({ error: 'Billing is not configured yet. Ask your admin to finish Stripe setup (see README).' });
    }

    const existing = await stripeSync.billingForClient(req.user.id);
    let stripeCustomerId = existing?.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name: req.user.name,
        // Lets a webhook find the account even before the billing row exists.
        metadata: { clientId: req.user.id },
      });
      stripeCustomerId = customer.id;
    }

    const base = appUrl.baseUrl() || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${base}/portal/billing?billing=success`,
      cancel_url: `${base}/portal/billing?billing=cancelled`,
    });

    await stripeSync.saveBilling(req.user.id, {
      stripeCustomerId,
      plan: existing?.plan || 'standard',
      status: existing?.status || 'pending',
    });

    await audit(req.user.id, 'create', 'billing_checkout', stripeCustomerId);
    res.locals.liveAudience = [req.user.id];
    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

/**
 * A Stripe-hosted page where the client can change their card, read their
 * invoices, or cancel. Card details never touch this server, which is the
 * entire reason it exists.
 */
router.post('/portal', requireCSRF, requireRole('client'), async (req, res, next) => {
  try {
    const stripe = getStripe();
    const billing = await stripeSync.billingForClient(req.user.id);
    if (!stripe || !billing?.stripeCustomerId) {
      return res.status(503).json({ error: 'There is no payment account set up for you yet.' });
    }

    const base = appUrl.baseUrl() || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: billing.stripeCustomerId,
      return_url: `${base}/portal/billing`,
    });
    await audit(req.user.id, 'create', 'billing_portal', billing.stripeCustomerId);
    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

// --- webhook ---------------------------------------------------------------

/** Which client a Stripe customer belongs to, by billing row then by email. */
async function clientIdForCustomer(customerId, { email = null } = {}) {
  const billing = await stripeSync.billingForCustomer(customerId);
  if (billing?.clientId) return billing.clientId;
  if (!email) return null;
  const match = (await db.filter('users', (u) => u.role === 'client' && u.email === email))[0];
  return match?.id || null;
}

async function emailPayment(clientId, template, context) {
  const client = clientId ? await db.find('users', clientId) : null;
  if (!client?.email) return;
  await mailer.sendTemplate({
    to: client.email,
    message: messages[template]({ ...context, clientName: client.name }),
    template,
    entity: 'billing',
    entityId: clientId,
  });
}

/**
 * Webhooks arrive before the live-broadcast middleware in the stack (they need
 * the raw body), so a payment nudges the client's open tabs from here.
 */
function pushMoneyChange(clientId) {
  if (!clientId) return;
  live.publish('billing', { to: [clientId] });
  live.publish('budget', { to: [clientId] });
}

async function webhookHandler(req, res) {
  const stripe = getStripe();
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    // A bad signature is the one case where the body is not to be trusted at
    // all, so nothing is read out of it.
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  try {
    await handleEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error(`Stripe webhook ${event.type} failed:`, err);
    // A 500 makes Stripe retry, which is what we want for a transient fault.
    res.status(500).end();
  }
}

async function handleEvent(event) {
  const object = event.data.object;

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const clientId = await clientIdForCustomer(object.customer);
      if (!clientId) return;
      const patch = stripeSync.fromSubscription(object);
      if (event.type === 'customer.subscription.deleted') patch.status = 'canceled';
      await stripeSync.saveBilling(clientId, { stripeCustomerId: object.customer, ...patch });
      pushMoneyChange(clientId);
      return;
    }

    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const clientId = await clientIdForCustomer(object.customer, { email: object.customer_email });
      const { payment, created } = await stripeSync.upsertPayment(stripeSync.fromInvoice(object, { clientId }));
      if (!clientId) return;

      await stripeSync.saveBilling(clientId, {
        stripeCustomerId: object.customer,
        status: 'active',
        latestInvoiceUrl: object.hosted_invoice_url || null,
      });

      pushMoneyChange(clientId);

      // Only the first time: a replayed webhook must not re-thank anyone.
      if (created && payment?.status === 'paid') {
        await notify(clientId, `Payment received: ${formatMoney(payment.amount, payment.currency)}`, 'billing');
        await emailPayment(clientId, 'paymentReceived', {
          clientName: (await db.find('users', clientId))?.name,
          payment,
        });
      }
      return;
    }

    case 'invoice.payment_failed': {
      const clientId = await clientIdForCustomer(object.customer, { email: object.customer_email });
      const record = stripeSync.fromInvoice(object, { clientId });
      record.status = 'failed';
      record.failureMessage = object.last_finalization_error?.message || 'The card was declined.';
      const { payment, created } = await stripeSync.upsertPayment(record);
      if (!clientId) return;

      await stripeSync.saveBilling(clientId, { stripeCustomerId: object.customer, status: 'past_due' });
      pushMoneyChange(clientId);

      if (created) {
        await notify(clientId, 'We could not take your last payment. Please update your card.', 'billing');
        await emailPayment(clientId, 'paymentFailed', {
          clientName: (await db.find('users', clientId))?.name,
          payment,
        });
      }
      return;
    }

    case 'charge.succeeded':
    case 'charge.refunded': {
      // Invoiced charges arrive through the invoice events with more context.
      if (object.invoice) return;
      const clientId = await clientIdForCustomer(object.customer, { email: object.billing_details?.email });
      await stripeSync.upsertPayment(stripeSync.fromCharge(object, { clientId }));
      pushMoneyChange(clientId);
      return;
    }

    case 'checkout.session.completed': {
      const clientId = object.metadata?.clientId || (await clientIdForCustomer(object.customer, { email: object.customer_details?.email }));
      if (!clientId) return;
      await stripeSync.saveBilling(clientId, { stripeCustomerId: object.customer, status: 'active' });
      pushMoneyChange(clientId);
      return;
    }

    default:
      // Everything else is acknowledged and ignored on purpose: a 200 stops
      // Stripe retrying an event this app has no opinion about.
  }
}

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: String(currency || 'usd').toUpperCase(),
      maximumFractionDigits: 2,
    }).format(Number(amount || 0));
  } catch {
    return `${amount} ${String(currency || '').toUpperCase()}`;
  }
}

module.exports = router;
module.exports.webhookHandler = webhookHandler;
module.exports.handleEvent = handleEvent;
