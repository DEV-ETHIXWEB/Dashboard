'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit } = require('../middleware/auth');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const Stripe = require('stripe');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

router.use(requireAuth);

router.get('/status', async (req, res, next) => {
  try {
    const stripe = getStripe();
    if (req.user.role === 'client') {
      const existing = (await db.filter('billing', (b) => b.clientId === req.user.id))[0];
      return res.json({ enabled: Boolean(stripe), billing: existing || { status: 'no_subscription' } });
    }
    const all = await db.all('billing');
    res.json({ enabled: Boolean(stripe), billing: all });
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

    let existing = (await db.filter('billing', (b) => b.clientId === req.user.id))[0];
    let stripeCustomerId = existing?.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({ email: req.user.email, name: req.user.name });
      stripeCustomerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${req.protocol}://${req.get('host')}/portal.html?billing=success`,
      cancel_url: `${req.protocol}://${req.get('host')}/portal.html?billing=cancelled`,
    });

    if (existing) await db.update('billing', existing.id, { stripeCustomerId, updatedAt: new Date().toISOString() });
    else await db.insert('billing', { clientId: req.user.id, stripeCustomerId, plan: 'standard', status: 'pending', updatedAt: new Date().toISOString() });

    await audit(req.user.id, 'create', 'billing_checkout', stripeCustomerId);
    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

async function webhookHandler(req, res) {
  const stripe = getStripe();
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  try {
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
      const sub = event.data.object;
      const existing = (await db.filter('billing', (b) => b.stripeCustomerId === sub.customer))[0];
      if (existing) {
        await db.update('billing', existing.id, {
          stripeSubscriptionId: sub.id, status: sub.status, updatedAt: new Date().toISOString(),
        });
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook handling failed:', err);
    res.status(500).end();
  }
}

module.exports = router;
module.exports.webhookHandler = webhookHandler;
