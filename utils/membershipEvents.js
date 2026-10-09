'use strict';

/**
 * The membership funnel, written down as it happens.
 *
 * This exists to answer four questions nobody can answer from the
 * subscriptions table alone: what fraction of clients shown the plans modal
 * picked a plan, what fraction of upgrade prompts led to an upgrade, how often
 * people dismiss them, and whether clients who upgraded stayed. Every one of
 * those is a ratio of two events, so both halves have to be recorded -- a
 * table of subscriptions tells you who bought, never who was asked.
 *
 * Nothing here is allowed to fail a request. A client pressing "Choose
 * Unlimited" must not see an error because an analytics row would not insert,
 * so every write is wrapped and a failure is logged and swallowed. The trail
 * is for us; the client's action is for them.
 */

const { db } = require('../db/setup');

/**
 * Every event type, and nothing else.
 *
 * A typo in an event name is invisible -- the row inserts, the dashboard shows
 * one fewer conversion, and nobody finds out for a month. So an unknown type
 * is refused at the door and logged loudly instead.
 */
const EVENT_TYPES = [
  'welcome_email_sent',
  'plans_modal_shown',
  'plan_selected',
  'payment_confirmed',
  'upsell_shown',
  'upsell_dismissed',
  'upsell_snoozed',
  'upsell_clicked',
  'upgraded',
  'downgraded',
  'cancelled',
  // Beyond the brief's list, because each of these is a real decision point we
  // would otherwise be blind to: a Managed client choosing to pay for a third
  // update rather than upgrade, one choosing to wait instead, and a leaving
  // client asking for their website files.
  'extra_update_purchased',
  'request_queued',
  'handover_requested',
];

const EVENT_TYPE_SET = new Set(EVENT_TYPES);

/**
 * Record one moment in a client's membership.
 *
 * `metadata` is for the detail that makes the event worth counting -- which
 * trigger an upsell fired on, which plan was chosen, which panel was locked.
 * Never a secret: these rows are read by staff screens and kept indefinitely.
 */
async function log(type, { clientId = null, metadata = null, actorId = null } = {}) {
  if (!EVENT_TYPE_SET.has(type)) {
    console.warn(`[membership] refusing to log unknown event type "${type}"`);
    return null;
  }

  try {
    return await db.insert('membership_events', {
      clientId,
      type,
      metadata: metadata && typeof metadata === 'object' ? metadata : null,
      actorId,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // Deliberately swallowed. See the note at the top of this file: the
    // client's action already succeeded, and an analytics write is not a
    // reason to tell them it did not.
    console.error(`[membership] could not log ${type} for ${clientId}: ${err.message}`);
    return null;
  }
}

/** This client's events, newest first. */
async function forClient(clientId, { types = null, limit = 200 } = {}) {
  if (!clientId) return [];
  const wanted = types ? new Set(types) : null;
  // By client from the database, then by type in memory. The event table is
  // append-only and grows faster than anything else here, so reading all of it
  // to find one client's rows is the first thing that would hurt.
  const rows = (await db.where('membership_events', { clientId }))
    .filter((e) => !wanted || wanted.has(e.type));
  return rows
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, limit);
}

/** The most recent event of a type for a client, or null. */
async function lastOf(clientId, type) {
  const rows = await forClient(clientId, { types: [type], limit: 1 });
  return rows[0] || null;
}

/**
 * How many of a type this client has had since a moment. Used by the upsell
 * frequency rules, where "has anything fired in the last seven days" is the
 * question that decides whether anything fires at all.
 */
async function countSince(clientId, types, sinceIso) {
  const rows = await forClient(clientId, { types, limit: Number.MAX_SAFE_INTEGER });
  if (!sinceIso) return rows.length;
  return rows.filter((e) => String(e.createdAt || '') >= sinceIso).length;
}

module.exports = { EVENT_TYPES, log, forClient, lastOf, countSince };
