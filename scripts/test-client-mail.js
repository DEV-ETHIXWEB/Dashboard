'use strict';

/* The per-client email switch, checked against the one promise it makes:
   a client who has not agreed to a membership hears nothing from us.

     npm run test:client-mail

   "Nothing" is the whole feature, so most of this file is about the ways a
   message could get out anyway -- the queue, a cron sweep, a message addressed
   to a client and to staff at once, a one-time stamp spent while the message
   was being held. A test that only proved the welcome email was skipped would
   be proving the easy half.                                                 */

process.env.APP_BASE_URL = 'https://dashboard.example.com';
process.env.MAIL_BRAND_NAME = 'EthixWeb';

const app = require('../server');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

function makeClient(base) {
  const jar = new Map();
  let csrf = null;
  return {
    setCsrf(v) { csrf = v; },
    async req(method, path, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const cookie of res.headers.getSetCookie?.() || []) {
        const [pair] = cookie.split(';');
        const idx = pair.indexOf('=');
        jar.set(pair.slice(0, idx), pair.slice(idx + 1));
      }
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, text };
    },
  };
}

/* The code the mail transport would have carried, read straight out of
   storage -- an admin's second factor is deliberately not on any page. */
async function latestCodeFor(email) {
  const { db } = require('../db/setup');
  const { decryptCode } = require('../utils/otpCrypto');
  const user = (await db.filter('users', (u) => String(u.email).toLowerCase() === email.toLowerCase()))[0];
  if (!user) return null;
  const otps = await db.filter('otp_codes', (o) => o.userId === user.id && !o.consumed);
  const otp = otps.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  return otp ? decryptCode(otp.code) : null;
}

async function signIn(who, email, password) {
  let res = await who.req('POST', '/api/auth/login', { email, password });
  if (res.status !== 200) return res;
  who.setCsrf(res.data.csrfToken);
  if (!res.data.requiresOtp) return res;
  const code = await latestCodeFor(email);
  res = await who.req('POST', '/api/auth/verify-otp', { code });
  if (res.status === 200) who.setCsrf(res.data.csrfToken);
  return res;
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { db } = require('../db/setup');
  const mailer = require('../utils/mailer');
  const clientMail = require('../utils/clientMail');

  const admin = makeClient(base);
  let r = await signIn(admin, 'admin@ethixweb.local', 'Admin#2026!');
  check('admin can sign in', r.status === 200, `${r.status}`);

  /** Every log row for an address, whatever became of it. */
  const logFor = async (email) => (await db.all('email_log'))
    .filter((e) => String(e.toEmails).toLowerCase().includes(email.toLowerCase()));
  const heldFor = async (email) => (await logFor(email)).filter((e) => e.status === 'held');
  const sentFor = async (email) => (await logFor(email)).filter((e) => e.status !== 'held');

  // ---------------------------------------------------------------------
  section('A client created without the switch hears nothing');

  const mutedEmail = 'muted.client@example.com';
  r = await admin.req('POST', '/api/users', {
    name: 'Muted Client', email: mutedEmail, role: 'client', company: 'Cloudways Co',
    password: 'MutedClientPass#2026',
  });
  check('the account is created', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
  const mutedId = r.data.user?.id;

  const mutedRow = await db.find('users', mutedId);
  check('and it is muted, because nobody said otherwise', clientMail.isMailEnabled(mutedRow) === false,
    JSON.stringify(mutedRow?.mailEnabled));
  check('the list says so too', r.data.user?.mailEnabled === false, JSON.stringify(r.data.user?.mailEnabled));

  check('no welcome email was sent', (await sentFor(mutedEmail)).length === 0,
    JSON.stringify(await sentFor(mutedEmail)));
  check('nor a credentials email', (await logFor(mutedEmail)).every((e) => e.status === 'held'),
    JSON.stringify((await logFor(mutedEmail)).map((e) => `${e.template}:${e.status}`)));

  /* The whole point of logging rather than dropping: an admin can see what a
     muted client would have had. A feature that silently swallowed messages
     would be impossible to check and impossible to trust.                  */
  check('what was held is on the record', (await heldFor(mutedEmail)).length >= 1,
    String((await heldFor(mutedEmail)).length));
  check('and says why in words an admin can act on',
    /not being emailed yet/i.test((await heldFor(mutedEmail))[0]?.error || ''),
    (await heldFor(mutedEmail))[0]?.error);

  /* A held welcome must not spend the one-time stamp. Otherwise the switch
     would not delay the welcome, it would cancel it: the client would be
     marked as welcomed while the message sat held, and would never get one. */
  check('the welcome is not stamped as sent', !mutedRow.welcomeEmailSentAt,
    String(mutedRow.welcomeEmailSentAt));

  // ---------------------------------------------------------------------
  section('Nothing reaches them through any other door either');

  const before = (await sentFor(mutedEmail)).length;

  await mailer.sendMail({
    to: mutedEmail, subject: 'Queued message', text: 'x', html: '<p>x</p>',
    template: 'progress_digest', entity: 'user', entityId: mutedId,
  });
  check('a queued message is held rather than queued', (await sentFor(mutedEmail)).length === before,
    String((await sentFor(mutedEmail)).length));
  const queued = (await db.all('outbox')).filter((o) => String(JSON.stringify(o.payload)).includes(mutedEmail));
  check('and it never entered the outbox', queued.length === 0, String(queued.length));

  await mailer.sendMail({
    to: mutedEmail, subject: 'Inline message', text: 'x', html: '<p>x</p>',
    template: 'login_code', entity: 'user', entityId: mutedId, queue: false,
  });
  check('an inline message is held too', (await sentFor(mutedEmail)).length === before,
    String((await sentFor(mutedEmail)).length));

  /* The security messages are deliberately included. Blocking a password reset
     means a muted client cannot get into the dashboard -- which is correct for
     an account that is only a profile until they pay, and is the explicit
     decision this feature was built on. */
  await mailer.sendMail({
    to: mutedEmail, subject: 'Reset', text: 'x', html: '<p>x</p>',
    template: 'password_reset', entity: 'user', entityId: mutedId, queue: false,
  });
  check('so is a password reset', (await sentFor(mutedEmail)).length === before,
    String((await sentFor(mutedEmail)).length));

  // ---------------------------------------------------------------------
  section('Our own post is not caught in it');

  const staffEmail = 'ryan.coleman@ethixweb.local';
  const staffBefore = (await sentFor(staffEmail)).length;
  await mailer.sendMail({
    to: [mutedEmail, staffEmail], subject: 'Ticket update', text: 'x', html: '<p>x</p>',
    template: 'ticket_status', entity: 'ticket', entityId: 'ticket-1001', queue: false,
  });
  check('a message to a muted client and to staff still reaches staff',
    (await sentFor(staffEmail)).length === staffBefore + 1,
    String((await sentFor(staffEmail)).length));
  check('and still does not reach the client', (await sentFor(mutedEmail)).length === before,
    String((await sentFor(mutedEmail)).length));

  const strangerBefore = (await sentFor('nobody@example.org')).length;
  await mailer.sendMail({
    to: 'nobody@example.org', subject: 'Hello', text: 'x', html: '<p>x</p>',
    template: 'test', queue: false,
  });
  check('an address with no account behind it is not gated',
    (await sentFor('nobody@example.org')).length === strangerBefore + 1);

  // ---------------------------------------------------------------------
  section('A client who predates the switch keeps their mail');

  /* The state every live client is in the morning this ships: the column was
     added after their account existed, so it is null. Null has to mean yes --
     a migration that silently stopped mail to paying clients would be a worse
     bug than the one this feature fixes.                                    */
  const legacyEmail = 'legacy.client@example.com';
  const legacy = await db.insert('users', {
    name: 'Legacy Client', email: legacyEmail, role: 'client', password: 'x',
  });
  check('their switch reads as null', (await db.find('users', legacy.id)).mailEnabled == null);
  check('which the gate reads as on', clientMail.isMailEnabled(await db.find('users', legacy.id)) === true);
  await mailer.sendMail({
    to: legacyEmail, subject: 'Still sending', text: 'x', html: '<p>x</p>',
    template: 'progress_digest', queue: false,
  });
  check('and they are still written to', (await sentFor(legacyEmail)).length === 1,
    String((await sentFor(legacyEmail)).length));

  // ---------------------------------------------------------------------
  section('A cron sweep cannot get round it, and does not lose the message');

  const domainWatch = require('../utils/domainWatch');
  const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
  await db.insert('domains', {
    id: 'dom-muted', clientId: mutedId, domainName: 'muted-client.example',
    registrar: 'EthixWeb', expiresAt: inDays(7), sslStatus: 'Unknown',
  });

  await domainWatch.runSweep();
  const domainMail = (await logFor(mutedEmail)).filter((e) => e.template === 'domain_expiring');
  check('the expiry reminder is held', domainMail.length === 1 && domainMail[0].status === 'held',
    JSON.stringify(domainMail.map((e) => e.status)));

  /* And the held row must not answer "already sent?" with yes, or muting a
     client would not delay their reminders -- it would cancel them for good. */
  await db.update('users', mutedId, { mailEnabled: true });
  await domainWatch.runSweep();
  const afterEnabling = (await logFor(mutedEmail)).filter((e) => e.template === 'domain_expiring');
  check('and once they are switched on, the reminder actually goes',
    afterEnabling.some((e) => e.status !== 'held'),
    JSON.stringify(afterEnabling.map((e) => e.status)));
  check('exactly once, not once per sweep',
    afterEnabling.filter((e) => e.status !== 'held').length === 1,
    String(afterEnabling.filter((e) => e.status !== 'held').length));

  await db.update('users', mutedId, { mailEnabled: false });

  // ---------------------------------------------------------------------
  section('Muted after the message was already queued');

  /* The gap this closes: a message is queued for a client who is being
     emailed, the admin mutes them a minute later, and the sweep reaches the
     row after that. Screening only at `sendMail` would have let that one
     through, which is why `sendNow` screens as well.                       */
  {
    const outbox = require('../utils/outbox');
    const lateEmail = 'late.mute@example.com';
    r = await admin.req('POST', '/api/users', {
      name: 'Late Mute', email: lateEmail, role: 'client',
      password: 'LateMuteClient#2026', mailEnabled: true,
    });
    check('a client who is being emailed is created', r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
    const lateId = r.data.user?.id;

    const queued = await mailer.sendMail({
      to: lateEmail, subject: 'Queued while allowed', text: 'x', html: '<p>x</p>',
      template: 'progress_digest', entity: 'user', entityId: lateId,
    });
    check('their message is queued, not held', queued.queued === true, JSON.stringify(queued));

    await db.update('users', lateId, { mailEnabled: false });
    await outbox.runSweep();

    /* Scoped to the one message under test. This account was emailable when it
       was created, so its credentials really did go out then -- counting every
       row for the address would be asserting that a message sent before the
       mute should somehow have been held. */
    const digests = async () => (await logFor(lateEmail)).filter((e) => e.template === 'progress_digest');
    check('the sweep does not deliver it',
      (await digests()).every((e) => e.status === 'held'),
      JSON.stringify((await digests()).map((e) => e.status)));
    check('and the row it already had says it was held',
      (await digests()).length === 1 && (await digests())[0].status === 'held',
      JSON.stringify((await digests()).map((e) => e.status)));

    /* "No valid recipients" and "we chose not to write to this person" look
       identical from inside the mailer and mean opposite things: one is an
       address to go and fix, the other is the rule working. */
    const row = (await db.all('outbox')).find((o) => String(JSON.stringify(o.payload)).includes(lateEmail));
    check('the queue says why rather than blaming the address',
      /not being emailed/i.test(String(row?.lastError || '')), String(row?.lastError));
    check('and does not keep retrying it', row?.status === 'failed', String(row?.status));
  }

  // ---------------------------------------------------------------------
  section('The same address twice is one decision, not two');

  {
    const before2 = (await heldFor(mutedEmail)).length;
    await mailer.sendMail({
      to: [mutedEmail, mutedEmail.toUpperCase()], subject: 'Twice', text: 'x', html: '<p>x</p>',
      template: 'progress_digest', queue: false,
    });
    check('a duplicated recipient is written down once',
      (await heldFor(mutedEmail)).length === before2 + 1,
      String((await heldFor(mutedEmail)).length - before2));
  }

  // ---------------------------------------------------------------------
  section('Turning the switch on sends no backlog');

  r = await admin.req('PUT', `/api/users/${mutedId}/mail`, { mailEnabled: true });
  check('an admin can turn it on', r.status === 200 && r.data.mailEnabled === true, `${r.status} ${r.text.slice(0, 160)}`);

  const afterSwitch = await sentFor(mutedEmail);
  check('and nothing held earlier is replayed',
    !afterSwitch.some((e) => e.template === 'welcome_with_plans'),
    JSON.stringify(afterSwitch.map((e) => e.template)));
  check('the welcome is still owed, not lost',
    !(await db.find('users', mutedId)).welcomeEmailSentAt);

  r = await admin.req('POST', `/api/users/${mutedId}/welcome`);
  check('and it can be sent on purpose', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
  check('which really sends it',
    (await sentFor(mutedEmail)).some((e) => e.template === 'welcome_with_plans'));
  r = await admin.req('POST', `/api/users/${mutedId}/welcome`);
  check('asking twice is refused rather than sending two', r.status === 409, `${r.status}`);

  // ---------------------------------------------------------------------
  section('One message at a time, for a client who is otherwise on');

  r = await admin.req('GET', `/api/users/${mutedId}/mail`);
  check('the settings list every message a client can get', r.status === 200 && r.data.groups?.length > 0,
    `${r.status}`);
  const offered = r.data.groups.flatMap((g) => g.templates.map((t) => t.key));
  check('and only the ones a client reads', offered.length > 0 && !offered.includes('approval_requested'),
    String(offered.length));
  check('the list is built from the app, not kept here',
    offered.includes('payment_received') && offered.includes('welcome_with_plans'),
    String(offered.length));

  r = await admin.req('PUT', `/api/users/${mutedId}/mail`, { optOuts: ['progress_digest'] });
  check('one message can be switched off', r.status === 200 && r.data.optOuts.includes('progress_digest'),
    `${r.status} ${r.text.slice(0, 160)}`);

  const optOutBefore = (await sentFor(mutedEmail)).length;
  await mailer.sendMail({
    to: mutedEmail, subject: 'Digest', text: 'x', html: '<p>x</p>',
    template: 'progress_digest', queue: false,
  });
  check('that one is held', (await sentFor(mutedEmail)).length === optOutBefore);
  await mailer.sendMail({
    to: mutedEmail, subject: 'Receipt', text: 'x', html: '<p>x</p>',
    template: 'payment_received', queue: false,
  });
  check('while the rest still send', (await sentFor(mutedEmail)).length === optOutBefore + 1);

  r = await admin.req('PUT', `/api/users/${mutedId}/mail`, { optOuts: ['not_a_real_template'] });
  check('an unknown template key is dropped rather than stored',
    r.status === 200 && r.data.optOuts.length === 0, `${r.status} ${r.text.slice(0, 160)}`);
  r = await admin.req('PUT', `/api/users/${mutedId}/mail`, { optOuts: 'progress_digest' });
  check('and a value that is not a list is refused', r.status === 400, `${r.status}`);

  // ---------------------------------------------------------------------
  section('Only an admin, and only for a client');

  const clientSession = makeClient(base);
  r = await signIn(clientSession, mutedEmail, 'MutedClientPass#2026');
  if (r.status === 200) {
    r = await clientSession.req('GET', `/api/users/${mutedId}/mail`);
    check('a client cannot read their own gate', r.status === 403, `${r.status}`);
    r = await clientSession.req('PUT', `/api/users/${mutedId}/mail`, { mailEnabled: true });
    check('nor change it', r.status === 403, `${r.status}`);
  } else {
    check('a client cannot read their own gate', false, `could not sign in: ${r.status}`);
    check('nor change it', false, 'skipped');
  }

  r = await admin.req('GET', '/api/users/u-pm/mail');
  check('staff have no email settings to read', r.status === 400, `${r.status}`);
  r = await admin.req('PUT', '/api/users/u-pm/mail', { mailEnabled: false });
  check('and none to set', r.status === 400, `${r.status}`);
  r = await admin.req('PUT', `/api/users/${mutedId}/mail`, { mailEnabled: 'yes please' });
  check('the switch only takes a boolean', r.status === 400, `${r.status}`);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
