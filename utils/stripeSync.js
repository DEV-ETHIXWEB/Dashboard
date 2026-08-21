'use strict';

/**
 * Stripe is the ledger; this file is the mirror.
 *
 * Every number a client sees about money comes from a Stripe object, copied
 * into the `payments` and `billing` tables so the portal can render a page
 * without a network call and so history survives a Stripe outage. Nothing here
 * ever invents a row: each one is keyed by its Stripe object id, so a webhook
 * replayed three times updates one row three times instead of billing anyone
 * three times over.
 *
 * Two ways in, and they agree:
 *   - webhooks, for the moment something happens (routes/billing.js)
 *   - `backfillClient()`, for first setup and for repairing a missed webhook
 */

const { db } = require('../db/setup');

/** Zero-decimal currencies: Stripe quotes these in whole units already. */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const Stripe = require('stripe');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function isEnabled() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Stripe counts in the smallest unit; people count in the big one. */
function fromMinorUnits(amount, currency) {
  const value = Number(amount || 0);
  if (!Number.isFinite(value)) return 0;
  return ZERO_DECIMAL.has(String(currency || 'usd').toLowerCase()) ? value : value / 100;
}

function isoFromUnix(seconds) {
  if (!seconds && seconds !== 0) return null;
  const ms = Number(seconds) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The billing row for a client, or null. One row per client by construction. */
async function billingForClient(clientId) {
  const rows = await db.filter('billing', (b) => b.clientId === clientId);
  return rows[0] || null;
}

async function billingForCustomer(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  const rows = await db.filter('billing', (b) => b.stripeCustomerId === stripeCustomerId);
  return rows[0] || null;
}

/**
 * Write a payment row, keyed by its Stripe id.
 *
 * Returns `{ payment, created }` so the caller can decide whether this is
 * worth an email -- an updated row usually is not.
 */
async function upsertPayment(record) {
  if (!record.stripeObjectId) return { payment: null, created: false };

  const existing = (await db.filter('payments', (p) => p.stripeObjectId === record.stripeObjectId))[0];
  if (existing) {
    const updated = await db.update('payments', existing.id, {
      ...record,
      // The client a payment belongs to is resolved once and never re-guessed:
      // a later webhook with no customer mapping must not orphan the row.
      clientId: record.clientId || existing.clientId,
    });
    return { payment: updated, created: false };
  }

  const payment = await db.insert('payments', {
    ...record,
    createdAt: record.createdAt || new Date().toISOString(),
  });
  return { payment, created: true };
}

/** A Stripe invoice, flattened into the shape the portal reads. */
function fromInvoice(invoice, { clientId = null } = {}) {
  const currency = String(invoice.currency || 'usd').toLowerCase();
  const charge = typeof invoice.charge === 'object' ? invoice.charge : null;
  const line = invoice.lines?.data?.[0];

  return {
    clientId,
    stripeCustomerId: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || null,
    stripeObjectId: invoice.id,
    kind: 'invoice',
    description:
      invoice.description
      || line?.description
      || (invoice.billing_reason === 'subscription_cycle' ? 'Subscription renewal' : 'Subscription'),
    amount: fromMinorUnits(invoice.amount_paid || invoice.amount_due, currency),
    currency,
    status: invoice.status === 'paid' ? 'paid' : invoice.status || 'open',
    paidAt: isoFromUnix(invoice.status_transitions?.paid_at || invoice.created),
    periodStart: isoFromUnix(line?.period?.start),
    periodEnd: isoFromUnix(line?.period?.end),
    invoiceUrl: invoice.hosted_invoice_url || null,
    receiptUrl: invoice.invoice_pdf || charge?.receipt_url || null,
    invoiceNumber: invoice.number || null,
    cardBrand: charge?.payment_method_details?.card?.brand || null,
    cardLast4: charge?.payment_method_details?.card?.last4 || null,
    failureMessage: invoice.status === 'uncollectible' ? 'Stripe gave up collecting this invoice' : null,
  };
}

/** A one-off charge that never became an invoice -- a manual payment link, say. */
function fromCharge(charge, { clientId = null } = {}) {
  const currency = String(charge.currency || 'usd').toLowerCase();
  const card = charge.payment_method_details?.card;

  return {
    clientId,
    stripeCustomerId: typeof charge.customer === 'string' ? charge.customer : charge.customer?.id || null,
    stripeObjectId: charge.id,
    kind: charge.refunded ? 'refund' : 'charge',
    description: charge.description || 'Payment',
    amount: fromMinorUnits(charge.amount_refunded > 0 ? charge.amount_refunded : charge.amount, currency),
    currency,
    status: charge.refunded ? 'refunded' : charge.status === 'succeeded' ? 'paid' : charge.status || 'pending',
    paidAt: isoFromUnix(charge.created),
    periodStart: null,
    periodEnd: null,
    invoiceUrl: null,
    receiptUrl: charge.receipt_url || null,
    invoiceNumber: null,
    cardBrand: card?.brand || null,
    cardLast4: card?.last4 || null,
    failureMessage: charge.failure_message || null,
  };
}

/** Everything the portal shows about a subscription, flattened. */
function fromSubscription(subscription) {
  const item = subscription.items?.data?.[0];
  const price = item?.price;
  const currency = String(price?.currency || subscription.currency || 'usd').toLowerCase();

  return {
    stripeSubscriptionId: subscription.id,
    status: subscription.status,
    plan: price?.nickname || price?.product?.name || subscription.description || 'Subscription',
    amount: price ? fromMinorUnits(price.unit_amount, currency) * (item?.quantity || 1) : null,
    currency,
    interval: price?.recurring?.interval || null,
    currentPeriodEnd: isoFromUnix(subscription.current_period_end),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
  };
}

/** Merge a patch into a client's billing row, creating it if this is the first. */
async function saveBilling(clientId, patch) {
  const now = new Date().toISOString();
  const existing = await billingForClient(clientId);
  if (existing) return db.update('billing', existing.id, { ...patch, updatedAt: now, syncedAt: now });
  return db.insert('billing', {
    clientId,
    plan: null,
    status: 'no_subscription',
    ...patch,
    updatedAt: now,
    syncedAt: now,
  });
}

/** The default card on file, so the portal can say "Visa ending 4242". */
async function readDefaultCard(stripe, customerId) {
  if (!customerId) return {};
  try {
    const customer = await stripe.customers.retrieve(customerId, {
      expand: ['invoice_settings.default_payment_method'],
    });
    const pm = customer?.invoice_settings?.default_payment_method;
    if (!pm || typeof pm === 'string') return {};
    return { cardBrand: pm.card?.brand || null, cardLast4: pm.card?.last4 || null };
  } catch {
    // A missing card is not an error worth failing a sync over.
    return {};
  }
}

/**
 * Pull one client's whole money history from Stripe and mirror it locally.
 *
 * Used on first connect, by the admin's "Sync from Stripe" button, and as the
 * repair path for a webhook that never arrived. Safe to run repeatedly.
 */
async function backfillClient(client, { limit = 100 } = {}) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY first.');

  const billing = await billingForClient(client.id);
  let customerId = billing?.stripeCustomerId || null;

  // No customer on file: find one by email before creating a duplicate.
  if (!customerId && client.email) {
    const found = await stripe.customers.list({ email: client.email, limit: 1 });
    customerId = found.data[0]?.id || null;
  }
  if (!customerId) return { customerId: null, payments: 0, subscription: null };

  const [invoices, charges, subscriptions, card] = await Promise.all([
    stripe.invoices.list({ customer: customerId, limit, expand: ['data.charge'] }),
    stripe.charges.list({ customer: customerId, limit }),
    stripe.subscriptions.list({ customer: customerId, limit: 1, status: 'all', expand: ['data.items.data.price.product'] }),
    readDefaultCard(stripe, customerId),
  ]);

  let count = 0;
  for (const invoice of invoices.data) {
    await upsertPayment(fromInvoice(invoice, { clientId: client.id }));
    count += 1;
  }

  // Only charges Stripe did not already report as part of an invoice, so a
  // subscription payment is not counted twice.
  for (const charge of charges.data) {
    if (charge.invoice) continue;
    await upsertPayment(fromCharge(charge, { clientId: client.id }));
    count += 1;
  }

  const subscription = subscriptions.data[0] || null;
  const patch = {
    stripeCustomerId: customerId,
    ...card,
    latestInvoiceUrl: invoices.data[0]?.hosted_invoice_url || null,
  };
  if (subscription) Object.assign(patch, fromSubscription(subscription));
  else if (!billing?.stripeSubscriptionId) patch.status = 'no_subscription';

  await saveBilling(client.id, patch);
  return { customerId, payments: count, subscription: subscription?.id || null };
}

/**
 * What the client's money screens read.
 *
 * `categories` is what the "Where your money went" panel draws: real Stripe
 * charges grouped by what they were for, biggest first.
 */
async function summariseForClient(clientId) {
  const rows = await db.filter('payments', (p) => p.clientId === clientId);
  const paid = rows.filter((p) => p.status === 'paid');

  const total = paid.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const byLabel = new Map();
  for (const p of paid) {
    const label = p.description || 'Payment';
    byLabel.set(label, (byLabel.get(label) || 0) + Number(p.amount || 0));
  }

  const sorted = rows.sort((a, b) => String(b.paidAt || b.createdAt).localeCompare(String(a.paidAt || a.createdAt)));

  return {
    total,
    currency: paid[0]?.currency || 'usd',
    count: paid.length,
    lastPaidAt: paid.map((p) => p.paidAt).filter(Boolean).sort().reverse()[0] || null,
    categories: [...byLabel.entries()]
      .map(([label, amount]) => ({ id: label, label, amount }))
      .sort((a, b) => b.amount - a.amount),
    payments: sorted,
  };
}

module.exports = {
  getStripe,
  isEnabled,
  fromMinorUnits,
  isoFromUnix,
  billingForClient,
  billingForCustomer,
  upsertPayment,
  fromInvoice,
  fromCharge,
  fromSubscription,
  saveBilling,
  backfillClient,
  summariseForClient,
};
