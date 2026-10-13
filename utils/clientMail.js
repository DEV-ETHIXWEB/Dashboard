'use strict';

/**
 * Whether a client may be emailed yet, and which messages they get.
 *
 * Clients arrive in this dashboard before they have agreed to pay for
 * anything. A site already running on our servers gets a profile here so there
 * is something to hang their domains, projects and payments on -- but until
 * they take a membership they must hear nothing from us. Not a welcome, not a
 * renewal reminder, and not a monthly service digest that a cron job decides
 * to send eight weeks after anybody was thinking about it. "Nothing" has to
 * mean nothing: the single message that escapes is the one that reads as us
 * billing somebody who never signed up.
 *
 * So the rule is enforced at the one door every email in this app leaves by --
 * `sendMail` and `sendNow` in utils/mailer.js -- and not at the thirty-odd
 * places that send one. A feature added next month inherits it by default
 * rather than needing somebody to remember.
 *
 * Two levels, both on the user row:
 *
 *   mailEnabled   false      this client hears nothing at all
 *                 true/null  normal. Null is every account that predates this
 *                            field, and those must keep receiving exactly what
 *                            they receive today -- a silent switch-off of live
 *                            clients would be a worse bug than the one this
 *                            feature fixes.
 *   mailOptOuts   template keys this client is not sent while mail is on, so
 *                 a client can be on the monthly digest but off the ads update
 *
 * Only accounts with role 'client' are ever gated. Staff addresses, admin
 * notifications, and anything sent to an address with no account behind it go
 * out untouched: this exists to protect a client from us, not to filter our
 * own internal post.
 */

const userLookup = require('./userLookup');

/** Why a message was held, in the words the mail log and the UI both use. */
const HELD_MUTED = 'muted';
const HELD_OPTED_OUT = 'opted_out';

/** What the mail log records for a message this gate stopped. */
const HELD_STATUS = 'held';

/**
 * The master switch, read defensively.
 *
 * Null and undefined mean "on", because that is every account created before
 * this field existed. Only an explicit false mutes, so a column that failed to
 * migrate cannot silently stop a live client's mail.
 */
function isMailEnabled(user) {
  if (!user) return true;
  if (user.mailEnabled === false) return false;
  // Postgres hands booleans back as booleans, but a row written through a
  // driver that stringifies them would otherwise read 'false' as truthy.
  if (user.mailEnabled === 'false' || user.mailEnabled === 0 || user.mailEnabled === '0') return false;
  return true;
}

/**
 * Postgres stores the opt-out list as JSON text; Firestore stores a real array.
 *
 * Anything unreadable is treated as an empty list -- "send them everything the
 * master switch allows". That is the safe direction here, and it is the
 * opposite of the choice utils/clientPages.js makes for page access, on
 * purpose: a corrupt value there could widen what an account can see, whereas
 * the worst this one can do is send a message somebody asked not to get, which
 * the master switch above still has the final say over.
 */
function parseOptOuts(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter((k) => typeof k === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Validate what an admin sent before it is written.
 *
 * Refused rather than filtered when it is not a list: a hand-written request
 * that sends a bare string should be told so, not quietly saved as nothing.
 * Unknown keys are dropped, because a template that was renamed should not
 * leave a dead entry behind that nobody can see or clear.
 */
function normalizeOptOuts(value) {
  if (value === undefined) return undefined; // caller did not touch the field
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new TypeError('mailOptOuts must be an array of email template keys.');
  }
  const known = new Set(require('./emailMessages').listTemplates().map((t) => t.key));
  return Array.from(new Set(value.filter((k) => known.has(k))));
}

/**
 * Why this user may not be sent this message, or null if they may.
 *
 * `template` is the registry key from utils/emailMessages.js -- the same string
 * the mail log stores and the Mail page lists.
 */
function holdReasonFor(user, template) {
  if (!user || user.role !== 'client') return null;
  if (!isMailEnabled(user)) return HELD_MUTED;
  if (template && parseOptOuts(user.mailOptOuts).includes(template)) return HELD_OPTED_OUT;
  return null;
}

/** The sentence an admin reads next to a held message. */
function explainHold(reason, name) {
  const who = name || 'This client';
  if (reason === HELD_MUTED) {
    return `${who} is not being emailed yet. Turn their email on to start sending.`;
  }
  if (reason === HELD_OPTED_OUT) {
    return `${who} is switched off for this message.`;
  }
  return `${who} is not being emailed.`;
}

/**
 * Split a recipient list into who may be written to and who may not.
 *
 * Per address, because one message can be addressed to a client and to the
 * team at once -- a ticket update, say. Holding the whole send because one of
 * three recipients is muted would stop our own staff hearing about their own
 * work; the muted client is simply dropped from the line.
 *
 * Never throws. A lookup that fails lets the address through: the mail system
 * failing open on a database hiccup is the same behaviour as this gate not
 * existing, and that is a far smaller problem than every email in the app
 * stopping because one query timed out.
 */
async function screen({ to, template }) {
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean).map((a) => String(a).trim());
  const allowed = [];
  const held = [];

  for (const address of list) {
    let user = null;
    try {
      user = await userLookup.findByEmail(address);
    } catch (err) {
      console.error(`[mail] Could not check whether ${address} may be emailed: ${err.message}`);
      allowed.push(address);
      continue;
    }

    const reason = holdReasonFor(user, template);
    if (reason) held.push({ address, userId: user.id, name: user.name || null, reason });
    else allowed.push(address);
  }

  return { allowed, held };
}

module.exports = {
  HELD_MUTED,
  HELD_OPTED_OUT,
  HELD_STATUS,
  isMailEnabled,
  parseOptOuts,
  normalizeOptOuts,
  holdReasonFor,
  explainHold,
  screen,
};
