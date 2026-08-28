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

  // Not seen under this id -- but an invoice and the charge that paid it are
  // two ids for one payment, and current Stripe API versions no longer link
  // them (`invoice.charge` and `charge.invoice` both come back empty). Left
  // alone, every invoiced payment was mirrored twice and every total a client
  // read was exactly double what they had actually paid. The payment intent is
  // the same on both, so it is what joins them.
  if (record.stripePaymentIntent) {
    const sibling = (await db.filter('payments', (p) => p.stripePaymentIntent === record.stripePaymentIntent))[0];
    if (sibling) {
      const merged = await db.update('payments', sibling.id, mergePayment(sibling, record));
      // A charge webhook can beat its invoice. When the invoice then folds into
      // that row this is still the first time the payment has been seen as an
      // invoice, and the client is still owed their receipt -- so say so rather
      // than letting the merge swallow the email.
      return { payment: merged, created: false, upgraded: sibling.kind !== 'invoice' && record.kind === 'invoice' };
    }
  }

  const payment = await db.insert('payments', {
    ...record,
    createdAt: record.createdAt || new Date().toISOString(),
  });
  return { payment, created: true };
}

/**
 * Fold a second view of one payment into the row already stored.
 *
 * The invoice knows what the payment was for and where its PDF lives; the
 * charge knows which card paid it. Whichever arrives second should add what it
 * knows without throwing away what the first one had, and an invoice always
 * wins the identity because that is the document the client is shown.
 */
function mergePayment(existing, incoming) {
  const invoiceWins = existing.kind === 'invoice' && incoming.kind !== 'invoice';
  const base = invoiceWins ? incoming : existing;
  const lead = invoiceWins ? existing : incoming;

  const merged = { ...base, ...lead };
  for (const [key, value] of Object.entries(merged)) {
    if (value === null || value === undefined) {
      const fallback = invoiceWins ? incoming[key] : existing[key];
      if (fallback !== null && fallback !== undefined) merged[key] = fallback;
    }
  }
  merged.id = existing.id;
  merged.clientId = incoming.clientId || existing.clientId;
  merged.createdAt = existing.createdAt;
  return merged;
}

/** The payment intent that settled an invoice, wherever this API version files it. */
function paymentIntentOf(invoice) {
  const direct = invoice.payment_intent;
  if (typeof direct === 'string') return direct;
  if (direct?.id) return direct.id;
  const payment = invoice.payments?.data?.[0]?.payment;
  if (typeof payment?.payment_intent === 'string') return payment.payment_intent;
  return payment?.payment_intent?.id || null;
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
    // Newer API versions report this through the `payments` sub-list; older
    // ones put it straight on the invoice. Either way it is the id the paying
    // charge also carries, which is what stops the two being counted twice.
    stripePaymentIntent: paymentIntentOf(invoice),
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
    stripePaymentIntent: typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id || null,
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
    // Newer Stripe API versions moved the billing period onto each subscription
    // item; older ones keep it on the subscription. Read both so an account on
    // either version still gets a renewal date instead of a blank.
    currentPeriodEnd: isoFromUnix(subscription.current_period_end ?? item?.current_period_end),
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
 * Put the product's name on the subscription's price, in place.
 *
 * The plan name a client reads is the product's name, which lives one level
 * past what Stripe will expand in a list call. One extra request buys a real
 * plan name instead of "Subscription"; failing to get it is not worth losing
 * the sync over.
 */
async function attachProduct(stripe, subscription) {
  const price = subscription.items?.data?.[0]?.price;
  if (!price || typeof price.product !== 'string') return;
  try {
    price.product = await stripe.products.retrieve(price.product);
  } catch {
    // Leave the id in place; fromSubscription falls back to the nickname.
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
  //
  // Two are fetched rather than one so an ambiguous email can be recognised
  // instead of resolved by luck. One real Stripe account here has two separate
  // companies filed under the same contact address; picking whichever Stripe
  // listed first would have shown a client half of someone else's payments and
  // hidden half of their own. When the email is ambiguous nothing is guessed --
  // the admin is told to link the right customer by hand.
  if (!customerId && client.email) {
    const found = await stripe.customers.list({ email: client.email, limit: 2 });
    if (found.data.length > 1) {
      return {
        customerId: null,
        payments: 0,
        subscription: null,
        ambiguous: found.data.map((c) => ({ id: c.id, name: c.name || null, email: c.email || null })),
      };
    }
    customerId = found.data[0]?.id || null;
  }
  if (!customerId) return { customerId: null, payments: 0, subscription: null };

  const [invoices, charges, subscriptions, card] = await Promise.all([
    stripe.invoices.list({ customer: customerId, limit, expand: ['data.charge', 'data.payments'] }),
    stripe.charges.list({ customer: customerId, limit }),
    // `data.items.data.price.product` is five levels deep and Stripe refuses
    // more than four, so asking for it failed the whole backfill with a 400 --
    // which is why "Sync from Stripe" returned an error for every client. The
    // product name is fetched separately below instead.
    stripe.subscriptions.list({ customer: customerId, limit: 1, status: 'all', expand: ['data.items.data.price'] }),
    readDefaultCard(stripe, customerId),
  ]);

  let count = 0;
  const invoiced = new Set();
  for (const invoice of invoices.data) {
    const record = fromInvoice(invoice, { clientId: client.id });
    if (record.stripePaymentIntent) invoiced.add(record.stripePaymentIntent);
    await upsertPayment(record);
    count += 1;
  }

  // Only charges that are not already an invoice, so one payment is not counted
  // twice. `charge.invoice` is empty on current API versions, so the payment
  // intent -- which the invoice and its charge share -- is what is checked.
  for (const charge of charges.data) {
    if (charge.invoice) continue;
    const record = fromCharge(charge, { clientId: client.id });
    if (record.stripePaymentIntent && invoiced.has(record.stripePaymentIntent)) continue;
    await upsertPayment(record);
    count += 1;
  }

  const subscription = subscriptions.data[0] || null;
  if (subscription) await attachProduct(stripe, subscription);
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
 * Every customer on the Stripe account, with the client each one is filed
 * under. This is what the admin's "link a Stripe customer" picker reads, and
 * the reason it exists: a workspace's client emails and its Stripe customer
 * emails are two separate address books that nobody keeps in step. Matching on
 * email alone found nothing at all here -- and where it did match, it matched
 * two companies to one address. So the pairing is stated, not inferred.
 */
async function listCustomers({ limit = 100 } = {}) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY first.');

  const [customers, billing] = await Promise.all([
    stripe.customers.list({ limit }),
    db.all('billing'),
  ]);
  const linkedTo = new Map(billing.filter((b) => b.stripeCustomerId).map((b) => [b.stripeCustomerId, b.clientId]));

  return customers.data.map((c) => ({
    id: c.id,
    email: c.email || null,
    name: c.name || null,
    createdAt: isoFromUnix(c.created),
    delinquent: Boolean(c.delinquent),
    linkedClientId: linkedTo.get(c.id) || null,
  }));
}

/**
 * File a client under a Stripe customer, or unfile them.
 *
 * Unlinking releases the mirrored payments rather than deleting them: the rows
 * stay (they are Stripe's history, not ours to destroy) but stop being anyone's,
 * so a customer moved to the right client cannot leave the old one still
 * showing payments they never made.
 */
async function linkClient(clientId, stripeCustomerId) {
  const previous = await billingForClient(clientId);

  if (!stripeCustomerId) {
    if (previous?.stripeCustomerId) await releasePayments(clientId, previous.stripeCustomerId);
    await saveBilling(clientId, {
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      status: 'no_subscription',
      plan: null,
      amount: null,
      interval: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      cardBrand: null,
      cardLast4: null,
      latestInvoiceUrl: null,
    });
    return { clientId, stripeCustomerId: null, payments: 0 };
  }

  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY first.');

  // Fail before writing anything if the id is not a customer on this account.
  const customer = await stripe.customers.retrieve(stripeCustomerId);
  if (customer.deleted) throw new Error('That Stripe customer has been deleted.');

  // One customer belongs to one client. Taking it from another client releases
  // their payments too, or both would show the same money.
  const held = await billingForCustomer(stripeCustomerId);
  if (held && held.clientId !== clientId) {
    await releasePayments(held.clientId, stripeCustomerId);
    await db.update('billing', held.id, { stripeCustomerId: null, status: 'no_subscription', updatedAt: new Date().toISOString() });
  }
  if (previous?.stripeCustomerId && previous.stripeCustomerId !== stripeCustomerId) {
    await releasePayments(clientId, previous.stripeCustomerId);
  }

  await saveBilling(clientId, { stripeCustomerId });
  return { clientId, stripeCustomerId, customerName: customer.name || null, customerEmail: customer.email || null };
}

/** Detach a client's payment rows for one customer, keeping the rows. */
async function releasePayments(clientId, stripeCustomerId) {
  const rows = await db.filter('payments', (p) => p.clientId === clientId && p.stripeCustomerId === stripeCustomerId);
  for (const row of rows) await db.update('payments', row.id, { clientId: null });
  return rows.length;
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
  listCustomers,
  linkClient,
  releasePayments,
  summariseForClient,
};
