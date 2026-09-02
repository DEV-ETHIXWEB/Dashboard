'use strict';

/**
 * Creating an account, and telling the person about it.
 *
 * There used to be two of these: the direct route in routes/users.js, and a
 * shorter copy inside the approval queue that quietly dropped the Slack
 * channel and never sent the credentials at all. An account created through
 * the second path was unusable -- nobody on earth knew its password.
 *
 * One path now, used by both callers, so "created directly" and "created after
 * approval" cannot mean two different things again.
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const mailer = require('./mailer');
const messages = require('./emailMessages');
const loginLinks = require('./loginLinks');
const { baseUrl } = require('./appUrl');
const { CLIENT_PAGES, allowedPagesFor } = require('./clientPages');

const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** A password nobody has to read out twice: no look-alike characters. */
function generatePassword(length = 14) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return out;
}

/** Human labels for the sections a login can open, for the welcome email. */
function sectionLabels(user) {
  const keys = allowedPagesFor(user);
  return CLIENT_PAGES.filter((p) => keys.includes(p.key)).map((p) => p.label);
}

/**
 * Email someone the credentials an admin just issued them. Best-effort: an
 * unreachable inbox must not fail the account creation, and the admin still
 * sees the password on screen on the direct route either way.
 */
async function emailCredentials(user, temporaryPassword, { invitedBy, isReset = false, ipAddress = null } = {}) {
  // Clients get a one-tap link in the same email, so the first sign-in costs
  // no typing on a phone. Staff do not: their accounts can change other
  // people's access, which a link in an inbox is not a strong enough gate for.
  // Best-effort -- a link that cannot be minted must not stop the credentials
  // going out.
  let signInUrl = null;
  if (user.role === 'client' && baseUrl()) {
    try {
      const { path } = await loginLinks.issueFor(user, { ipAddress, ttlMs: loginLinks.WELCOME_TOKEN_TTL_MS });
      signInUrl = `${baseUrl()}${path}`;
    } catch (err) {
      console.error('Could not mint the welcome sign-in link:', err.message);
    }
  }

  const result = await mailer.sendTemplate({
    to: user.email,
    message: messages.credentialsIssued({
      user,
      temporaryPassword,
      expiresAt: user.passwordExpiresAt || null,
      sections: user.role === 'client' ? sectionLabels(user) : null,
      invitedBy,
      isReset,
      signInUrl,
    }),
    template: 'credentials',
    entity: 'user',
    entityId: user.id,
  });
  return Boolean(result.ok);
}

/**
 * Add the bot to a client's channel as soon as one is chosen.
 *
 * A public channel it can join itself; a private one needs an invite from
 * somebody already in it. Best-effort: Slack being down must not fail the
 * account change that already succeeded.
 */
async function joinAssignedChannel(user) {
  if (!user?.slackChannelId) return null;
  const slack = require('./slack');
  if (!slack.isEnabled()) {
    return { joined: false, message: 'Slack is not connected, so the bot could not be added yet.' };
  }
  try {
    const result = await slack.joinChannel(user.slackChannelId);
    return result.joined
      ? { joined: true }
      : { joined: false, message: result.message || 'The bot could not add itself to that channel.' };
  } catch (err) {
    return { joined: false, message: err.message };
  }
}

/**
 * Write the account row. Every field the admin filled in, on both paths.
 *
 * `role` is taken as given: the caller has already decided whether this actor
 * is allowed to create that kind of account. Standing flags are not accepted
 * here at all -- an admin created this way is always an ordinary, untrusted
 * one, and is promoted afterwards on the standing endpoint.
 */
async function createUserRecord({
  name, email, role, company = null, plaintextPassword,
  passwordExpiresAt = null, allowedPages = null,
  slackChannelId = null, slackChannelName = null,
}) {
  // Required lazily, the way utils/mailer.js does it, so importing this file
  // never opens a database connection on its own.
  const { db } = require('../db/setup');
  const policy = require('./passwordPolicy');
  return db.insert('users', {
    name,
    email,
    role,
    company: company || null,
    password: bcrypt.hashSync(plaintextPassword, 10),
    // The password's clock starts now. Without this the account reads as
    // "never changed", which the monthly policy would have to treat as either
    // ancient or unknown -- and neither is true of a password made a second ago.
    ...policy.stampChange(),
    passwordExpiresAt: passwordExpiresAt != null ? Number(passwordExpiresAt) : null,
    allowedPages: allowedPages === undefined ? null : allowedPages,
    // Only a client has a channel; staff reach all of Slack through the
    // integrations page anyway.
    ...(role === 'client' ? { slackChannelId, slackChannelName } : {}),
  });
}

module.exports = {
  generatePassword,
  sectionLabels,
  emailCredentials,
  joinAssignedChannel,
  createUserRecord,
};
