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
  return out;
}

module.exports = { EDITABLE_USER_FIELDS, CONTROL_FIELDS, unknownFields, pickEditable, sanitizePatch };
