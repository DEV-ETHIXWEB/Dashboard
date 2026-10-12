'use strict';

/**
 * Finding an account by its email address, asked of the database rather than
 * of the whole table.
 *
 * Every path that did this read every user in the workspace and compared in
 * JavaScript -- on sign-in, on every link sign-in, on every account creation.
 * Two things were wrong with that beyond the cost. On Firestore each of those
 * rows is a billed read. And `u.email.toLowerCase()` throws on a row with no
 * email at all, which means one malformed record anywhere in the table makes
 * signing in fail for everybody, with a 500 and no clue why.
 *
 * Addresses are stored lowercased, so the indexed equality lookup is the
 * answer in every ordinary case. The scan is kept as a fallback for rows that
 * predate that rule -- and it is written defensively, because the whole point
 * is that one bad row must not take the workspace down.
 */

const { db } = require('../db/setup');

/** The address as it is stored, or null if that is not an address at all. */
function normalise(email) {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

/**
 * The account for this address, or null.
 *
 * The indexed read first. The scan only when that finds nothing, which on a
 * workspace with no legacy rows is only ever for an address that does not
 * exist -- and an address that does not exist is the one case where spending
 * a scan costs nobody anything.
 */
async function findByEmail(email) {
  const wanted = normalise(email);
  if (!wanted) return null;

  const direct = await db.where('users', { email: wanted });
  if (direct.length > 0) return direct[0];

  const all = await db.all('users');
  return all.find((u) => normalise(u.email) === wanted) || null;
}

/** Every account for this address. Only a broken workspace has more than one. */
async function allByEmail(email) {
  const wanted = normalise(email);
  if (!wanted) return [];
  const all = await db.all('users');
  return all.filter((u) => normalise(u.email) === wanted);
}

module.exports = { findByEmail, allByEmail, normalise };
