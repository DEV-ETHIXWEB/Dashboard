'use strict';

/**
 * What the admin user editor is allowed to write.
 *
 * The rule this file exists to enforce: a request body is a wish list, not a
 * patch. Copying it onto the row is what let an ordinary admin hand itself
 * `isSuperAdmin`, and it is the same shape of mistake wherever an object is
 * persisted wholesale. So the editor names its fields, and anything else is
 * refused by name rather than quietly dropped -- a caller that aimed at a
 * privilege flag should be told no, not left believing it worked.
 *
 * Admin standing (`isSuperAdmin`, `adminTrusted`) is deliberately absent. It is
 * changed on POST /api/users/:id/standing, by a super admin, and nowhere else.
 *
 * Lives in utils/ rather than in the route because the approval queue executes
 * the same patch later, from a different file, and has to apply the identical
 * rule to it.
 */

/** Columns an administrator may set on somebody else's account. */
const EDITABLE_USER_FIELDS = [
  'name',
  'email',
  'company',
  'role',
  'allowedPages',
  'passwordExpiresAt',
  'slackChannelId',
  'slackChannelName',
];

/**
 * Accepted in the body and acted on, but never written to the row as-is:
 * `password` is hashed first, `regeneratePassword` mints one, and `sendEmail`
 * only decides whether the result is emailed.
 */
const CONTROL_FIELDS = ['password', 'regeneratePassword', 'sendEmail'];

const EDITABLE = new Set(EDITABLE_USER_FIELDS);
const CONTROL = new Set(CONTROL_FIELDS);

/** Field names in this body that the editor will not accept. */
function unknownFields(body) {
  return Object.keys(body || {}).filter((k) => k !== 'id' && !EDITABLE.has(k) && !CONTROL.has(k));
}

/**
 * Deliberately permissive about what an address may look like, and strict
 * about it being an address at all.
 *
 * Real addresses are stranger than most patterns allow -- plus-tags, long new
 * TLDs, apostrophes, non-ASCII local parts -- and a clever pattern that
 * rejects a real customer is a worse failure than a loose one that accepts an
 * odd-looking address. So this asks only the questions that must be true:
 * something, one @, something, a dot, something, and no whitespace.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * An email as it should be stored, or null if it is not an email at all.
 *
 * The reason this exists: `email` arrives from JSON and JSON has types. A
 * body carrying `{"email": true}` used to be written to the row as the string
 * "true", which is not an address anybody can be reached at -- and because an
 * address is how somebody signs in, it locked the account out of the product
 * as well as out of their inbox. Numbers, arrays and objects all did the
 * same. The self-service version of the same screen did not store rubbish; it
 * raised a 500 trying to lowercase it.
 *
 * Stored lowercase and trimmed, because every comparison in the application
 * already lowercases both sides and two spellings of one address is how two
 * accounts end up fighting over one sign-in.
 */
function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(email)) return null;
  // Long enough to be suspicious rather than long enough to be real, and the
  // column is TEXT, so this is about keeping a sane row rather than a limit
  // anybody will meet.
  if (email.length > 254) return null;
  return email;
}

/**
 * A display name as it should be stored, or null if it is not usable.
 *
 * Same reasoning as the address: `{"name": {}}` was being written to the row
 * as the string "{}", and a client called "{}" appears that way in every email
 * and on every screen.
 */
function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) return null;
  return name.length > 200 ? name.slice(0, 200) : name;
}

/** Just the editable fields the caller actually supplied. */
function pickEditable(body) {
  const out = {};
  for (const key of EDITABLE_USER_FIELDS) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
}

/**
 * Strip a stored patch back to editable fields before it is applied.
 *
 * The queue already stores a sanitised patch, so this is the second lock on
 * the same door: an approval written by an older build, or a row edited in the
 * database by hand, still cannot grant standing when it is executed.
 */
function sanitizePatch(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (EDITABLE.has(key)) out[key] = value;
    // `password` arrives here already hashed, from the route that hashed it.
    else if (key === 'password') out[key] = value;
  }
  // The age stamp is not a field anybody may set; it is a fact about the write
  // happening right now, so it is added here rather than accepted from the
  // caller. Doing it at the filter means a password cannot reach a row without
  // its clock being reset -- including down the approval path, where the patch
  // was written days earlier by a different process.
  if (out.password) {
    Object.assign(out, require('./passwordPolicy').stampChange());
  }
  return out;
}

module.exports = {
  EDITABLE_USER_FIELDS, CONTROL_FIELDS,
  unknownFields, pickEditable, sanitizePatch,
  normalizeEmail, normalizeName,
};
