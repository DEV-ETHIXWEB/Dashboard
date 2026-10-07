'use strict';

/**
 * The switch that holds back automated mail while leaving the rest alone.
 *
 * There is one moment this exists for: moving existing clients into this
 * dashboard. During an import, records get created and statuses get corrected
 * in bulk, and every one of those edits looks to this app exactly like a real
 * event -- a project going live, a service starting. Without a way to hold the
 * automation, a migration tells fifty established customers that the website
 * they have had for a year is live today.
 *
 * Set MAIL_AUTOMATION_PAUSED=true before the import and clear it afterwards.
 *
 * What it holds: the service launch announcements and the monthly summaries.
 * Mail that somebody is waiting on is deliberately NOT held -- a sign-in code,
 * a password reset, a ticket reply. Pausing those does not prevent an
 * embarrassment, it locks people out of their accounts, and an import is
 * exactly when somebody is most likely to be trying to sign in.
 */

function paused() {
  return String(process.env.MAIL_AUTOMATION_PAUSED || '').trim().toLowerCase() === 'true';
}

/** The same answer, shaped like the result the callers already return. */
function heldResult() {
  return { sent: false, reason: 'automated mail is paused (MAIL_AUTOMATION_PAUSED=true)' };
}

/**
 * The settings that break a client's email quietly.
 *
 * Each of these lets a send succeed and report success while the message that
 * arrives is visibly wrong, so none of them shows up in a log or a test -- only
 * in somebody's inbox. Said at boot instead.
 */
function risks() {
  const out = [];
  const appUrl = require('./appUrl');

  if (!String(appUrl.baseUrl() || '').trim()) {
    out.push(
      'APP_BASE_URL is not set. Every call-to-action button and every footer link '
      + 'is dropped from the message, and the badge artwork is looked for in the '
      + 'storage bucket rather than served by this app. Set it to the public URL '
      + 'of this dashboard.',
    );
  }

  const icons = String(process.env.MAIL_ICON_BASE_URL || '').trim().toLowerCase();
  if (!icons && !String(appUrl.baseUrl() || '').trim()) {
    out.push(
      'Badge artwork will be requested from the storage bucket. If the bucket has '
      + 'not been filled, every email opens with a broken image. MAIL_ICON_BASE_URL=cid '
      + 'sends the artwork with the message instead and cannot fail.',
    );
  }

  if (!require('./mailer').replyToAddress()) {
    out.push(
      'MAIL_REPLY_TO is not set, so replies go to the noreply address. Several '
      + 'messages tell the client to reply to them.',
    );
  }

  if (paused()) {
    out.push('MAIL_AUTOMATION_PAUSED=true -- launch announcements and monthly summaries are being held.');
  }

  return out;
}

/** Say the above at boot, once, and loudly enough to act on. */
function warnIfRisky() {
  for (const line of risks()) console.warn(`[mail] ${line}`);
}

module.exports = { paused, heldResult, risks, warnIfRisky };
