'use strict';

/**
 * How old a password may get, and what to call it at each stage.
 *
 * One thing to be clear about before reading any of this: `passwordExpiresAt`
 * on a user is **not** what this file is about. That column is when the
 * *account* stops working -- an admin sets it when issuing a client login, and
 * middleware/auth.js refuses the sign-in outright once it passes. This file is
 * about the age of the secret itself, which is a different question with a
 * different answer: the person is still entitled to be here, they just have to
 * pick a new password first. Folding the two together would mean a client on a
 * monthly rotation losing their account on day thirty-one.
 *
 * Every value is configurable, because "monthly" is a policy decision and not a
 * fact about software. The defaults are a thirty-day life with five days of
 * warning, which is what most workspaces mean when they say monthly.
 */

/** Read a positive number from the environment, or fall back. */
function num(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * bcrypt hashes the first 72 bytes and silently ignores the rest. A field that
 * accepts a 200-character passphrase and quietly keeps a quarter of it is worse
 * than one that says no, because the person believes they have the long one.
 */
const MAX_PASSWORD_BYTES = 72;

function config() {
  return {
    // Off is a supported answer. A workspace that has decided rotation costs
    // more than it buys should be able to say so without editing code.
    enabled: String(process.env.PASSWORD_POLICY_ENABLED ?? 'true').toLowerCase() !== 'false',
    maxAgeDays: num('PASSWORD_MAX_AGE_DAYS', 30),
    warnDays: num('PASSWORD_WARN_DAYS', 5),
    minLength: Math.min(num('PASSWORD_MIN_LENGTH', 12), MAX_PASSWORD_BYTES),
    /** A reset link is used within the hour or not at all. */
    resetTtlMs: num('PASSWORD_RESET_TTL_MINUTES', 60) * MINUTE_MS,
    /**
     * An activation link is longer-lived on purpose: it lands in an inbox with
     * a scheduled delivery behind it, and the person it is for may not be at a
     * desk for a day or two.
     */
    activationTtlMs: num('PASSWORD_ACTIVATION_TTL_HOURS', 72) * 60 * MINUTE_MS,
  };
}

/** When this account's password becomes too old, or null when it never does. */
function expiresAt(user) {
  const { enabled, maxAgeDays } = config();
  if (!enabled) return null;
  if (!user || !user.password) return null; // Google-only accounts have nothing to rotate
  const changed = Number(user.passwordChangedAt);
  if (!Number.isFinite(changed) || changed <= 0) return null;
  return changed + maxAgeDays * DAY_MS;
}

/** Truthy in Postgres and Firestore alike -- the same normaliser roles.js uses. */
function flag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * Whether this account must set a new password before it can do anything else.
 *
 * Two ways to get here: an administrator or the monthly sweep raised the flag,
 * or the password simply aged out. A password with no recorded age is left
 * alone -- an unknown is not evidence of staleness, and treating it as one
 * would demand a reset from every account that predates this feature on the
 * morning it ships. db/setup.js stamps those rows once, at migration time.
 */
function isResetRequired(user) {
  if (!user) return false;
  if (!user.password) return false;
  if (flag(user.passwordResetRequired)) return true;
  const due = expiresAt(user);
  return due != null && due <= Date.now();
}

/** How recently a reset link was actually redeemed still counts as news. */
const RESET_RECENT_MS = 7 * DAY_MS;

const LABELS = {
  no_password: 'No password',
  reset_required: 'Reset required',
  expiring_soon: 'Expiring soon',
  reset_completed: 'Reset completed',
  active: 'Active',
};

/**
 * One account's password standing, in the words the dashboard shows.
 *
 * Deliberately says nothing an administrator should not see: no hash, no token,
 * no history beyond dates. Safe to hand to any caller that may see the user.
 */
function statusFor(user) {
  const cfg = config();
  const changedAt = Number(user && user.passwordChangedAt) || null;
  const resetAt = Number(user && user.passwordResetAt) || null;
  const due = expiresAt(user);
  const now = Date.now();

  const base = {
    changedAt,
    resetAt,
    expiresAt: due,
    daysLeft: due == null ? null : Math.ceil((due - now) / DAY_MS),
    resetRequired: false,
    policyEnabled: cfg.enabled,
    maxAgeDays: cfg.maxAgeDays,
    warnDays: cfg.warnDays,
    minLength: cfg.minLength,
  };

  if (!user || !user.password) return { ...base, state: 'no_password', label: LABELS.no_password };
  if (isResetRequired(user)) {
    return { ...base, state: 'reset_required', label: LABELS.reset_required, resetRequired: true };
  }
  if (due != null && due - now <= cfg.warnDays * DAY_MS) {
    return { ...base, state: 'expiring_soon', label: LABELS.expiring_soon };
  }
  // "Reset completed" is only worth saying while it is still recent news; after
  // a week it is just an account in good standing like any other.
  if (resetAt && now - resetAt <= RESET_RECENT_MS) {
    return { ...base, state: 'reset_completed', label: LABELS.reset_completed };
  }
  return { ...base, state: 'active', label: LABELS.active };
}

/**
 * The fields that go with a password write, so no caller has to remember them.
 *
 * Every place that sets a password -- account creation, an admin reset, the
 * self-service change, a redeemed link -- passes its patch through here. That
 * is what keeps the age honest: a password changed without stamping the time
 * would read as ancient forever, and one stamped without clearing the flag
 * would demand a second reset immediately.
 */
function stampChange(patch = {}, { viaReset = false, at = Date.now() } = {}) {
  return {
    ...patch,
    passwordChangedAt: at,
    passwordResetRequired: false,
    ...(viaReset ? { passwordResetAt: at } : {}),
  };
}

/**
 * Whether a proposed password is acceptable, and why not when it is not.
 *
 * Length first, because it is the only property that reliably buys anything.
 * The rest are the two failures a length rule does not catch: a single repeated
 * character, and the person's own name or address typed back at them.
 */
function rejectionFor(password, { email = '', name = '' } = {}) {
  const cfg = config();
  const value = typeof password === 'string' ? password : '';

  if (!value) return 'Enter a new password.';
  if (value.length < cfg.minLength) {
    return `Your password needs to be at least ${cfg.minLength} characters.`;
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
    return `That password is too long. Keep it under ${MAX_PASSWORD_BYTES} bytes -- anything past that is not actually stored.`;
  }
  if (/^(.)\1*$/.test(value)) return 'That is one character repeated. Use something harder to guess.';

  const localPart = String(email || '').split('@')[0];
  const lowered = value.toLowerCase();
  for (const personal of [localPart, name]) {
    const candidate = String(personal || '').trim().toLowerCase();
    if (candidate.length >= 4 && lowered.includes(candidate)) {
      return 'Your password cannot contain your own name or email address.';
    }
  }
  return null;
}

module.exports = {
  DAY_MS,
  MAX_PASSWORD_BYTES,
  config,
  expiresAt,
  isResetRequired,
  statusFor,
  stampChange,
  rejectionFor,
  flag,
};
