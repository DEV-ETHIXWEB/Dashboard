'use strict';

/**
 * Membership plans, periods, prices and entitlements. The only place any of
 * these numbers exist.
 *
 * Every screen, every email and every permission check reads from here. The
 * browser gets the same object over `GET /api/plans` rather than a second copy
 * in the frontend bundle, because two copies of a price list is how a client
 * ends up reading $19 on the plans modal and being charged $29.
 *
 * Period prices are *computed* from the monthly price and the discount, never
 * typed in. scripts/test-plans.js asserts all twelve of them against the sales
 * playbook table, so a change to a monthly price that the playbook does not
 * agree with fails the suite instead of reaching a client.
 */

/**
 * `manual` means we send payment details and an admin marks the subscription
 * paid; `stripe` means Stripe Checkout and a webhook do it.
 *
 * Manual is the default because the sales playbook is explicit: payment
 * details go out after Call 2, and setup never starts before payment is
 * confirmed. The Stripe path is a switch rather than a rewrite -- everything
 * below is provider-agnostic, and routes/plans.js branches in one place.
 */
function paymentMode() {
  return String(process.env.PAYMENT_MODE || 'manual').trim().toLowerCase() === 'stripe'
    ? 'stripe'
    : 'manual';
}

/** USD, everywhere, with no second currency to fall back to. See the playbook. */
const CURRENCY = 'USD';

/**
 * The four billing periods, and what each one takes off the monthly price.
 *
 * Monthly is first and is the default the plans modal opens on: the playbook's
 * rule is to use the discount to close, not to open.
 */
const PERIODS = [
  { months: 1, label: 'Monthly', shortLabel: 'Monthly', discount: 0 },
  { months: 3, label: '3 months', shortLabel: '3 mo', discount: 0.10 },
  { months: 6, label: '6 months', shortLabel: '6 mo', discount: 0.15 },
  { months: 12, label: '12 months', shortLabel: '12 mo', discount: 0.20 },
];

const PERIOD_MONTHS = PERIODS.map((p) => p.months);

/**
 * Round to cents, away from zero.
 *
 * Not decoration: 29 * 6 * 0.85 is 147.89999999999998 in binary floating point,
 * and a plans modal reading "$147.90" beside a payment request for
 * "$147.89999999999998" is the kind of detail that costs a sale.
 */
function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * What one plan costs for one period, and everything a screen wants to say
 * about that: the total, what it saves, and the per-month figure that makes a
 * twelve-month commitment sound like a small one.
 */
function priceFor(monthlyUsd, months) {
  const period = PERIODS.find((p) => p.months === months);
  if (!period) throw new Error(`Unknown billing period: ${months}`);

  const full = money(monthlyUsd * months);
  const total = money(full * (1 - period.discount));

  return {
    months,
    label: period.label,
    shortLabel: period.shortLabel,
    discount: period.discount,
    discountLabel: period.discount ? `${Math.round(period.discount * 100)}% off` : null,
    currency: CURRENCY,
    total,
    // What they would have paid at the monthly rate, so "save $69.60" is a
    // subtraction a client can check rather than a claim.
    undiscounted: full,
    saving: money(full - total),
    // "Works out to $23.20 a month". The playbook leads on this figure for the
    // yearly plans and it has to match the printed table exactly.
    perMonth: money(total / months),
  };
}

/**
 * One entitlement: what it unlocks, and where in the dashboard the client can
 * see it.
 *
 * `surface` is not documentation. The unlock modal turns each newly gained
 * entitlement into a link, so a perk with no surface is a perk the client
 * cannot find, and a perk they cannot find is one they will not renew for.
 *
 * `locked` marks the ones that have a real panel a lower plan can look at in a
 * locked state. The rest are either already visible to everyone (hosting) or
 * have nothing to preview (dashboard access).
 */
const ENTITLEMENTS = [
  {
    key: 'hosting',
    short: 'Secure hosting',
    label: 'Secure hosting on our Cloudways servers',
    plans: ['basic', 'managed', 'unlimited'],
    surface: { label: 'See your website status', to: '/portal/domains' },
  },
  {
    key: 'dashboard_access',
    short: 'Client dashboard',
    label: 'Access to the Ethixweb client dashboard',
    plans: ['basic', 'managed', 'unlimited'],
    surface: { label: 'Open your dashboard', to: '/portal' },
  },
  {
    key: 'self_service',
    short: 'You make the changes',
    label: 'You handle your own updates and changes',
    plans: ['basic'],
    surface: null,
  },
  {
    key: 'managed_dashboard',
    short: 'We manage it for you',
    label: 'We manage your dashboard for you',
    plans: ['managed', 'unlimited'],
    surface: { label: 'Open your dashboard', to: '/portal' },
  },
  {
    key: 'update_requests',
    short: 'Update requests',
    // Filled in per plan below, because the sentence changes with the number.
    label: 'Update requests',
    plans: ['managed', 'unlimited'],
    surface: { label: 'Raise a request', to: '/portal/tickets' },
  },
  {
    key: 'software_plugin_updates',
    short: 'Software updates',
    label: 'Regular software and plugin updates',
    plans: ['managed', 'unlimited'],
    surface: { label: 'See your maintenance log', to: '/portal/domains#maintenance' },
    locked: true,
  },
  {
    key: 'monthly_health_check',
    short: 'Monthly health check',
    label: 'Monthly website health check',
    plans: ['managed', 'unlimited'],
    surface: { label: 'View your health check', to: '/portal/domains#health' },
    locked: true,
  },
  {
    key: 'ticket_support',
    short: 'Ticket support',
    label: 'Support through dashboard tickets',
    plans: ['managed', 'unlimited'],
    surface: { label: 'Open your requests', to: '/portal/tickets' },
  },
  {
    key: 'priority_sla',
    short: 'Priority support',
    label: 'Priority support with a guaranteed response time',
    plans: ['unlimited'],
    surface: { label: 'See your response times', to: '/portal/tickets' },
  },
  {
    key: 'advanced_security',
    short: 'Advanced security',
    label: 'Advanced security: firewall, malware scans, security patches',
    plans: ['unlimited'],
    surface: { label: 'View your security panel', to: '/portal/domains#security' },
    locked: true,
  },
  {
    key: 'daily_backups',
    short: 'Daily backups',
    label: 'Daily backups with quick restore',
    plans: ['unlimited'],
    surface: { label: 'See your backups', to: '/portal/domains#backups' },
    locked: true,
  },
  {
    key: 'uptime_monitoring',
    short: '24/7 uptime',
    label: '24/7 uptime monitoring',
    plans: ['unlimited'],
    surface: { label: 'View uptime', to: '/portal/domains#uptime' },
    locked: true,
  },
  {
    key: 'organic_seo',
    short: 'Ongoing SEO',
    label: 'Ongoing organic SEO: on-page fixes, meta tags, sitemaps',
    plans: ['unlimited'],
    surface: { label: 'See your SEO work log', to: '/portal/domains#seo' },
    locked: true,
  },
  {
    key: 'speed_optimisation',
    short: 'Speed tuning',
    label: 'Speed and performance optimisation',
    plans: ['unlimited'],
    surface: { label: 'View performance', to: '/portal/domains#performance' },
    locked: true,
  },
  {
    key: 'monthly_report',
    short: 'Monthly report',
    label: 'Monthly performance report',
    plans: ['unlimited'],
    // A filter inside the Reports page the client already knows, not a second
    // page called Reports sitting next to the first one.
    surface: { label: 'Read your monthly report', to: '/portal/reports?category=monthly-report' },
    locked: true,
  },
  {
    key: 'proactive_updates',
    short: 'Proactive updates',
    label: 'Proactive internal updates, done for you',
    plans: ['unlimited'],
    surface: null,
  },
];

const ENTITLEMENT_KEYS = ENTITLEMENTS.map((e) => e.key);

/**
 * The three plans, in the order every screen shows them.
 *
 * Highest first, always. The playbook's rule is to present $29, then $19, then
 * $9, and opening with the cheapest plan is on its list of things not to do.
 */
const PLANS = [
  {
    key: 'unlimited',
    name: 'Unlimited',
    // Sorts an upgrade from a downgrade without anything having to hardcode
    // which plan is "above" which.
    rank: 3,
    monthlyUsd: 29,
    badge: 'Best value',
    promise: 'Your complete website team.',
    bestFor: 'Owners who want growth and zero website stress.',
    // null is unlimited, and is deliberately not Infinity: this object is
    // serialised to JSON for the browser, and JSON.stringify turns Infinity
    // into null anyway. Being explicit means the two agree.
    updateRequestsPerMonth: null,
    // Nothing is chargeable on top, because nothing is capped.
    extraUpdatesChargeable: false,
    ticketCategories: null, // null = every category
    highlights: ['update_requests', 'priority_sla', 'daily_backups', 'organic_seo'],
  },
  {
    key: 'managed',
    name: 'Managed',
    rank: 2,
    monthlyUsd: 19,
    badge: 'Most popular',
    promise: 'We host it and we look after it.',
    bestFor: 'Businesses that need a few changes each month.',
    updateRequestsPerMonth: 2,
    // Past two, the work still gets done -- it is quoted and charged per task
    // rather than refused. The amount is ours to decide per job, so nothing
    // here names a figure; the client is told we will quote it before any work
    // starts, which is also the honest answer when the size of the job is the
    // thing that decides the price.
    extraUpdatesChargeable: true,
    ticketCategories: null,
    highlights: ['update_requests', 'software_plugin_updates', 'monthly_health_check'],
  },
  {
    key: 'basic',
    name: 'Basic',
    rank: 1,
    monthlyUsd: 9,
    badge: null,
    promise: 'Hosting only. You manage the rest.',
    bestFor: 'Clients who just need their website kept live.',
    updateRequestsPerMonth: 0,
    extraUpdatesChargeable: false,
    // Self service, per the playbook -- but an outage or a billing question is
    // not a change request, and a client whose site is down must always be
    // able to reach us. Everything else gets the upgrade prompt.
    ticketCategories: ['Site down', 'Billing'],
    highlights: ['hosting', 'dashboard_access', 'self_service'],
  },
];

const PLAN_KEYS = PLANS.map((p) => p.key);

/**
 * Ticket categories that are not update requests.
 *
 * An outage is not a change, and a billing question is not work on the site --
 * neither should eat one of a Managed client's two monthly updates, and
 * neither should be refused to a Basic client who is paying us to keep their
 * site live. Everything else is a change request and is counted.
 *
 * Matched case-insensitively against the category the ticket form sends, so a
 * label tweak in the UI does not quietly start billing people for outages.
 */
const NON_UPDATE_CATEGORIES = ['Site down', 'Billing'];

function isUpdateRequest(category) {
  const value = String(category || '').trim().toLowerCase();
  return !NON_UPDATE_CATEGORIES.some((c) => c.toLowerCase() === value);
}

/**
 * Whether a plan may file a ticket under this category at all.
 *
 * `ticketCategories: null` means every category. Basic names the two it keeps,
 * and everything else gets the upgrade prompt rather than a refusal with no
 * way forward.
 */
function canFileCategory(planKey, category) {
  const plan = planFor(planKey);
  if (!plan) return false;
  if (plan.ticketCategories === null) return true;
  const value = String(category || '').trim().toLowerCase();
  return plan.ticketCategories.some((c) => c.toLowerCase() === value);
}

function isPlanKey(value) {
  return PLAN_KEYS.includes(value);
}

function isPeriod(value) {
  return PERIOD_MONTHS.includes(Number(value));
}

/** The raw plan definition, or null. Never throws: callers get untrusted input. */
function planFor(planKey) {
  return PLANS.find((p) => p.key === planKey) || null;
}

/**
 * The label an entitlement carries *for one plan*.
 *
 * Only the update allowance differs by plan, and it has to: "2 update requests
 * every month" and "Unlimited update requests" are the same entitlement saying
 * two different things, and a card that printed the generic word for both
 * would hide the single biggest difference between $19 and $29.
 */
function entitlementLabel(entitlement, plan) {
  if (entitlement.key !== 'update_requests') return entitlement.label;
  if (!plan) return entitlement.label;
  if (plan.updateRequestsPerMonth === null) return 'Unlimited update requests';
  if (plan.updateRequestsPerMonth === 1) return '1 update request every month';
  return `${plan.updateRequestsPerMonth} update requests every month`;
}

/**
 * The same thing in two or three words.
 *
 * A pricing card has room for four short lines, not four sentences, and an
 * email that has to be read in ten seconds on a phone cannot spend them on
 * "Ongoing organic SEO: on-page fixes, meta tags, sitemaps". Same source as
 * the long label so the two cannot describe different products.
 */
function entitlementShort(entitlement, plan) {
  if (entitlement.key !== 'update_requests') return entitlement.short || entitlement.label;
  if (!plan) return entitlement.short || entitlement.label;
  if (plan.updateRequestsPerMonth === null) return 'Unlimited requests';
  return `${plan.updateRequestsPerMonth} requests a month`;
}

/** The few a card leads with, already labelled. In the order the plan lists them. */
function highlightsFor(planKey) {
  const plan = planFor(planKey);
  if (!plan) return [];
  return (plan.highlights || [])
    .map((key) => ENTITLEMENTS.find((e) => e.key === key))
    .filter(Boolean)
    .map((e) => ({ key: e.key, label: entitlementShort(e, plan) }));
}

/** Whether a plan key includes an entitlement key. Unknown either way is false. */
function planHas(planKey, entitlementKey) {
  const entitlement = ENTITLEMENTS.find((e) => e.key === entitlementKey);
  if (!entitlement) return false;
  return entitlement.plans.includes(planKey);
}

/** Every entitlement a plan carries, in display order, already labelled. */
function entitlementsFor(planKey) {
  const plan = planFor(planKey);
  if (!plan) return [];
  return ENTITLEMENTS
    .filter((e) => e.plans.includes(planKey))
    .map((e) => ({
      key: e.key,
      label: entitlementLabel(e, plan),
      short: entitlementShort(e, plan),
      surface: e.surface,
      locked: Boolean(e.locked),
    }));
}

/**
 * What an upgrade actually gains them.
 *
 * The unlock modal lists only this, never the whole plan: somebody moving from
 * Managed to Unlimited already had hosting, and reading it back to them as
 * though it were new makes the step up look smaller than it is.
 */
function gainedEntitlements(fromPlanKey, toPlanKey) {
  const to = planFor(toPlanKey);
  if (!to) return [];
  return entitlementsFor(toPlanKey).filter((e) => {
    if (!fromPlanKey) return true;
    // The allowance is not a new perk when they already had one, but going
    // from a number to unlimited genuinely is, so it stays in the list.
    if (e.key === 'update_requests') {
      const from = planFor(fromPlanKey);
      if (!from) return true;
      return from.updateRequestsPerMonth !== to.updateRequestsPerMonth;
    }
    return !planHas(fromPlanKey, e.key);
  });
}

/**
 * The entitlement keys a plan does not have, limited to the ones with a real
 * panel behind them. This is what the locked-panel screens are driven by.
 */
function lockedEntitlementsFor(planKey) {
  return ENTITLEMENTS
    .filter((e) => e.locked && !e.plans.includes(planKey))
    .map((e) => ({ key: e.key, label: e.label, surface: e.surface }));
}

/** Which plan to push to someone on this one. Basic is sold Managed first. */
function recommendedUpgradeFor(planKey) {
  if (planKey === 'basic') return 'managed';
  if (planKey === 'managed') return 'unlimited';
  return null;
}

/**
 * One plan, with every period priced and every perk labelled: the shape the
 * plans modal, the billing page and the welcome email all render from.
 */
function describePlan(planKey) {
  const plan = planFor(planKey);
  if (!plan) return null;
  return {
    key: plan.key,
    name: plan.name,
    rank: plan.rank,
    badge: plan.badge,
    promise: plan.promise,
    bestFor: plan.bestFor,
    currency: CURRENCY,
    monthlyUsd: plan.monthlyUsd,
    updateRequestsPerMonth: plan.updateRequestsPerMonth,
    extraUpdatesChargeable: plan.extraUpdatesChargeable,
    ticketCategories: plan.ticketCategories,
    highlights: highlightsFor(plan.key),
    prices: PERIOD_MONTHS.map((months) => priceFor(plan.monthlyUsd, months)),
    entitlements: entitlementsFor(plan.key),
  };
}

/** Every plan in display order, fully described. What `GET /api/plans` returns. */
function describeAll() {
  return {
    currency: CURRENCY,
    paymentMode: paymentMode(),
    periods: PERIODS.map((p) => ({
      months: p.months,
      label: p.label,
      shortLabel: p.shortLabel,
      discount: p.discount,
      discountLabel: p.discount ? `${Math.round(p.discount * 100)}% off` : null,
    })),
    plans: PLANS.map((p) => describePlan(p.key)),
  };
}

/** The one price a subscription is created at. Throws on input it cannot price. */
function amountFor(planKey, months) {
  const plan = planFor(planKey);
  if (!plan) throw new Error(`Unknown plan: ${planKey}`);
  return priceFor(plan.monthlyUsd, Number(months)).total;
}

/**
 * "$29" / "$147.90". Whole dollars lose the cents, because "$29.00 / month" on
 * a pricing card reads like a form field rather than a price.
 */
function formatUsd(amount) {
  const value = money(amount);
  const decimals = Number.isInteger(value) ? 0 : 2;
  return `$${value.toFixed(decimals)}`;
}

/** When a period that starts now comes up for renewal. */
function renewalDate(startedAt, months) {
  const start = startedAt instanceof Date ? new Date(startedAt.getTime()) : new Date(startedAt);
  if (Number.isNaN(start.getTime())) throw new Error('renewalDate needs a valid start date');
  const out = new Date(start.getTime());
  // setUTCMonth rolls the year over by itself. It also clamps nothing, so a
  // subscription started on the 31st renews on the 1st or 2nd of the following
  // month in a short month -- which is the behaviour a client would expect
  // over silently moving their renewal to the 28th forever.
  out.setUTCMonth(out.getUTCMonth() + Number(months));
  return out;
}

module.exports = {
  CURRENCY,
  PERIODS,
  PERIOD_MONTHS,
  PLANS,
  PLAN_KEYS,
  NON_UPDATE_CATEGORIES,
  isUpdateRequest,
  canFileCategory,
  ENTITLEMENTS,
  ENTITLEMENT_KEYS,
  paymentMode,
  isPlanKey,
  isPeriod,
  planFor,
  planHas,
  entitlementsFor,
  entitlementShort,
  highlightsFor,
  entitlementLabel,
  gainedEntitlements,
  lockedEntitlementsFor,
  recommendedUpgradeFor,
  describePlan,
  describeAll,
  priceFor,
  amountFor,
  formatUsd,
  renewalDate,
  money,
};
