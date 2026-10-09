/**
 * Plan shapes, as the server sends them.
 *
 * Types only. Not one price, perk or discount is written in this file, and
 * none ever should be: lib/plans.js on the server is the single source of
 * truth and `GET /api/plans` is how this bundle reads it. A number typed here
 * would be a second price list, and a second price list is how a client reads
 * $19 on the plans modal and is charged $29 on the next screen.
 */

export type PlanKey = "unlimited" | "managed" | "basic";

export type SubscriptionStatus =
  | "pending_payment"
  /** A downgrade that starts when the period already paid for runs out. */
  | "scheduled"
  | "active"
  | "past_due"
  | "cancelled"
  | "expired";

export interface PlanPeriod {
  months: 1 | 3 | 6 | 12;
  label: string;
  shortLabel: string;
  discount: number;
  discountLabel: string | null;
}

export interface PlanPrice extends PlanPeriod {
  currency: "USD";
  total: number;
  /** What the same months would cost at the monthly rate. */
  undiscounted: number;
  saving: number;
  /** "Works out to $23.20 a month." */
  perMonth: number;
}

/** Where in the dashboard an entitlement can actually be seen. */
export interface EntitlementSurface {
  label: string;
  to: string;
}

export interface Entitlement {
  key: string;
  label: string;
  surface: EntitlementSurface | null;
  /** Has a real panel a lower plan can look at in a locked state. */
  locked: boolean;
}

export interface Plan {
  key: PlanKey;
  name: string;
  rank: number;
  badge: string | null;
  promise: string;
  bestFor: string;
  currency: "USD";
  monthlyUsd: number;
  /** null means no cap. */
  updateRequestsPerMonth: number | null;
  /** Past the included allowance the work is quoted and charged, not refused. */
  extraUpdatesChargeable: boolean;
  /** null means every category. */
  ticketCategories: string[] | null;
  prices: PlanPrice[];
  entitlements: Entitlement[];
}

export interface PlanCatalogue {
  currency: "USD";
  paymentMode: "manual" | "stripe";
  periods: PlanPeriod[];
  plans: Plan[];
}

export interface Subscription {
  id: string;
  clientId: string;
  planKey: PlanKey;
  planName: string;
  period: 1 | 3 | 6 | 12;
  periodLabel: string;
  status: SubscriptionStatus;
  currency: "USD";
  /** What they were actually asked for, which may be less than the list price. */
  amountUsd: number;
  listAmountUsd: number | null;
  creditUsd: number | null;
  /** Only set on a scheduled row: the day the cheaper plan may begin. */
  startsAt: string | null;
  startedAt: string | null;
  renewsAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  handoverRequestedAt: string | null;
  markedPaidAt: string | null;
  unlockSeenAt: string | null;
  previousSubscriptionId: string | null;
}

export interface UpdateAllowance {
  unlimited: boolean;
  /** null when there is nothing to count against. */
  included: number | null;
  used: number;
  /** Requests past the allowance, which we quote and charge separately. */
  extraUsed: number;
  remaining: number | null;
  periodStart: string | null;
  resetsAt: string | null;
}

/** What a plan costs this client right now, with the working shown. */
export interface Quote {
  planKey: PlanKey;
  planName: string;
  period: 1 | 3 | 6 | 12;
  currency: "USD";
  listAmountUsd: number;
  creditUsd: number;
  amountUsd: number;
  kind: "new" | "renewal" | "upgrade" | "downgrade";
  /** A downgrade is not bought now; it starts when the paid period ends. */
  scheduled: boolean;
  startsAt: string | null;
  dueNowUsd: number;
  from: {
    planKey: PlanKey;
    planName: string;
    subscriptionId: string;
    renewsAt: string | null;
  } | null;
}

/** The 'you unlocked' moment, owed once per subscription. */
export interface Unlock {
  subscriptionId: string;
  planKey: PlanKey;
  planName: string;
  fromPlanName: string | null;
  isUpgrade: boolean;
  /** Only what is new to them. For an upgrade, strictly the difference. */
  gained: { key: string; label: string; surface: EntitlementSurface | null }[];
  canRaiseRequest: boolean;
}

export interface Membership {
  clientId: string | null;
  subscription: Subscription | null;
  /** A plan chosen and not yet paid for. Sits alongside an active one. */
  pendingSubscription: Subscription | null;
  /**
   * A downgrade that begins when the paid period ends. Neither awaiting
   * payment nor the plan they are on, so it is reported on its own.
   */
  scheduledSubscription: Subscription | null;
  /** The plan they are paying for. Never a plan that is awaiting payment. */
  planKey: PlanKey | null;
  plan: Plan | null;
  /** The plan whose perks are unlocked, which includes the grandfather clause. */
  effectivePlanKey: PlanKey | null;
  entitlements: string[];
  locked: { key: string; label: string; surface: EntitlementSurface | null }[];
  /** Never paid us for a plan, so nothing is gated for them yet. */
  grandfathered: boolean;
  /** Worth asking them to choose one. Never gates access on its own. */
  needsPlan: boolean;
  awaitingPayment: boolean;
  pastDue: boolean;
  /** A cancellation that has not run out yet: when hosting ends. */
  endingAt: string | null;
  usage: UpdateAllowance;
  /** Non-null when the unlock modal is still owed. */
  unlock: Unlock | null;
  upgradeTo: PlanKey | null;
  paymentMode: "manual" | "stripe";
}

/** Whether a membership includes an entitlement. The one question UI asks. */
export function hasEntitlement(
  membership: Membership | null | undefined,
  key: string,
): boolean {
  return Boolean(membership?.entitlements.includes(key));
}

/** One plan's price for one period, or undefined if that period is not offered. */
export function priceFor(plan: Plan | null | undefined, months: number) {
  return plan?.prices.find((p) => p.months === months);
}

/**
 * "$29" / "$147.90". Mirrors formatUsd in lib/plans.js, because a price shown
 * as "$29.00" on a card reads like a form field rather than a price.
 */
export function usd(amount: number | null | undefined): string {
  if (amount == null) return "";
  const rounded = Math.round(amount * 100) / 100;
  return `$${rounded.toFixed(Number.isInteger(rounded) ? 0 : 2)}`;
}

/** The weekly upgrade prompt, built on the server so the browser only renders it. */
export interface UpsellPrompt {
  messageKey: string;
  message: string;
  from: { key: PlanKey; name: string; monthlyUsd: number; entitlements: Entitlement[] };
  to: { key: PlanKey; name: string; monthlyUsd: number; entitlements: Entitlement[] };
  /** Only what the upgrade adds. */
  gained: Entitlement[];
  differenceUsd: number;
  quote: Quote;
}
