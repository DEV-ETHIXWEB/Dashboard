'use strict';

/**
 * The routing table between a customer's phone number and the Slack thread
 * their texts land in.
 *
 * One shared channel (SMS_SLACK_CHANNEL), one thread per phone number -- not
 * one Slack channel per customer. A dedicated channel per customer already
 * exists in this codebase (`users.slackChannelId`), but it is a different
 * feature: a channel a *client* is given read/write access to from their own
 * portal. Reusing it here would let a customer's own text messages land in a
 * channel they can post into themselves, and would tie the bridge to a field
 * that is only ever set for accounts that already exist -- which a first-time
 * texter never is. Threads in one staff-only channel need neither.
 *
 * Keyed on phone number, not client_id, for the same reason: a brand new
 * number has no client yet, and still needs somewhere for its thread to live.
 */

const { db } = require('../db/setup');

const PG_UNIQUE_VIOLATION = '23505';

async function findByPhone(phoneNumber) {
  if (!phoneNumber) return null;
  const rows = await db.filter('sms_conversations', (c) => c.phoneNumber === phoneNumber);
  return rows[0] || null;
}

/** The reverse lookup an inbound Slack reply needs: whose conversation is this thread. */
async function findByThread(channelId, threadTs) {
  if (!channelId || !threadTs) return null;
  const rows = await db.filter(
    'sms_conversations',
    (c) => c.slackChannelId === channelId && c.slackThreadTs === threadTs,
  );
  return rows[0] || null;
}

/**
 * Find or open the conversation for a phone number.
 *
 * A client id is filled in when known, and backfilled onto an existing
 * conversation the first time one becomes known -- an admin linking an
 * earlier unknown number to an account must not orphan the thread that
 * number was already texting into.
 *
 * The UNIQUE constraint on phone_number is the actual guarantee here: two
 * inbound webhooks for a brand new number arriving at once will have one of
 * these inserts lose the race, and that failure is read back as the row the
 * winner just created rather than surfaced as an error.
 */
async function getOrCreate({ phoneNumber, clientId }) {
  if (!phoneNumber) return null;

  const existing = await findByPhone(phoneNumber);
  if (existing) {
    if (clientId && !existing.clientId) {
      return (await db.update('sms_conversations', existing.id, {
        clientId,
        updatedAt: new Date().toISOString(),
      })) || existing;
    }
    return existing;
  }

  try {
    return await db.insert('sms_conversations', {
      phoneNumber,
      clientId: clientId || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err?.code === PG_UNIQUE_VIOLATION) {
      const raced = await findByPhone(phoneNumber);
      if (raced) return raced;
    }
    throw err;
  }
}

/** Remember where a conversation's thread lives, once the first Slack post succeeds. */
async function attachThread(id, { channelId, threadTs }) {
  return db.update('sms_conversations', id, {
    slackChannelId: channelId,
    slackThreadTs: threadTs,
    updatedAt: new Date().toISOString(),
  });
}

module.exports = { findByPhone, findByThread, getOrCreate, attachThread };
