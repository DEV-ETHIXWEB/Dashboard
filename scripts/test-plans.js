'use strict';

/* The plan config, checked against the printed sales playbook. Run from the
   repo root:  npm run test:plans   (or npm test for the whole suite)

   Every number below was read off EthixWeb-Dashboard-Sales-Playbook.pdf v2.0.
   This file is the reason lib/plans.js computes period prices instead of
   listing them: if a monthly price or a discount changes without the playbook
   agreeing, the suite fails here rather than a client reading one figure on
   the plans modal and being charged another.                               */

const plans = require('../lib/plans');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log('\nplans: the price table');

/** Playbook section 03, read left to right. [monthly, 3mo, 6mo, 12mo, perMonthYearly] */
const PLAYBOOK = {
  unlimited: { monthly: 29, 3: 78.30, 6: 147.90, 12: 278.40, yearlyPerMonth: 23.20 },
  managed: { monthly: 19, 3: 51.30, 6: 96.90, 12: 182.40, yearlyPerMonth: 15.20 },
  basic: { monthly: 9, 3: 24.30, 6: 45.90, 12: 86.40, yearlyPerMonth: 7.20 },
};

/** Playbook section 03, the "save $X" figures beside each period price. */
const SAVINGS = {
  unlimited: { 3: 8.70, 6: 26.10, 12: 69.60 },
  managed: { 3: 5.70, 6: 17.10, 12: 45.60 },
  basic: { 3: 2.70, 6: 8.10, 12: 21.60 },
};

for (const [key, row] of Object.entries(PLAYBOOK)) {
  const plan = plans.describePlan(key);
  check(`${key} exists`, plan !== null);
  if (!plan) continue;

  eq(`${key} monthly price is $${row.monthly}`, plan.monthlyUsd, row.monthly);

  for (const months of [1, 3, 6, 12]) {
    const price = plan.prices.find((p) => p.months === months);
    const expected = months === 1 ? row.monthly : row[months];
    eq(`${key} ${months}mo total is ${plans.formatUsd(expected)}`, price.total, expected);
    eq(`${key} ${months}mo is priced in USD`, price.currency, 'USD');
  }

  const yearly = plan.prices.find((p) => p.months === 12);
  eq(`${key} yearly works out to ${plans.formatUsd(row.yearlyPerMonth)} a month`,
    yearly.perMonth, row.yearlyPerMonth);
}

console.log('\nplans: the discounts and what they save');

for (const [key, row] of Object.entries(SAVINGS)) {
  const plan = plans.describePlan(key);
  for (const months of [3, 6, 12]) {
    const price = plan.prices.find((p) => p.months === months);
    eq(`${key} ${months}mo saves ${plans.formatUsd(row[months])}`, price.saving, row[months]);
  }
}

eq('3 months is 10% off', plans.PERIODS.find((p) => p.months === 3).discount, 0.10);
eq('6 months is 15% off', plans.PERIODS.find((p) => p.months === 6).discount, 0.15);
eq('12 months is 20% off', plans.PERIODS.find((p) => p.months === 12).discount, 0.20);
eq('monthly has no discount', plans.PERIODS.find((p) => p.months === 1).discount, 0);
eq('monthly is the first period offered', plans.PERIODS[0].months, 1);

console.log('\nplans: display order and labels');

eq('three plans, no more', plans.PLANS.length, 3);
eq('highest first', plans.PLAN_KEYS.join(','), 'unlimited,managed,basic');
eq('Unlimited is the best value', plans.planFor('unlimited').badge, 'Best value');
eq('Managed is the most popular', plans.planFor('managed').badge, 'Most popular');
eq('Basic carries no badge', plans.planFor('basic').badge, null);
eq('Unlimited promise', plans.planFor('unlimited').promise, 'Your complete website team.');
eq('Managed promise', plans.planFor('managed').promise, 'We host it and we look after it.');
eq('Basic promise', plans.planFor('basic').promise, 'Hosting only. You manage the rest.');
eq('one currency, no alternatives', plans.CURRENCY, 'USD');

console.log('\nplans: update allowances');

eq('Basic includes no updates', plans.planFor('basic').updateRequestsPerMonth, 0);
eq('Managed includes 2 a month', plans.planFor('managed').updateRequestsPerMonth, 2);
eq('Unlimited has no cap', plans.planFor('unlimited').updateRequestsPerMonth, null);
check('Managed charges for extras past 2', plans.planFor('managed').extraUpdatesChargeable === true);
check('Unlimited never charges an extra', plans.planFor('unlimited').extraUpdatesChargeable === false);
check('Basic never charges an extra', plans.planFor('basic').extraUpdatesChargeable === false);

const managedUpdates = plans.entitlementsFor('managed').find((e) => e.key === 'update_requests');
eq('Managed card reads "2 update requests every month"',
  managedUpdates.label, '2 update requests every month');
const unlimitedUpdates = plans.entitlementsFor('unlimited').find((e) => e.key === 'update_requests');
eq('Unlimited card reads "Unlimited update requests"',
  unlimitedUpdates.label, 'Unlimited update requests');

console.log('\nplans: entitlements');

/** Playbook section 10, the quick-reference table, read as yes/no per plan. */
const MATRIX = {
  hosting: ['basic', 'managed', 'unlimited'],
  dashboard_access: ['basic', 'managed', 'unlimited'],
  software_plugin_updates: ['managed', 'unlimited'],
  monthly_health_check: ['managed', 'unlimited'],
  ticket_support: ['managed', 'unlimited'],
  priority_sla: ['unlimited'],
  advanced_security: ['unlimited'],
  daily_backups: ['unlimited'],
  uptime_monitoring: ['unlimited'],
  organic_seo: ['unlimited'],
  speed_optimisation: ['unlimited'],
  monthly_report: ['unlimited'],
};

for (const [entitlement, allowed] of Object.entries(MATRIX)) {
  for (const key of plans.PLAN_KEYS) {
    const want = allowed.includes(key);
    eq(`${key} ${want ? 'has' : 'does not have'} ${entitlement}`, plans.planHas(key, entitlement), want);
  }
}

check('every entitlement names at least one plan',
  plans.ENTITLEMENTS.every((e) => e.plans.length > 0));
check('every entitlement names only real plans',
  plans.ENTITLEMENTS.every((e) => e.plans.every((p) => plans.PLAN_KEYS.includes(p))));
check('entitlement keys are unique',
  new Set(plans.ENTITLEMENT_KEYS).size === plans.ENTITLEMENT_KEYS.length);

// A perk the client cannot find is a perk they will not renew for, so every
// locked panel has to name the place it lives.
check('every lockable entitlement links to a surface',
  plans.ENTITLEMENTS.filter((e) => e.locked).every((e) => e.surface && e.surface.to && e.surface.label));

console.log('\nplans: what an upgrade gains');

const basicToManaged = plans.gainedEntitlements('basic', 'managed').map((e) => e.key);
check('Basic to Managed gains the update allowance', basicToManaged.includes('update_requests'));
check('Basic to Managed gains ticket support', basicToManaged.includes('ticket_support'));
check('Basic to Managed does not re-announce hosting', !basicToManaged.includes('hosting'));
check('Basic to Managed does not promise daily backups', !basicToManaged.includes('daily_backups'));

const managedToUnlimited = plans.gainedEntitlements('managed', 'unlimited').map((e) => e.key);
check('Managed to Unlimited gains the SLA', managedToUnlimited.includes('priority_sla'));
check('Managed to Unlimited gains backups', managedToUnlimited.includes('daily_backups'));
check('Managed to Unlimited gains SEO', managedToUnlimited.includes('organic_seo'));
check('Managed to Unlimited lifts the update cap', managedToUnlimited.includes('update_requests'));
check('Managed to Unlimited does not re-announce the health check',
  !managedToUnlimited.includes('monthly_health_check'));

const freshUnlimited = plans.gainedEntitlements(null, 'unlimited').map((e) => e.key);
check('a brand new Unlimited client is shown everything',
  freshUnlimited.includes('hosting') && freshUnlimited.includes('daily_backups'));

eq('Basic is sold Managed first', plans.recommendedUpgradeFor('basic'), 'managed');
eq('Managed is sold Unlimited', plans.recommendedUpgradeFor('managed'), 'unlimited');
eq('Unlimited is never sold anything', plans.recommendedUpgradeFor('unlimited'), null);

console.log('\nplans: ticket categories');

eq('Basic can report an outage or ask about billing, nothing else',
  (plans.planFor('basic').ticketCategories || []).join(','), 'Site down,Billing');
eq('Managed has every category', plans.planFor('managed').ticketCategories, null);
eq('Unlimited has every category', plans.planFor('unlimited').ticketCategories, null);

console.log('\nplans: locked panels');

const basicLocked = plans.lockedEntitlementsFor('basic').map((e) => e.key);
check('Basic sees backups locked', basicLocked.includes('daily_backups'));
check('Basic sees the health check locked', basicLocked.includes('monthly_health_check'));
const managedLocked = plans.lockedEntitlementsFor('managed').map((e) => e.key);
check('Managed sees uptime locked', managedLocked.includes('uptime_monitoring'));
check('Managed does not see the health check locked', !managedLocked.includes('monthly_health_check'));
eq('Unlimited has nothing locked', plans.lockedEntitlementsFor('unlimited').length, 0);

console.log('\nplans: input it cannot trust');

check('an unknown plan key is refused', plans.isPlanKey('enterprise') === false);
check('a real plan key is accepted', plans.isPlanKey('managed') === true);
check('a non-string plan key is refused', plans.isPlanKey(null) === false);
check('an unknown period is refused', plans.isPeriod(9) === false);
check('a real period is accepted', plans.isPeriod(6) === true);
check('a period sent as a string still prices', plans.isPeriod('12') === true);
eq('an unknown plan describes as null', plans.describePlan('enterprise'), null);
eq('an unknown plan carries no entitlements', plans.entitlementsFor('enterprise').length, 0);
check('an unknown entitlement is never granted', plans.planHas('unlimited', 'free_lunch') === false);

let threw = false;
try { plans.amountFor('enterprise', 1); } catch { threw = true; }
check('pricing an unknown plan throws rather than guessing', threw);

threw = false;
try { plans.priceFor(29, 9); } catch { threw = true; }
check('pricing an unknown period throws rather than guessing', threw);

console.log('\nplans: formatting and renewal dates');

eq('a whole-dollar price loses the cents', plans.formatUsd(29), '$29');
eq('a part-dollar price keeps them', plans.formatUsd(147.9), '$147.90');
eq('a float that should be a round price still prints clean',
  plans.formatUsd(29 * 6 * 0.85), '$147.90');
eq('amountFor agrees with the table', plans.amountFor('unlimited', 12), 278.40);

eq('a monthly plan renews a month out',
  plans.renewalDate('2026-01-15T00:00:00.000Z', 1).toISOString().slice(0, 10), '2026-02-15');
eq('a yearly plan renews a year out',
  plans.renewalDate('2026-01-15T00:00:00.000Z', 12).toISOString().slice(0, 10), '2027-01-15');
eq('a six month plan crossing the new year renews correctly',
  plans.renewalDate('2026-10-08T00:00:00.000Z', 6).toISOString().slice(0, 10), '2027-04-08');

threw = false;
try { plans.renewalDate('not a date', 1); } catch { threw = true; }
check('an unreadable start date throws rather than producing Invalid Date', threw);

console.log('\nplans: the payload the browser receives');

const payload = plans.describeAll();
eq('payload names the currency once', payload.currency, 'USD');
eq('payload carries four periods', payload.periods.length, 4);
eq('payload carries three plans', payload.plans.length, 3);
eq('payload keeps the display order',
  payload.plans.map((p) => p.key).join(','), 'unlimited,managed,basic');
check('payload survives JSON without losing a price', (() => {
  const round = JSON.parse(JSON.stringify(payload));
  const unlimited = round.plans.find((p) => p.key === 'unlimited');
  return unlimited.prices.find((p) => p.months === 12).total === 278.40
    && unlimited.updateRequestsPerMonth === null;
})());
check('payload names the payment mode', ['manual', 'stripe'].includes(payload.paymentMode));
eq('manual is the default payment mode', plans.paymentMode(), 'manual');

process.env.PAYMENT_MODE = 'stripe';
eq('PAYMENT_MODE=stripe switches the mode', plans.paymentMode(), 'stripe');
process.env.PAYMENT_MODE = 'nonsense';
eq('an unreadable PAYMENT_MODE falls back to manual', plans.paymentMode(), 'manual');
delete process.env.PAYMENT_MODE;

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
