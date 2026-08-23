'use strict';

/**
 * Backup codes for administrators.
 *
 * Administrators sign in with a password and an emailed code. That is the right
 * shape for the accounts that can reach everyone else's data, but it puts the
 * mail transport on the critical path of getting into the building: if mail
 * breaks while every admin happens to be signed out, nobody can get in, and the
 * Login Codes page is no help because reaching it requires already being signed
 * in.
 *
 * So each administrator holds eight one-time codes, shown once and never again,
 * that stand in for the emailed one. They are the second factor, not a way past
 * it -- the password step still has to be completed first, exactly as it is for
 * an emailed code.
 *
 * Only the bcrypt hash is stored, so the table is not a list of working
 * credentials. A code is consumed the moment it succeeds, and using one is
 * announced to every other admin: signing in this way is a break-glass event,
 * and a quiet one would be worse than no record at all.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

/** How many a fresh set contains. Enough to survive a bad week, few enough to keep. */
const CODE_COUNT = 8;

/** Half a code. Two halves, so it reads as XXXXX-XXXXX. */
const GROUP_LENGTH = 5;

/**
 * No I, L, O, U, 0 or 1. These get read down a phone line and written on paper,
 * and the characters people confuse are not worth the extra entropy.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** One code's worth of randomness: 30^10, a little over 49 bits. */
function generateCode() {
  const bytes = crypto.randomBytes(GROUP_LENGTH * 2);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i === GROUP_LENGTH) out += '-';
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/**
 * What the user typed, reduced to what was actually meant.
 *
 * People paste these with the dash, without it, in lower case, or with a stray
 * space from a password manager. All of those are the same code.
 */
function normalize(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Whether this input is even shaped like a recovery code.
 *
 * Used to decide which of the two checks to run, so a mistyped six-digit code
 * never costs eight bcrypt comparisons, and a recovery attempt never burns one
 * of the five tries on the emailed code.
 */
function looksLikeRecoveryCode(input) {
  const clean = normalize(input);
  if (clean.length !== GROUP_LENGTH * 2) return false;
  return [...clean].every((c) => ALPHABET.includes(c));
}

/**
 * Replace this administrator's set and hand back the plaintext, once.
 *
 * Regenerating always invalidates every earlier code. That is what makes this
 * the recovery path for "somebody else may have seen my list" as well as for
 * "I have used most of them".
 */
async function issueFor(userId) {
  const { db } = require('../db/setup');
  await db.removeWhere('recovery_codes', (r) => r.userId === userId);

  const codes = Array.from({ length: CODE_COUNT }, generateCode);
  const createdAt = new Date().toISOString();
  for (const code of codes) {
    await db.insert('recovery_codes', {
      id: uuidv4(),
      userId,
      codeHash: bcrypt.hashSync(normalize(code), 10),
      createdAt,
      usedAt: null,
    });
  }
  return codes;
}

/**
 * Spend one code, if it is theirs and unused.
 *
 * Every unused code is compared, rather than stopping at the first mismatch,
 * so the work done does not depend on which code was submitted.
 */
async function verifyAndConsume(userId, submitted) {
  const { db } = require('../db/setup');
  const clean = normalize(submitted);
  if (!looksLikeRecoveryCode(clean)) return false;

  const rows = await db.filter('recovery_codes', (r) => r.userId === userId && !r.usedAt);
  let matched = null;
  for (const row of rows) {
    if (bcrypt.compareSync(clean, row.codeHash)) matched = row;
  }
  if (!matched) return false;

  // Claim it before the caller acts on the answer. Two tabs racing on the same
  // code means one of them finds it already spent.
  const claimed = await db.filter('recovery_codes', (r) => r.id === matched.id && !r.usedAt);
  if (claimed.length === 0) return false;
  await db.update('recovery_codes', matched.id, { usedAt: new Date().toISOString() });
  return true;
}

/** How many are left, for the page that offers to make more. Never the codes. */
async function statusFor(userId) {
  const { db } = require('../db/setup');
  const rows = await db.filter('recovery_codes', (r) => r.userId === userId);
  const unused = rows.filter((r) => !r.usedAt);
  return {
    total: rows.length,
    remaining: unused.length,
    used: rows.length - unused.length,
    generatedAt: rows[0]?.createdAt || null,
  };
}

/** Drop the set entirely -- the account is gone, or is no longer an admin. */
async function clearFor(userId) {
  const { db } = require('../db/setup');
  return db.removeWhere('recovery_codes', (r) => r.userId === userId);
}

module.exports = {
  CODE_COUNT,
  generateCode,
  normalize,
  looksLikeRecoveryCode,
  issueFor,
  verifyAndConsume,
  statusFor,
  clearFor,
};
