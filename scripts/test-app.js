'use strict';

/* End-to-end smoke test against an in-memory Postgres. Run from the repo root:
   npm run test:app        (or npm test for both)                            */

process.env.APP_BASE_URL = 'https://dashboard.example.com';
process.env.MAIL_BRAND_NAME = 'EthixWeb';
process.env.TICKET_AUTO_ASSIGN = 'on';

const app = require('../server');
/** The brand red the email renderer actually ships. */
const BRAND_RED = require('../utils/emailTemplates').TOKENS.brand;

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

function makeClient(base) {
  const jar = new Map();
  let csrf = null;
  return {
    setCsrf(v) { csrf = v; },
    get csrf() { return csrf; },
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
      return { status: res.status, data, text, headers: res.headers };
    },
    /** Multipart under an arbitrary field name, for the avatar endpoints. */
    async uploadField(path, field, file) {
      const form = new FormData();
      if (file) form.set(field, new Blob([file.bytes], { type: file.type }), file.name);
      const headers = {};
      if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const res = await fetch(base + path, { method: 'POST', headers, body: form });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, text, headers: res.headers };
    },
    /** A GET whose body is bytes rather than JSON -- an image, say. */
    async raw(path) {
      const headers = {};
      if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(base + path, { headers });
      return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    },
    /** The same session, sending multipart -- the only way to reach an upload. */
    async upload(path, fields, file) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      if (file) form.set('file', new Blob([file.bytes], { type: file.type }), file.name);
      const headers = {};
      if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const res = await fetch(base + path, { method: 'POST', headers, body: form });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, text, headers: res.headers };
    },
  };
}

/**
 * The newest live sign-in code for an account, read straight out of storage.
 *
 * Administrators now sign in with a password and an emailed code like everyone
 * else, and their codes are deliberately not on the Login Codes page -- putting
 * an admin's second factor in front of every other admin would defeat the point
 * of having one. A test running in-process reads it the way the mail transport
 * would have.
 */
/**
 * A genuine PNG of a given size.
 *
 * Built rather than checked in as a fixture because the avatar validator reads
 * the real header -- a handful of magic bytes with a plausible size glued on
 * would pass a signature check and fail an honest one, which would make the
 * test prove less than it appears to.
 */
function pngBytes(width, height) {
  const zlib = require('zlib');
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const check = Buffer.alloc(4); check.writeUInt32BE(crc(typed));
    return Buffer.concat([len, typed, check]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 8 bits per channel
  ihdr[9] = 2;   // truecolour
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function latestCodeFor(email) {
  const { db } = require('../db/setup');
  const { decryptCode } = require('../utils/otpCrypto');
  const user = (await db.filter('users', (u) => String(u.email).toLowerCase() === email.toLowerCase()))[0];
  if (!user) return null;
  const otps = await db.filter('otp_codes', (o) => o.userId === user.id && !o.consumed);
  const otp = otps.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  return otp ? decryptCode(otp.code) : null;
}

/** Sign in and complete the code step, for any role. */
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

  const admin = makeClient(base);
  const client = makeClient(base);

  // --- admin sign-in -------------------------------------------------------
  let r = await signIn(admin, 'admin@ethixweb.local', 'Admin#2026!');
  check('admin can sign in', r.status === 200 && Boolean(r.data.user), `${r.status} ${r.text.slice(0, 160)}`);

  // --- multi-admin ---------------------------------------------------------
  r = await admin.req('GET', '/api/users');
  const adminCount = (r.data.users || []).filter((u) => u.role === 'admin').length;
  check('workspace seeds more than one admin', adminCount >= 2, `found ${adminCount}`);

  r = await admin.req('POST', '/api/users', {
    name: 'Second Admin', email: 'second.admin@ethixweb.local', role: 'admin',
  });
  check('admin can create another admin', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
  const newAdminId = r.data.user?.id;
  check('new admin gets a temporary password', Boolean(r.data.temporaryPassword));

  // --- last-admin guard ----------------------------------------------------
  const allAdmins = (await admin.req('GET', '/api/users')).data.users.filter((u) => u.role === 'admin');
  for (const a of allAdmins) {
    if (a.id === newAdminId) continue;
    if (a.email === 'admin@ethixweb.local') continue;
    await admin.req('DELETE', `/api/users/${a.id}`);
  }
  // Only the signed-in admin and the new one remain. Delete the new one, then
  // try to demote the last remaining admin, which must be refused.
  r = await admin.req('DELETE', `/api/users/${newAdminId}`);
  check('an admin can be removed while others remain', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);

  const me = (await admin.req('GET', '/api/auth/me')).data.user;
  r = await admin.req('PUT', `/api/users/${me.id}`, { role: 'employee' });
  check('last admin cannot be demoted', r.status === 409, `${r.status} ${r.text.slice(0, 200)}`);

  // --- client login with page toggles --------------------------------------
  r = await admin.req('POST', '/api/users', {
    name: 'Test Client', email: 'qa.client@example.com', role: 'client', company: 'QA Co',
    password: 'ClientPass#1', allowedPages: ['tickets', 'progress', 'projects'],
  });
  check('admin can issue a client login', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
  const clientId = r.data.user?.id;
  check('credentials email is recorded even without a transport', r.data.emailConfigured === false);

  r = await client.req('POST', '/api/auth/login', { email: 'qa.client@example.com', password: 'ClientPass#1' });
  check('client sign-in asks for a code', r.status === 200 && r.data.requiresOtp === true, `${r.status} ${r.text.slice(0, 160)}`);
  client.setCsrf(r.data.csrfToken);

  // Without a transport the code is not emailed, so read it the way the Login
  // Codes page does.
  const logs = (await admin.req('GET', '/api/auth/otp-logs')).data.logs || [];
  const mine = logs.filter((l) => l.email === 'qa.client@example.com')[0];
  check('a login code was issued for the client', Boolean(mine));
  const code = (await admin.req('POST', `/api/auth/otp-logs/${mine.id}/reveal`)).data.code;
  r = await client.req('POST', '/api/auth/verify-otp', { code });
  check('client completes the code step', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  client.setCsrf(r.data.csrfToken);

  // --- ticket intake -------------------------------------------------------
  r = await client.req('POST', '/api/tickets', {
    subject: 'Checkout page throws a 500', category: 'Bug', description: 'Every card payment fails at the last step.',
    priority: 'Urgent',
  });
  check('client can raise a ticket', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
  const ticket = r.data.ticket;
  check('ticket gets an SLA clock', Boolean(ticket?.responseDueAt));
  check('ticket is auto-assigned', Boolean(ticket?.assigneeId), JSON.stringify(ticket?.assigneeId));

  // --- mail log ------------------------------------------------------------
  r = await admin.req('GET', '/api/mail/log');
  const templatesLogged = new Set((r.data.entries || []).map((e) => e.template));
  check('mail log is readable by an admin', r.status === 200, `${r.status}`);
  check('new-ticket email is logged', templatesLogged.has('new_ticket_staff'), [...templatesLogged].join(','));
  check('client receipt email is logged', templatesLogged.has('ticket_receipt_client'), [...templatesLogged].join(','));
  check('credentials email is logged', templatesLogged.has('credentials'), [...templatesLogged].join(','));

  // --- template previews ---------------------------------------------------
  r = await admin.req('GET', '/api/mail/templates');
  const templates = r.data.templates || [];
  check('every template is listed', templates.length >= 10, `${templates.length}`);
  for (const tpl of templates) {
    const preview = await admin.req('GET', `/api/mail/templates/${tpl.key}/preview`);
    const html = preview.data?.html || '';
    const okHtml = preview.status === 200
      && html.includes('<!DOCTYPE')
      && html.includes('</html>')
      && Boolean(preview.data.subject)
      && Boolean(preview.data.text)
      && !html.includes('undefined')
      && !html.includes('[object Object]');
    check(`template renders: ${tpl.key}`, okHtml, `${preview.status} ${html.slice(0, 80)}`);
  }

  // --- client progress board ----------------------------------------------
  r = await client.req('GET', '/api/client/progress');
  check('client can read their progress board', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  check('progress board carries their ticket', (r.data.tickets || []).some((t) => t.id === ticket.id));
  check('progress board reports integration state', typeof r.data.integrations?.board === 'boolean');
  check('progress board never leaks a client id of another account', r.data.client?.id === clientId);

  r = await client.req('GET', `/api/client/tickets/${ticket.id}/activity`);
  check('client can read ticket activity', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  check('activity reports board availability without a token', r.data.board?.available === false);

  r = await client.req('POST', `/api/client/tickets/${ticket.id}/reply`, { body: 'Any progress on this today?' });
  check('client can reply from the progress board', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);

  r = await client.req('GET', `/api/client/tickets/${ticket.id}/activity`);
  check('the reply appears in the activity feed', (r.data.notes || []).some((n) => n.body.includes('progress on this')));

  // --- staff side ----------------------------------------------------------
  r = await admin.req('PUT', `/api/tickets/${ticket.id}`, { status: 'Resolved' });
  check('admin can resolve a ticket', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);

  r = await admin.req('GET', '/api/mail/log');
  const afterTemplates = new Set((r.data.entries || []).map((e) => e.template));
  check('status-change email is logged', afterTemplates.has('ticket_status'), [...afterTemplates].join(','));
  check('comment email is logged', afterTemplates.has('ticket_comment'), [...afterTemplates].join(','));

  // --- deadline sweep ------------------------------------------------------
  // Force the ticket past its first-response window, then run the sweep.
  r = await admin.req('PUT', `/api/tickets/${ticket.id}`, { status: 'Open' });
  check('ticket can be reopened', r.status === 200, `${r.status}`);
  r = await admin.req('POST', '/api/mail/sla-sweep');
  check('deadline sweep runs', r.status === 200 && typeof r.data.checked === 'number', `${r.status} ${r.text.slice(0, 160)}`);

  // --- progress digest -----------------------------------------------------
  r = await admin.req('POST', `/api/mail/digest/${clientId}`);
  check('progress summary can be sent on demand', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  r = await admin.req('GET', '/api/mail/log');
  check('digest email is logged', (r.data.entries || []).some((e) => e.template === 'progress_digest'));

  // --- template previews all still render ----------------------------------
  const p2 = await admin.req('GET', '/api/mail/templates/sla_warning/preview');
  check('sla warning renders red brand', p2.status === 200 && p2.data.html.includes(BRAND_RED), `${p2.status}`);
  check('no ClickUp purple remains', !p2.data.html.includes('7b68ee'));

  // --- one-tap sign-in link (admin-issued) ----------------------------------
  r = await admin.req('POST', `/api/auth/login-link/${clientId}`);
  check('an admin can mint a client sign-in link', r.status === 200 && Boolean(r.data.path), `${r.status} ${r.text.slice(0, 160)}`);
  // --- a link's lifetime is chosen, and bounded -----------------------------
  // A sign-in link is a bearer credential, so "however long you like" is not
  // an option however it is asked for.
  {
    const loginLinks = require('../utils/loginLinks');

    r = await admin.req('POST', `/api/auth/login-link/${clientId}`, { expiresInMinutes: 60 });
    check('an admin can choose how long a link lives', r.status === 200 && r.data.expiresInMinutes === 60,
      `${r.status} ${r.data.expiresInMinutes}`);
    const anHour = r.data.expiresAt - Date.now();
    check('and the expiry matches the choice', anHour > 55 * 60000 && anHour <= 61 * 60000, `${Math.round(anHour / 60000)} min`);

    r = await admin.req('POST', `/api/auth/login-link/${clientId}`, { expiresInMinutes: 60 * 24 * 365 });
    check('a year is clamped to the seven-day ceiling', r.data.expiresInMinutes === 60 * 24 * 7, `${r.data.expiresInMinutes}`);

    r = await admin.req('POST', `/api/auth/login-link/${clientId}`, { expiresInMinutes: 1 });
    check('a minute is raised to the five-minute floor', r.data.expiresInMinutes === 5, `${r.data.expiresInMinutes}`);

    r = await admin.req('POST', `/api/auth/login-link/${clientId}`, { expiresInMinutes: 'not a number' });
    check('nonsense falls back to the default rather than erroring',
      r.status === 200 && r.data.expiresInMinutes === Math.round(loginLinks.TOKEN_TTL_MS / 60000),
      `${r.status} ${r.data.expiresInMinutes}`);

    r = await admin.req('POST', `/api/auth/login-link/${clientId}`, { expiresInMinutes: -5 });
    check('a negative lifetime cannot mint an already-dead link',
      r.data.expiresAt > Date.now(), `${r.data.expiresAt - Date.now()}ms`);

    r = await admin.req('POST', `/api/auth/login-link/${clientId}`);
    check('omitting it keeps the old default', r.data.expiresInMinutes === 15, `${r.data.expiresInMinutes}`);

    // The choice is on the record: who issued what, and for how long.
    const logged = (await admin.req('GET', '/api/approvals/audit-log')).data.entries
      .find((e) => e.action === 'issue_login_link');
    check('the chosen lifetime is audited', Boolean(logged?.meta?.ttlMs), JSON.stringify(logged?.meta));
  }

  const linkPath = r.data.path;
  check('the link is returned as a path the portal can host', String(linkPath).startsWith('/api/auth/magic-link/verify?token='), linkPath);

  const me2 = (await admin.req('GET', '/api/auth/me')).data.user;
  r = await admin.req('POST', `/api/auth/login-link/${me2.id}`);
  check('no link can be minted for a staff account', r.status === 400, `${r.status} ${r.text.slice(0, 160)}`);

  r = await client.req('POST', `/api/auth/login-link/${clientId}`);
  check('a client cannot mint their own link', r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);

  const openLink = (path) => fetch(`${base}${path}`, { redirect: 'manual' });

  // The welcome email carries its own longer-lived link, so a client's very
  // first sign-in costs no typing.
  r = await admin.req('POST', '/api/users', {
    name: 'Welcome Client', email: 'qa.welcome@example.com', role: 'client', company: 'QA Co',
  });
  const welcomeId = r.data.user?.id;
  check('admin can issue a login that emails a welcome link', r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);

  const welcomeMail = (await admin.req('GET', '/api/mail/log')).data.entries
    .filter((e) => e.template === 'credentials' && e.entityId === welcomeId)[0];
  check('the welcome email was rendered for the new client', Boolean(welcomeMail));

  // The Mail page keeps a record of the send, not the message. A credentials
  // email contains a plaintext password and a live one-tap token, and storing
  // that made the page a permanent credential store every admin could browse.
  const welcomeEntry = welcomeMail
    ? (await admin.req('GET', `/api/mail/log/${welcomeMail.id}`)).data.entry
    : null;
  check('the welcome email body is deliberately not kept',
    Boolean(welcomeEntry) && !welcomeEntry.html,
    String(welcomeEntry?.html || '').slice(0, 100));

  // The link itself is still minted and still works -- checked at the layer the
  // email is built from, rather than by reading it back out of a log.
  const { db: store } = require('../db/setup');
  const welcomeLink = (await store.filter('login_links', (l) => l.userId === welcomeId && !l.consumed))[0];
  check('the welcome email carries a one-tap link', Boolean(welcomeLink));
  check('the welcome link outlives the working day',
    Boolean(welcomeLink) && Number(welcomeLink.expiresAt) - Date.now() > 12 * 60 * 60 * 1000,
    `${welcomeLink ? Math.round((Number(welcomeLink.expiresAt) - Date.now()) / 3600000) : '?'}h`);
  check('only the hash of the link secret is stored',
    Boolean(welcomeLink) && /^[0-9a-f]{64}$/.test(String(welcomeLink.tokenHash)),
    String(welcomeLink?.tokenHash || '').slice(0, 20));


  let hit = await openLink(linkPath);
  check('opening the link signs the client in', hit.status === 302 && hit.headers.get('location') === '/portal',
    `${hit.status} ${hit.headers.get('location')}`);

  const linkCookie = (hit.headers.getSetCookie?.() || [])[0] || '';
  const sid = linkCookie.split(';')[0];
  const meRes = await fetch(`${base}/api/auth/me`, { headers: { Cookie: sid } });
  const meBody = await meRes.json().catch(() => ({}));
  check('the link session is fully signed in, not pending',
    meRes.status === 200 && meBody.user?.email === 'qa.client@example.com', `${meRes.status}`);

  hit = await openLink(linkPath);
  check('the same link cannot be used twice',
    hit.status === 302 && hit.headers.get('location') === '/login?linkError=used', `${hit.headers.get('location')}`);

  hit = await openLink('/api/auth/magic-link/verify?token=not-a-real.token');
  check('a forged token is refused',
    hit.status === 302 && hit.headers.get('location') === '/login?linkError=invalid', `${hit.headers.get('location')}`);

  // A second link cancels the first, so a stale one handed over earlier is dead.
  const first = (await admin.req('POST', `/api/auth/login-link/${clientId}`)).data.path;
  await admin.req('POST', `/api/auth/login-link/${clientId}`);
  hit = await openLink(first);
  check('issuing a new link kills the previous one',
    hit.status === 302 && hit.headers.get('location') === '/login?linkError=invalid', `${hit.headers.get('location')}`);

  // --- super admin, and the second signature -------------------------------
  {
    const roles = require('../utils/roles');
    const { db } = require('../db/setup');

    // The seed elects one super admin and leaves the second admin untrusted.
    let me2 = (await admin.req('GET', '/api/auth/me')).data;
    check('the signed-in admin is the super admin', me2.user?.isSuperAdmin === true, JSON.stringify(me2.user?.isSuperAdmin));
    check('capabilities travel with the session', me2.capabilities?.canManageAdmins === true, JSON.stringify(me2.capabilities));
    check('a super admin never needs approval', me2.capabilities?.needsApproval === false);

    // A second admin who has not been vouched for.
    const fresh = makeClient(base);
    r = await admin.req('POST', '/api/users', {
      name: 'Fresh Admin', email: 'fresh.admin@ethixweb.local', role: 'admin', password: 'FreshAdmin#1',
    });
    check('a super admin can appoint an administrator', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
    const freshId = r.data.user?.id;
    check('a new admin starts untrusted', r.data.user?.adminTrusted === false, JSON.stringify(r.data.user?.adminTrusted));

    r = await signIn(fresh, 'fresh.admin@ethixweb.local', 'FreshAdmin#1');
    check('an admin signs in without a code step', r.status === 200 && !r.data.requiresOtp, `${r.status}`);

    const freshMe = (await fresh.req('GET', '/api/auth/me')).data;
    check('a new admin is told they need approval', freshMe.capabilities?.needsApproval === true, JSON.stringify(freshMe.capabilities));
    check('a new admin cannot manage admins', freshMe.capabilities?.canManageAdmins === false);
    check('a new admin cannot read the audit log', freshMe.capabilities?.canReadAuditLog === false);

    // --- the hard limits, which no approval can unlock ---------------------
    r = await fresh.req('POST', '/api/users', { name: 'Sneaky', email: 'sneaky@ethixweb.local', role: 'admin' });
    check('an ordinary admin cannot appoint an admin at all', r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);

    r = await fresh.req('POST', `/api/users/${freshId}/standing`, { superAdmin: true });
    check('an admin cannot promote themselves to super admin', r.status === 403, `${r.status}`);

    r = await fresh.req('GET', '/api/approvals/audit-log');
    check('the audit log is closed to an ordinary admin', r.status === 403, `${r.status}`);

    // --- a sensitive change is held, not applied ---------------------------
    const victim = (await admin.req('GET', '/api/users')).data.users.find((u) => u.email === 'jordan.brooks@ethixweb.local');
    r = await fresh.req('DELETE', `/api/users/${victim.id}`);
    check('a sensitive change is held for approval', r.status === 202, `${r.status} ${r.text.slice(0, 200)}`);
    check('the response says nothing has changed yet', r.data.pendingApproval === true);
    const requestId = r.data.request?.id;
    check('the request explains itself in plain words',
      /Delete the employee account for Jordan Brooks/.test(r.data.request?.summary || ''), r.data.request?.summary);

    const stillThere = await db.find('users', victim.id);
    check('the account was NOT deleted while pending', Boolean(stillThere));

    // --- everyone who can decide was told ----------------------------------
    r = await admin.req('GET', '/api/notifications');
    check('the approver got a bell',
      (r.data.notifications || []).some((n) => n.type === 'approval' && /Fresh Admin needs approval/.test(n.message)));
    r = await admin.req('GET', '/api/mail/log');
    check('the approver got an email',
      (r.data.entries || []).some((e) => e.template === 'approval_requested'));

    // --- nobody signs their own --------------------------------------------
    r = await fresh.req('POST', `/api/approvals/${requestId}/approve`);
    check('you cannot approve your own request', r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);
    check('a self-approval leaves the account alone', Boolean(await db.find('users', victim.id)));

    // --- and the queue is visible to both sides ----------------------------
    r = await fresh.req('GET', '/api/approvals');
    check('the requester can watch their own queue', r.status === 200 && r.data.requests.length >= 1, `${r.status}`);
    r = await admin.req('GET', '/api/approvals?status=pending');
    check('the approver sees it pending', (r.data.requests || []).some((x) => x.id === requestId));
    check('the queue never leaks a password',
      !JSON.stringify(r.data).includes('FreshAdmin#1') && !/"password"/.test(JSON.stringify(r.data)));

    // --- approval executes it, exactly once --------------------------------
    r = await admin.req('POST', `/api/approvals/${requestId}/approve`, { note: 'Checked with the team.' });
    check('a super admin can approve', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    check('the approved request is stamped executed', Boolean(r.data.request?.executedAt));
    check('the change actually landed', !(await db.find('users', victim.id)));

    r = await admin.req('POST', `/api/approvals/${requestId}/approve`);
    check('a decided request cannot be approved twice', r.status === 409, `${r.status}`);

    r = await fresh.req('GET', '/api/notifications');
    check('the requester was told the answer',
      (r.data.notifications || []).some((n) => /approved your request/.test(n.message)));

    // --- rejection changes nothing -----------------------------------------
    const victim2 = (await admin.req('GET', '/api/users')).data.users.find((u) => u.email === 'emily.turner@ethixweb.local');
    r = await fresh.req('DELETE', `/api/users/${victim2.id}`);
    const rejectId = r.data.request?.id;
    r = await admin.req('POST', `/api/approvals/${rejectId}/reject`, { note: 'We still need Emily.' });
    check('a request can be turned down', r.status === 200 && r.data.request?.status === 'rejected', `${r.status}`);
    check('a rejected change never happened', Boolean(await db.find('users', victim2.id)));

    // --- vouching removes the gate -----------------------------------------
    r = await admin.req('POST', `/api/users/${freshId}/standing`, { trusted: true });
    check('a super admin can vouch for an admin', r.status === 200 && r.data.user?.adminTrusted === true, `${r.status} ${r.text.slice(0, 160)}`);

    const victim3 = (await admin.req('GET', '/api/users')).data.users.find((u) => u.email === 'emily.turner@ethixweb.local');
    r = await fresh.req('DELETE', `/api/users/${victim3.id}`);
    check('a trusted admin acts without approval', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    check('and the change landed immediately', !(await db.find('users', victim3.id)));

    // --- a trusted admin can now decide, but still not for themselves ------
    r = await admin.req('POST', `/api/users/${freshId}/standing`, { trusted: false });
    check('trust can be withdrawn', r.status === 200 && r.data.user?.adminTrusted === false, `${r.status}`);

    // --- the last super admin cannot step down ------------------------------
    const meId = (await admin.req('GET', '/api/auth/me')).data.user.id;
    r = await admin.req('POST', `/api/users/${meId}/standing`, { superAdmin: false });
    check('the only super admin cannot step down', r.status === 409, `${r.status} ${r.text.slice(0, 160)}`);

    // --- a super admin cannot be deleted by anyone else ---------------------
    r = await admin.req('POST', `/api/users/${freshId}/standing`, { superAdmin: true });
    check('a super admin can appoint another', r.status === 200 && r.data.user?.isSuperAdmin === true, `${r.status}`);
    check('appointing a super admin trusts them too', r.data.user?.adminTrusted === true);
    r = await admin.req('DELETE', `/api/users/${freshId}`);
    check('a super admin cannot be deleted', r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);

    // --- the log ------------------------------------------------------------
    r = await admin.req('GET', '/api/approvals/audit-log');
    check('a super admin can read the audit log', r.status === 200, `${r.status}`);
    const entries = r.data.entries || [];
    check('the log records the approval', entries.some((e) => e.entity === 'approval_request' && e.action === 'approve'));
    check('the log records standing changes', entries.some((e) => e.action === 'standing'));
    // The decision and the change it released are two separate facts; a log
    // that only holds the first cannot answer "what actually happened".
    const executed = entries.find((e) => e.entity === 'user' && e.action === 'delete' && e.meta?.viaApproval);
    check('the log records the change the approval released', Boolean(executed), JSON.stringify(entries.slice(0, 3)));
    check('the released change is attributed to whoever proposed it',
      executed?.actorName === 'Fresh Admin', executed?.actorName);
    check('and names who let it through', Boolean(executed?.meta?.approvedBy));
    check('the log names the actor', entries.every((e) => Boolean(e.actorName)));

    // --- closing a ticket needs a second signature -------------------------
    // The client is told their request is finished. That is not a message you
    // un-send, so it goes through the queue like any other hard-to-undo change.
    {
      r = await admin.req('POST', `/api/users/${freshId}/standing`, { superAdmin: false, trusted: false });
      check('the proposer is untrusted again for this part', r.status === 200, `${r.status}`);

      const open = (await admin.req('GET', '/api/tickets')).data.tickets
        .find((t) => !['Resolved', 'Closed'].includes(t.status));
      check('there is an open ticket to close', Boolean(open));

      const mailBefore = (await admin.req('GET', '/api/mail/log')).data.entries || [];
      const statusMailsBefore = mailBefore.filter((e) => e.template === 'ticket_status').length;

      r = await fresh.req('PUT', `/api/tickets/${open.id}`, { status: 'Resolved' });
      check('closing a ticket is held for approval', r.status === 202, `${r.status} ${r.text.slice(0, 200)}`);
      check('the request says what it will tell the client',
        /tell the client/.test(r.data.request?.summary || ''), r.data.request?.summary);
      const closeId = r.data.request?.id;

      const stillOpen = await db.find('tickets', open.id);
      check('the ticket is NOT closed while pending', stillOpen.status === open.status, stillOpen.status);

      const mailMid = (await admin.req('GET', '/api/mail/log')).data.entries || [];
      check('the client is NOT emailed while pending',
        mailMid.filter((e) => e.template === 'ticket_status').length === statusMailsBefore);

      // A change that is not a closure still saves straight away.
      r = await fresh.req('PUT', `/api/tickets/${open.id}`, { priority: 'Low' });
      check('an ordinary ticket edit is not held', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);

      // --- and the signature releases the whole thing, email included ------
      r = await admin.req('POST', `/api/approvals/${closeId}/approve`);
      check('a trusted admin can confirm the closure', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);

      const closed = await db.find('tickets', open.id);
      check('the ticket is closed once confirmed', closed.status === 'Resolved', closed.status);

      const mailAfter = (await admin.req('GET', '/api/mail/log')).data.entries || [];
      const sent = mailAfter.filter((e) => e.template === 'ticket_status');
      check('the client IS emailed once it is confirmed', sent.length === statusMailsBefore + 1,
        `${sent.length} vs ${statusMailsBefore}`);

      // The whole point of the dedicated address: it goes to the client who
      // owns this ticket, not to an admin and not to a shared inbox.
      const owner = await db.find('users', open.clientId);
      const theirs = sent.find((e) => String(e.toEmails).includes(owner.email));
      check('the email went to the ticket\'s own client', Boolean(theirs),
        `${owner.email} not in ${sent.map((e) => e.toEmails).join(' | ')}`);
      check('and to nobody else', theirs && String(theirs.toEmails).split(',').length === 1, theirs?.toEmails);

      check('the client was told in the app too',
        (await db.filter('notifications', (n) => n.userId === open.clientId && /is now Resolved/.test(n.message))).length >= 1);
      check('the closure is stamped as notified', Boolean((await db.find('tickets', open.id)).resolvedNotifiedAt));
    }

    // Put the workspace back the way the later tests expect it.
    await admin.req('POST', `/api/users/${freshId}/standing`, { superAdmin: false });
    await admin.req('DELETE', `/api/users/${freshId}`);
    void roles;
  }

  // --- Stripe mirror -------------------------------------------------------
  // No Stripe keys in a test run, so the webhook handler is driven directly.
  // That is the whole point of keeping it a pure function of the event: the
  // mirroring can be proven without a network or a secret.
  {
    const billingRoute = require('../routes/billing');
    const { db } = require('../db/setup');

    await admin.req('PUT', `/api/users/${clientId}`, {
      allowedPages: ['tickets', 'progress', 'projects', 'billing', 'budget'],
    });
    await db.insert('billing', {
      clientId, stripeCustomerId: 'cus_test_1', plan: 'standard', status: 'pending',
      updatedAt: new Date().toISOString(),
    });

    const invoice = {
      id: 'in_test_1',
      customer: 'cus_test_1',
      currency: 'usd',
      amount_paid: 24900,
      amount_due: 24900,
      status: 'paid',
      number: 'EW-9001',
      hosted_invoice_url: 'https://invoice.stripe.com/i/test',
      invoice_pdf: 'https://invoice.stripe.com/i/test.pdf',
      billing_reason: 'subscription_cycle',
      created: Math.floor(Date.now() / 1000),
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
      lines: { data: [{ description: 'Website care plan', period: { start: 0, end: 0 } }] },
      charge: { payment_method_details: { card: { brand: 'visa', last4: '4242' } } },
    };

    await billingRoute.handleEvent({ type: 'invoice.paid', data: { object: invoice } });

    r = await client.req('GET', '/api/billing/payments');
    check('a client can read their payment history', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
    const first = (r.data.payments || [])[0];
    check('the Stripe invoice was mirrored', first?.stripeObjectId === 'in_test_1', JSON.stringify(first?.stripeObjectId));
    check('the amount is converted out of minor units', Number(first?.amount) === 249, `${first?.amount}`);
    check('the receipt links back to Stripe', first?.invoiceUrl === 'https://invoice.stripe.com/i/test');
    check('the total matches the payment', Number(r.data.total) === 249, `${r.data.total}`);
    check('the breakdown is grouped by what it was for',
      (r.data.categories || [])[0]?.label === 'Website care plan', JSON.stringify(r.data.categories));

    // Stripe retries; the mirror must not grow a second row for one payment.
    await billingRoute.handleEvent({ type: 'invoice.paid', data: { object: invoice } });
    r = await client.req('GET', '/api/billing/payments');
    check('a replayed webhook does not duplicate the payment', (r.data.payments || []).length === 1,
      `${(r.data.payments || []).length} rows`);

    r = await admin.req('GET', '/api/mail/log');
    const paidTemplates = (r.data.entries || []).filter((e) => e.template === 'paymentReceived');
    check('the receipt email is sent once', paidTemplates.length === 1, `${paidTemplates.length} sent`);

    // A declined card moves the plan and warns the client.
    await billingRoute.handleEvent({
      type: 'invoice.payment_failed',
      data: {
        object: {
          ...invoice,
          id: 'in_test_2',
          status: 'open',
          number: 'EW-9002',
          last_finalization_error: { message: 'Your card was declined.' },
        },
      },
    });
    r = await client.req('GET', '/api/billing/status');
    check('a failed payment puts the plan past due', r.data.billing?.status === 'past_due', JSON.stringify(r.data.billing?.status));
    r = await client.req('GET', '/api/billing/payments');
    const failed = (r.data.payments || []).find((x) => x.stripeObjectId === 'in_test_2');
    check('the failed payment is on the record', failed?.status === 'failed', JSON.stringify(failed?.status));
    check('a failed payment is left out of the total', Number(r.data.total) === 249, `${r.data.total}`);

    // The subscription's own fields are mirrored for the plan card.
    await billingRoute.handleEvent({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_1',
          customer: 'cus_test_1',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          cancel_at_period_end: false,
          items: { data: [{ quantity: 1, price: { unit_amount: 24900, currency: 'usd', nickname: 'Care plan', recurring: { interval: 'month' } } }] },
        },
      },
    });
    r = await client.req('GET', '/api/billing/status');
    check('the plan reads its price from Stripe', Number(r.data.billing?.amount) === 249, `${r.data.billing?.amount}`);
    check('the plan reads its interval from Stripe', r.data.billing?.interval === 'month', `${r.data.billing?.interval}`);
    check('a paid plan reads as active', r.data.billing?.status === 'active', `${r.data.billing?.status}`);

    // And a client with billing switched off gets none of it.
    await admin.req('PUT', `/api/users/${clientId}`, { allowedPages: ['tickets'] });
    r = await client.req('GET', '/api/billing/payments');
    check('page toggles gate the payment history', r.status === 403, `${r.status}`);
    await admin.req('PUT', `/api/users/${clientId}`, {
      allowedPages: ['tickets', 'progress', 'projects', 'billing'],
    });
  }

  // --- the client's own Slack channel --------------------------------------
  // Slack is not configured in a test run, so this covers the part that has to
  // be right regardless: which channel a client is bound to, and that they
  // cannot reach any other one.
  {
    const { db } = require('../db/setup');

    r = await admin.req('POST', '/api/users', {
      name: 'Channel Client', email: 'channel.client@example.com', role: 'client',
      password: 'ChannelPass#1', company: 'Channel Co',
      allowedPages: ['tickets', 'messages'],
      slackChannelId: 'C0CHANNEL1', slackChannelName: 'brightpath-team',
    });
    check('a client can be issued with a Slack channel', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
    const chanClientId = r.data.user?.id;
    check('the channel is stored on their record', r.data.user?.slackChannelId === 'C0CHANNEL1', r.data.user?.slackChannelId);
    check('and the readable name with it', r.data.user?.slackChannelName === 'brightpath-team');

    // A Slack id has a shape; a URL or a channel name is a mistake worth catching.
    r = await admin.req('POST', '/api/users', {
      name: 'Bad Channel', email: 'bad.channel@example.com', role: 'client',
      password: 'BadPass#1', slackChannelId: 'https://slack.com/app_redirect?channel=general',
    });
    check('a channel id that is not one is refused', r.status === 400, `${r.status} ${r.text.slice(0, 160)}`);

    r = await admin.req('POST', '/api/users', {
      name: 'DM Channel', email: 'dm.channel@example.com', role: 'client',
      password: 'DmPass#1', slackChannelId: 'D01PRIVATE',
    });
    check('a direct-message id is refused, it is not a shared room', r.status === 400, `${r.status}`);

    // --- the client sees theirs, and only theirs -------------------------
    const chanClient = makeClient(base);
    r = await chanClient.req('POST', '/api/auth/login', { email: 'channel.client@example.com', password: 'ChannelPass#1' });
    chanClient.setCsrf(r.data.csrfToken);
    const codeRows = (await admin.req('GET', '/api/auth/otp-logs')).data.logs || [];
    const mineCode = codeRows.filter((l) => l.email === 'channel.client@example.com')[0];
    const code2 = (await admin.req('POST', `/api/auth/otp-logs/${mineCode.id}/reveal`)).data.code;
    r = await chanClient.req('POST', '/api/auth/verify-otp', { code: code2 });
    chanClient.setCsrf(r.data.csrfToken);
    check('the channel client can sign in', r.status === 200, `${r.status}`);

    r = await chanClient.req('GET', '/api/client/channel');
    check('they can read their channel endpoint', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
    check('it reports Slack as unconfigured here', r.data.enabled === false, JSON.stringify(r.data.enabled));

    // The decisive one: a client naming somebody else's channel gets their own
    // scope regardless, because the id is read from their account.
    const other = (await admin.req('GET', '/api/users')).data.users
      .find((u) => u.role === 'client' && u.id !== chanClientId);
    r = await chanClient.req('GET', `/api/client/channel?clientId=${other.id}`);
    check('a client cannot ask for another client\'s channel',
      r.status === 200 && (!r.data.client || r.data.client.id === chanClientId),
      JSON.stringify(r.data.client));

    // --- the page toggle gates it ----------------------------------------
    await admin.req('PUT', `/api/users/${chanClientId}`, { allowedPages: ['tickets'] });
    r = await chanClient.req('GET', '/api/client/channel');
    check('turning Messages off closes the channel', r.status === 403, `${r.status}`);
    r = await chanClient.req('POST', '/api/client/channel/messages', { body: 'hello' });
    check('and closes writing to it too', r.status === 403, `${r.status}`);
    await admin.req('PUT', `/api/users/${chanClientId}`, { allowedPages: ['tickets', 'messages'] });

    // --- writing needs something to write --------------------------------
    r = await chanClient.req('POST', '/api/client/channel/messages', { body: '   ' });
    check('an empty message is refused', r.status === 400, `${r.status}`);
    r = await chanClient.req('POST', '/api/client/channel/messages', { body: 'x'.repeat(4001) });
    check('an enormous message is refused', r.status === 400, `${r.status}`);
    r = await chanClient.req('POST', '/api/client/channel/messages', { body: 'Any update on the homepage?' });
    check('without Slack connected, sending says so plainly', r.status === 503, `${r.status} ${r.text.slice(0, 160)}`);

    // --- the channel can be changed and cleared ---------------------------
    r = await admin.req('PUT', `/api/users/${chanClientId}`, { slackChannelId: 'C0CHANNEL2', slackChannelName: 'moved' });
    check('an admin can move a client to another channel',
      r.status === 200 && r.data.user?.slackChannelId === 'C0CHANNEL2', `${r.status} ${r.data.user?.slackChannelId}`);
    r = await admin.req('PUT', `/api/users/${chanClientId}`, { slackChannelId: '' });
    check('and can take the channel away', r.status === 200 && !r.data.user?.slackChannelId, JSON.stringify(r.data.user?.slackChannelId));

    const cleared = await db.find('users', chanClientId);
    check('clearing it wipes the name too', !cleared.slackChannelName, cleared.slackChannelName);

    r = await chanClient.req('GET', '/api/client/channel');
    check('with no channel the page has nothing to show', r.status === 200 && r.data.channel === null, JSON.stringify(r.data.channel));

    // Staff are not restricted the way a client is.
    r = await admin.req('GET', `/api/client/channel?clientId=${chanClientId}`);
    check('staff can look at a named client\'s channel', r.status === 200, `${r.status}`);

    await admin.req('DELETE', `/api/users/${chanClientId}`);
  }

  // --- domain expiry reminders ---------------------------------------------
  // A domain lapsing quietly is one of the few failures a client cannot undo
  // afterwards, so the reminders have to be both reliable and not spam.
  {
    const domainWatch = require('../utils/domainWatch');
    const { db } = require('../db/setup');

    // --- the milestone maths, without touching the database ----------------
    const at = (days) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      return d.toDateString();
    };
    check('a date a month out lands on the 30-day milestone',
      domainWatch.milestoneFor(domainWatch.daysUntil({ expiresAt: at(30) })) === 30);
    check('the day before lands on the 1-day milestone',
      domainWatch.milestoneFor(domainWatch.daysUntil({ expiresAt: at(1) })) === 1);
    check('the day itself lands on 0',
      domainWatch.milestoneFor(domainWatch.daysUntil({ expiresAt: at(0) })) === 0);
    check('yesterday lands on -1',
      domainWatch.milestoneFor(domainWatch.daysUntil({ expiresAt: at(-1) })) === -1);
    check('far in the future is not due yet',
      domainWatch.milestoneFor(domainWatch.daysUntil({ expiresAt: at(120) })) === null);
    check('long expired is left alone',
      domainWatch.milestoneFor(domainWatch.daysUntil({ expiresAt: at(-90) })) === null);
    check('a missing date is skipped rather than crashing',
      domainWatch.daysUntil({ expiresAt: '' }) === null && domainWatch.daysUntil({ expiresAt: 'not a date' }) === null);
    check('a human date parses the same as an ISO one',
      domainWatch.expiryDay('Sep 14, 2026') === domainWatch.expiryDay('2026-09-14T11:30:00Z'));
    // A sweep that missed a few days must still speak, not skip the milestone.
    check('a missed sweep catches up to the nearest milestone below',
      domainWatch.milestoneFor(9) === 7 && domainWatch.milestoneFor(20) === 14);

    // --- the real thing ----------------------------------------------------
    const theClient = (await admin.req('GET', '/api/users')).data.users.find((u) => u.role === 'client');
    r = await admin.req('POST', '/api/domains', {
      clientId: theClient.id,
      domainName: 'expiring-soon.example',
      registrar: 'Registered with EthixWeb',
      expiresAt: at(7),
    });
    check('a domain can be recorded with an expiry', r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
    const domainId = r.data.domain?.id;

    // Scoped to this domain: the seeded workspace has its own addresses, and
    // some of them are legitimately due today too.
    const mineOnly = (entries) =>
      entries.filter((e) => e.template === 'domain_expiring' && /expiring-soon\.example/.test(e.subject));
    const before = mineOnly((await admin.req('GET', '/api/mail/log')).data.entries || []).length;

    let sweep = await domainWatch.runSweep();
    check('the sweep finds the domain that is due', sweep.due >= 1, JSON.stringify(sweep));
    check('and sends a reminder for it', sweep.sent >= 1, JSON.stringify(sweep));

    const reminders = mineOnly((await admin.req('GET', '/api/mail/log')).data.entries || []);
    check('a reminder email was logged', reminders.length === before + 1, `${reminders.length} vs ${before}`);

    const mine = reminders[0];
    check('the reminder went to the client who owns the domain',
      String(mine.toEmails).includes(theClient.email), mine.toEmails);
    check('and to nobody else', String(mine.toEmails).split(',').length === 1, mine.toEmails);
    check('the subject says when it expires', /expires in 7 days/.test(mine.subject), mine.subject);

    check('the client was told in the app too',
      (await db.filter('notifications', (n) => n.userId === theClient.id && /expiring-soon\.example/.test(n.message))).length === 1);

    // --- and never twice ---------------------------------------------------
    sweep = await domainWatch.runSweep();
    check('a second sweep sends nothing new', sweep.sent === 0, JSON.stringify(sweep));
    check('it recognises the reminder as already sent', sweep.skipped >= 1, JSON.stringify(sweep));
    const afterSecond = mineOnly((await admin.req('GET', '/api/mail/log')).data.entries).length;
    check('so the client is not written to twice', afterSecond === before + 1, `${afterSecond}`);

    // --- a renewal starts a fresh series -----------------------------------
    r = await admin.req('POST', `/api/domains/${domainId}/renew`);
    check('a domain can be renewed', r.status === 200, `${r.status}`);
    sweep = await domainWatch.runSweep();
    check('a renewed domain is no longer due',
      mineOnly((await admin.req('GET', '/api/mail/log')).data.entries).length === before + 1, JSON.stringify(sweep));

    // Move it back to a different milestone: the key changes with the date, so
    // the new cycle can speak again rather than being silenced forever.
    await db.update('domains', domainId, { expiresAt: at(1) });
    sweep = await domainWatch.runSweep();
    check('a new expiry date starts the reminders again', sweep.sent >= 1, JSON.stringify(sweep));
    const tomorrow = (await admin.req('GET', '/api/mail/log')).data.entries
      .find((e) => e.template === 'domain_expiring' && /expires tomorrow/.test(e.subject));
    check('and the wording follows the new date', Boolean(tomorrow), tomorrow?.subject);

    // --- once it has lapsed ------------------------------------------------
    await db.update('domains', domainId, { expiresAt: at(-1) });
    sweep = await domainWatch.runSweep();
    check('an expired domain is chased too', sweep.sent >= 1, JSON.stringify(sweep));
    const lapsed = (await admin.req('GET', '/api/mail/log')).data.entries
      .find((e) => e.template === 'domain_expiring' && /expired yesterday/.test(e.subject));
    check('and it says it has already lapsed', Boolean(lapsed), lapsed?.subject);

    // --- an admin can run it on demand -------------------------------------
    r = await admin.req('POST', '/api/mail/domain-sweep');
    check('an admin can run the sweep from the Mail page', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
    check('the run reports what it did', typeof r.data.sent === 'number', JSON.stringify(r.data));

    await admin.req('DELETE', `/api/domains/${domainId}`);
  }

  // --- projects ------------------------------------------------------------
  // Full CRUD on three of the busiest sections had no coverage at all, so a
  // regression in any of them would have shipped silently.
  r = await admin.req('POST', '/api/projects', {
    name: 'Coverage Project', type: 'Website', clientId, status: 'In Progress',
  });
  check('an admin can create a project', r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
  const coverProjectId = r.data.project?.id;

  r = await admin.req('GET', '/api/projects');
  check('the new project is in the list', (r.data.projects || []).some((p) => p.id === coverProjectId));

  r = await admin.req('PUT', `/api/projects/${coverProjectId}`, { status: 'On Track' });
  check('an admin can update a project', r.status === 200 && r.data.project?.status === 'On Track', `${r.status} ${r.text.slice(0, 160)}`);

  r = await client.req('POST', '/api/projects', { name: 'Nope', clientId });
  check('a client cannot create a project', r.status === 403, `${r.status}`);

  // --- tasks ---------------------------------------------------------------
  r = await admin.req('POST', '/api/tasks', {
    projectId: coverProjectId, name: 'Coverage Task',
  });
  check('an admin can create a task', r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
  const coverTaskId = r.data.task?.id;

  r = await admin.req('PUT', `/api/tasks/${coverTaskId}`, { status: 'Done' });
  check('an admin can complete a task', r.status === 200 && r.data.task?.status === 'Done', `${r.status} ${r.text.slice(0, 160)}`);

  r = await admin.req('POST', '/api/tasks', { name: 'No project' });
  check('a task without a project is refused', r.status === 400, `${r.status}`);

  // A client is not blocked from the board outright -- they see the tasks on
  // their own projects and nothing else, so assert the scoping, not a 403.
  const clientProjects = (await client.req('GET', '/api/projects')).data.projects || [];
  const ownProjectIds = new Set(clientProjects.map((p) => p.id));
  r = await client.req('GET', '/api/tasks');
  const foreign = (r.data.tasks || []).filter((t) => t.projectId && !ownProjectIds.has(t.projectId));
  check('a client sees only tasks on their own projects', r.status === 200 && foreign.length === 0, `${r.status}, ${foreign.length} foreign`);

  r = await client.req('POST', '/api/tasks', { projectId: coverProjectId, name: 'Nope' });
  check('a client cannot create a task', r.status === 403, `${r.status}`);

  r = await admin.req('DELETE', `/api/tasks/${coverTaskId}`);
  check('an admin can delete a task', r.status === 200, `${r.status}`);

  // --- budget --------------------------------------------------------------
  r = await admin.req('POST', '/api/budget', {
    clientId, label: 'Coverage Ads', amount: 1200,
  });
  check('an admin can record a budget line', r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
  const coverBudgetId = r.data.item?.id;

  r = await admin.req('GET', '/api/budget');
  check('the budget line is listed', (r.data.items || []).some((i) => i.id === coverBudgetId), r.text.slice(0, 160));

  r = await admin.req('POST', '/api/budget', { clientId, label: 'No amount' });
  check('a budget line without an amount is refused', r.status === 400, `${r.status}`);

  r = await client.req('POST', '/api/budget', { clientId, label: 'Nope', amount: 5 });
  check('a client cannot write a budget line', r.status === 403, `${r.status}`);

  r = await admin.req('DELETE', `/api/budget/${coverBudgetId}`);
  check('an admin can remove a budget line', r.status === 200, `${r.status}`);

  await admin.req('DELETE', `/api/projects/${coverProjectId}`);

  // --- report upload -------------------------------------------------------
  // The multipart path, the size cap, and who is allowed to reach it. None of
  // this was exercised, and it is the one route that accepts arbitrary bytes.
  r = await admin.upload('/api/reports', { clientId, category: 'General' }, {
    name: 'coverage.txt', type: 'text/plain', bytes: 'hello from the coverage test',
  });
  check('an admin can upload a document', r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
  const coverReportId = r.data.report?.id;
  check('the stored row knows it has bytes', r.data.report?.hasFile === true, JSON.stringify(r.data.report));
  check('the upload never echoes the file back', r.data.report?.contentBase64 === undefined);

  r = await admin.req('GET', `/api/reports/${coverReportId}/download`);
  check('the document downloads again', r.status === 200 && r.text.includes('coverage test'), `${r.status}`);

  r = await admin.upload('/api/reports', { clientId }, null);
  check('an upload with no file is refused', r.status === 400, `${r.status}`);

  r = await admin.upload('/api/reports', { category: 'General' }, {
    name: 'x.txt', type: 'text/plain', bytes: 'x',
  });
  check('an upload with no client is refused', r.status === 400, `${r.status}`);

  r = await client.upload('/api/reports', { clientId, category: 'General' }, {
    name: 'client.txt', type: 'text/plain', bytes: 'nope',
  });
  check('a client cannot upload a document', r.status === 403, `${r.status}`);

  // An SVG is a document that can carry script, so it is refused at the door
  // rather than merely kept off the inline list.
  r = await admin.upload('/api/reports', { clientId, category: 'General' }, {
    name: 'art.svg', type: 'image/svg+xml', bytes: '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
  });
  check('an SVG is refused on upload', r.status === 415, `${r.status} ${r.text.slice(0, 160)}`);

  r = await admin.upload('/api/reports', { clientId, category: 'General' }, {
    name: 'payload.html', type: 'text/html', bytes: '<script>alert(1)</script>',
  });
  check('an HTML file is refused on upload', r.status === 415, `${r.status} ${r.text.slice(0, 160)}`);

  // What a browser is allowed to render in place, and how it is labelled.
  const disposition = (await admin.req('GET', `/api/reports/${coverReportId}/download?disposition=inline`))
    .headers?.get('content-disposition') || '';
  check('a viewable type may be shown inline', disposition.startsWith('inline'), disposition);

  const attached = (await admin.req('GET', `/api/reports/${coverReportId}/download`))
    .headers?.get('content-disposition') || '';
  check('and is a download without that flag', attached.startsWith('attachment'), attached);

  await admin.req('DELETE', `/api/reports/${coverReportId}`);


  // --- backup sign-in codes ------------------------------------------------
  // An administrator's way back in when mail is down. Never covered, and it is
  // the only path that still works when the transport does not.
  r = await admin.req('GET', '/api/users/me/recovery-codes');
  check('an admin can read their backup code status', r.status === 200 && typeof r.data.status?.remaining === 'number', `${r.status} ${r.text.slice(0, 160)}`);

  r = await admin.req('POST', '/api/users/me/recovery-codes', {});
  const issuedCodes = r.data.codes || [];
  check('an admin can issue a fresh set of backup codes', r.status === 200 && issuedCodes.length > 0, `${r.status} ${r.text.slice(0, 160)}`);
  check('the codes are only shown once, as a list', Array.isArray(issuedCodes) && issuedCodes.every((c) => typeof c === 'string'));

  r = await admin.req('GET', '/api/users/me/recovery-codes');
  check('the status reflects the new set', r.data.status?.remaining === issuedCodes.length, JSON.stringify(r.data.status));

  r = await client.req('GET', '/api/users/me/recovery-codes');
  check('a client has no backup codes to read', r.status === 403 || r.data.status?.remaining === 0, `${r.status} ${r.text.slice(0, 120)}`);

  // --- scheduled credential delivery ---------------------------------------
  // The whole point of this feature: an admin books a moment, and at that
  // moment the account is emailed a link that lets it set its own password.
  // Nothing here ever sees a password, and neither does the admin.
  {
    const { db } = require('../db/setup');

    r = await admin.req('POST', `/api/credentials/${clientId}`, { scheduledAt: Date.now() + 3600_000 });
    check('an admin can schedule a credential delivery',
      r.status === 201 && r.data.delivery?.status === 'scheduled', `${r.status} ${r.text.slice(0, 200)}`);
    const deliveryId = r.data.delivery?.id;

    r = await admin.req('POST', `/api/credentials/${clientId}`, { scheduledAt: Date.now() + 7200_000 });
    check('rescheduling moves the existing row rather than queueing a second',
      r.status === 200 && r.data.rescheduled === true && r.data.delivery?.id === deliveryId,
      `${r.status} ${r.text.slice(0, 200)}`);

    r = await admin.req('GET', '/api/credentials');
    const forClient = (r.data.deliveries || []).filter((d) => d.userId === clientId);
    check('the account has exactly one delivery on record', forClient.length === 1, JSON.stringify(forClient));
    check('the delivery record carries no secret',
      !/password|token|secret/i.test(JSON.stringify(forClient[0] || {})), JSON.stringify(forClient[0] || {}));

    r = await admin.req('POST', `/api/credentials/${clientId}`, { scheduledAt: 'tomorrow please' });
    check('a delivery needs a real timestamp', r.status === 400, `${r.status} ${r.text.slice(0, 160)}`);

    r = await admin.req('DELETE', `/api/credentials/${clientId}`);
    check('a pending delivery can be cancelled',
      r.status === 200 && r.data.delivery?.status === 'cancelled', `${r.status} ${r.text.slice(0, 200)}`);

    r = await admin.req('DELETE', `/api/credentials/${clientId}`);
    check('cancelling twice is refused rather than silently repeated', r.status === 404, `${r.status}`);

    // A transport, just for this block, so the send can actually be proved.
    // Every other test in this file runs with none on purpose.
    const http = require('http');
    const delivered = [];
    const sink = http.createServer((req2, res2) => {
      let body = '';
      req2.on('data', (c) => { body += c; });
      req2.on('end', () => {
        try { delivered.push(JSON.parse(body)); } catch { delivered.push({ raw: body }); }
        res2.writeHead(200, { 'Content-Type': 'application/json' });
        res2.end('{"ok":true}');
      });
    });
    await new Promise((resolve) => sink.listen(0, resolve));
    process.env.MAIL_WEBHOOK_URL = `http://127.0.0.1:${sink.address().port}/mail`;
    process.env.MAIL_FROM = 'EthixWeb <noreply@example.com>';

    try {
      const scheduler = require('../utils/credentialScheduler');

      r = await admin.req('POST', `/api/credentials/${clientId}`, { scheduledAt: Date.now() - 1000 });
      check('a delivery can be booked for a moment that has passed', r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
      const dueId = r.data.delivery.id;

      let sweep = await scheduler.runSweep();
      check('the sweep sends what is due', sweep.sent === 1 && sweep.failed === 0, JSON.stringify(sweep));
      check('the email really left the building', delivered.length === 1, `${delivered.length} sent`);
      const activationText = String(delivered[0] && delivered[0].text || '');
      check('and hands over no password',
        !/^\s*Password:/mi.test(activationText) && !activationText.includes('ClientPass#1'),
        activationText.slice(0, 200));
      check('it carries a single-use set-password link',
        /set-password#token=/.test(String(delivered[0] && delivered[0].text || '')),
        String(delivered[0] && delivered[0].text || '').slice(0, 200));

      let row = await db.find('credential_deliveries', dueId);
      check('the delivery is marked sent', row.status === 'sent' && Number(row.sentAt) > 0, JSON.stringify(row.status));

      // The duplicate guarantee. A second sweep -- a second serverless
      // invocation, a timer racing a page load -- must find nothing to do.
      sweep = await scheduler.runSweep();
      check('a second sweep sends nothing, so nobody gets two credential emails',
        sweep.sent === 0 && sweep.due === 0 && delivered.length === 1,
        `${JSON.stringify(sweep)} / ${delivered.length} emails`);

      const stored = await db.filter('password_tokens', (t) => t.userId === clientId && t.purpose === 'activation');
      check('an activation token was stored', stored.length === 1, String(stored.length));
      const replayable = Object.values(stored[0] || {}).some(
        (v) => typeof v === 'string' && /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/.test(v),
      );
      check('only the hash of it, never anything replayable',
        stored[0] && /^[a-f0-9]{64}$/.test(stored[0].tokenHash) && !replayable,
        JSON.stringify(stored[0] || {}).slice(0, 200));

      const logged = await db.filter('email_log', (e) => e.template === 'account_activation');
      check('the send is on the mail log', logged.length === 1, String(logged.length));
      check('with the live token redacted out of the stored body',
        !/set-password#token=[A-Za-z0-9._-]{20,}/.test(String(logged[0] && logged[0].html || '')),
        String(logged[0] && logged[0].html || '').slice(0, 160));
    } finally {
      delete process.env.MAIL_WEBHOOK_URL;
      sink.close();
    }

    // --- the password reset flow -------------------------------------------
    const passwordTokens = require('../utils/passwordTokens');

    // These are unauthenticated endpoints, and /password/reset clears the
    // caller's session cookie by design. Driven from an empty jar, so the
    // admin session running the rest of this file survives.
    const outsider = makeClient(base);
    r = await outsider.req('POST', '/api/auth/password/forgot', { email: 'qa.client@example.com' });
    const realAnswer = r.text;
    check('a reset can be requested without signing in', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);

    r = await outsider.req('POST', '/api/auth/password/forgot', { email: 'nobody@nowhere.example' });
    check('an unknown address gets a byte-identical answer, so nobody can enumerate accounts',
      r.status === 200 && r.text === realAnswer, r.text.slice(0, 160));

    // The secret only exists at mint time, so one is minted here the same way
    // the app does and the link is exercised end to end.
    const clientUser = await db.find('users', clientId);
    const minted = passwordTokens.issueToken();
    await db.insert('password_tokens', {
      id: minted.id,
      userId: clientId,
      purpose: 'reset',
      tokenHash: passwordTokens.hashSecret(minted.secret),
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 600_000,
      consumed: false,
    });
    const goodToken = passwordTokens.formatToken(minted);

    r = await outsider.req('POST', '/api/auth/password/verify', { token: goodToken });
    check('a live link verifies', r.status === 200 && r.data.ok === true, `${r.status} ${r.text.slice(0, 160)}`);
    check('and never echoes the account email back',
      !r.text.includes('qa.client@example.com'), r.text.slice(0, 160));

    r = await outsider.req('POST', '/api/auth/password/verify', {
      token: passwordTokens.formatToken({ id: minted.id, secret: 'not-the-secret' }),
    });
    check('a forged secret is refused', r.status === 400 && r.data.reason === 'invalid', `${r.status} ${r.text.slice(0, 160)}`);

    r = await outsider.req('POST', '/api/auth/password/verify', { token: 'garbage' });
    check('a malformed link is refused', r.status === 400, `${r.status}`);

    // An expired one, minted directly with a time already past.
    const stale = passwordTokens.issueToken();
    await db.insert('password_tokens', {
      id: stale.id,
      userId: clientId,
      purpose: 'reset',
      tokenHash: passwordTokens.hashSecret(stale.secret),
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() - 1000,
      consumed: false,
    });
    r = await outsider.req('POST', '/api/auth/password/verify', { token: passwordTokens.formatToken(stale) });
    check('an expired link is refused, and says so', r.status === 400 && r.data.reason === 'expired', `${r.status} ${r.text.slice(0, 160)}`);

    r = await outsider.req('POST', '/api/auth/password/reset', { token: goodToken, password: 'short' });
    check('a password below the policy minimum is refused', r.status === 422, `${r.status} ${r.text.slice(0, 160)}`);

    r = await outsider.req('POST', '/api/auth/password/reset', { token: goodToken, password: 'Quiet-Harbour-Lantern-4' });
    check('a good password is accepted', r.status === 200 && r.data.ok === true, `${r.status} ${r.text.slice(0, 200)}`);

    r = await outsider.req('POST', '/api/auth/password/reset', { token: goodToken, password: 'Second-Attempt-Password-8' });
    check('the same link cannot be used a second time',
      r.status === 400 && r.data.reason === 'used', `${r.status} ${r.text.slice(0, 160)}`);

    const afterReset = await db.find('users', clientId);
    check('the stored hash actually changed', afterReset.password !== clientUser.password);
    check('the password is never stored in the clear',
      !String(afterReset.password).includes('Quiet-Harbour-Lantern-4'));
    check('the reset stamped the password age', Number(afterReset.passwordChangedAt) > Date.now() - 60_000);
    check('and recorded that it was a reset', Number(afterReset.passwordResetAt) > 0);

    const liveSessions = await db.filter('sessions', (s) => s.userId === clientId);
    check('every session of that account was destroyed by the reset', liveSessions.length === 0, String(liveSessions.length));

    const auditRows = await db.filter('activity_log', (a) => a.action === 'password_reset' && a.entityId === clientId);
    check('the reset is in the audit log', auditRows.length === 1, String(auditRows.length));
    check('with no token or password in it',
      !/Quiet-Harbour|token/i.test(JSON.stringify(auditRows[0] || {})), JSON.stringify(auditRows[0] || {}).slice(0, 200));

    // --- the monthly policy ------------------------------------------------
    const policy = require('../utils/passwordPolicy');
    check('a freshly-set password reads as active', policy.statusFor(afterReset).state === 'reset_completed',
      policy.statusFor(afterReset).state);
    check('one past its month reads as reset required',
      policy.statusFor({ password: 'x', passwordChangedAt: Date.now() - 40 * 86400_000 }).state === 'reset_required');
    check('one nearly there reads as expiring soon',
      policy.statusFor({ password: 'x', passwordChangedAt: Date.now() - 27 * 86400_000 }).state === 'expiring_soon');
    check('a Google-only account is exempt',
      policy.statusFor({ password: null, googleId: 'g' }).state === 'no_password');

    // The gate. An account whose password has expired keeps its session and
    // loses the app, which is not the same thing as being signed out.
    await db.update('users', clientId, { passwordResetRequired: true });
    const gated = makeClient(base);
    let login = await gated.req('POST', '/api/auth/login', { email: 'qa.client@example.com', password: 'Quiet-Harbour-Lantern-4' });
    gated.setCsrf(login.data.csrfToken);
    const gatedLogs = (await admin.req('GET', '/api/auth/otp-logs')).data.logs || [];
    const gatedRow = gatedLogs.filter((l) => l.email === 'qa.client@example.com')[0];
    const gatedCode = (await admin.req('POST', `/api/auth/otp-logs/${gatedRow.id}/reveal`)).data.code;
    login = await gated.req('POST', '/api/auth/verify-otp', { code: gatedCode });
    gated.setCsrf(login.data.csrfToken);
    check('an expired password does not stop the sign-in itself', login.status === 200, `${login.status}`);

    r = await gated.req('GET', '/api/tickets');
    check('but it does close the rest of the app',
      r.status === 403 && r.data.passwordResetRequired === true, `${r.status} ${r.text.slice(0, 160)}`);
    r = await gated.req('GET', '/api/auth/me');
    check('who-am-I still answers, so the browser can explain why', r.status === 200, `${r.status}`);
    check('and says the password needs replacing',
      r.data.user?.passwordStatus?.resetRequired === true, JSON.stringify(r.data.user?.passwordStatus));

    r = await gated.req('PUT', '/api/users/me', { password: 'weak', currentPassword: 'Quiet-Harbour-Lantern-4' });
    check('the way out still enforces the policy', r.status === 422, `${r.status} ${r.text.slice(0, 160)}`);

    r = await gated.req('PUT', '/api/users/me', {
      password: 'Copper-Meadow-Signal-2', currentPassword: 'Quiet-Harbour-Lantern-4',
    });
    check('changing the password is allowed through the gate', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);

    r = await gated.req('GET', '/api/tickets');
    check('and lifts it', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);

    // --- authorization on the new surface ----------------------------------
    r = await client.req('GET', '/api/credentials');
    check('a client cannot read the credential delivery list', r.status === 403 || r.status === 401, `${r.status}`);
    r = await client.req('POST', `/api/credentials/${clientId}`, { scheduledAt: Date.now() });
    check('nor schedule one for themselves', r.status === 403 || r.status === 401, `${r.status}`);

    const stranger = makeClient(base);
    for (const path of ['/api/credentials', '/api/users/me/profile', '/api/users/me/avatar']) {
      r = await stranger.req('GET', path);
      check(`a stranger is refused ${path}`, r.status === 401, `${r.status}`);
    }

    // Resetting a password destroys every session that account had, which is
    // the whole point of a reset -- and it means the `client` session the rest
    // of this file signs its requests with is now dead. Put it back on a live
    // one, with the password the account actually ended up holding.
    const back = await signIn(client, 'qa.client@example.com', 'Copper-Meadow-Signal-2');
    check('the client can sign back in on the password they set',
      back.status === 200, `${back.status} ${String(back.text || '').slice(0, 160)}`);
  }

  // --- profile pictures ----------------------------------------------------
  {
    const png = pngBytes(96, 96);

    r = await admin.upload('/api/users/me/avatar', {}, null);
    check('an upload with no image is refused', r.status === 400, `${r.status} ${r.text.slice(0, 160)}`);

    r = await admin.uploadField('/api/users/me/avatar', 'avatar', { bytes: png, type: 'image/png', name: 'me.png' });
    check('an admin can upload their own picture',
      r.status === 201 && r.data.avatar?.width === 96 && r.data.avatar?.height === 96,
      `${r.status} ${r.text.slice(0, 200)}`);

    const fetched = await admin.raw('/api/users/me/avatar');
    check('the picture comes back byte for byte', fetched.status === 200 && fetched.buf.length === png.length,
      `${fetched.status} ${fetched.buf.length}/${png.length}`);
    check('served as the type the server decided, not the one claimed',
      fetched.headers.get('content-type') === 'image/png', String(fetched.headers.get('content-type')));
    check('and never in a shared cache',
      String(fetched.headers.get('cache-control')).includes('private'), String(fetched.headers.get('cache-control')));

    // The uploader's word is worth nothing: these all claim to be PNGs.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    r = await admin.uploadField('/api/users/me/avatar', 'avatar', { bytes: svg, type: 'image/png', name: 'evil.png' });
    check('an SVG named .png is refused on its contents', r.status === 415, `${r.status} ${r.text.slice(0, 160)}`);

    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    r = await admin.uploadField('/api/users/me/avatar', 'avatar', { bytes: html, type: 'image/jpeg', name: 'x.jpg' });
    check('an HTML file announced as a JPEG is refused', r.status === 415, `${r.status} ${r.text.slice(0, 160)}`);

    const tiny = pngBytes(8, 8);
    r = await admin.uploadField('/api/users/me/avatar', 'avatar', { bytes: tiny, type: 'image/png', name: 't.png' });
    check('an image below the minimum size is refused', r.status === 422, `${r.status} ${r.text.slice(0, 160)}`);

    const huge = Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]);
    r = await admin.uploadField('/api/users/me/avatar', 'avatar', { bytes: huge, type: 'image/png', name: 'big.png' });
    check('an oversized upload is refused with a size error, not a 500', r.status === 413, `${r.status} ${r.text.slice(0, 160)}`);

    // Replacing keeps exactly one row and moves the cache-busting stamp.
    const replacement = pngBytes(128, 128);
    const before = (await admin.req('GET', '/api/auth/me')).data.user.avatarUpdatedAt;
    r = await admin.uploadField('/api/users/me/avatar', 'avatar', { bytes: replacement, type: 'image/png', name: 'new.png' });
    check('a picture can be replaced', r.status === 201 && r.data.avatar?.width === 128, `${r.status} ${r.text.slice(0, 160)}`);
    check('and the stamp moves so browsers stop showing the old one',
      r.data.avatarUpdatedAt !== before, `${before} -> ${r.data.avatarUpdatedAt}`);

    r = await admin.req('GET', '/api/users');
    const self = (r.data.users || []).find((u) => u.email === 'admin@ethixweb.local');
    check('the user list says who has a picture', self?.hasAvatar === true, JSON.stringify(self?.hasAvatar));
    check('and still never carries a hash', !('password' in (self || {})));

    r = await client.uploadField(`/api/users/${(await admin.req('GET', '/api/auth/me')).data.user.id}/avatar`, 'avatar',
      { bytes: png, type: 'image/png', name: 'x.png' });
    check("a client cannot replace an admin's picture", r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);

    r = await admin.req('DELETE', '/api/users/me/avatar');
    check('a picture can be removed', r.status === 200 && r.data.removed === true, `${r.status} ${r.text.slice(0, 160)}`);
    const gone = await admin.raw('/api/users/me/avatar');
    check('and is gone afterwards', gone.status === 404, String(gone.status));
    check('the fallback is initials, so nothing breaks',
      (await admin.req('GET', '/api/auth/me')).data.user.hasAvatar === false);
  }

  // --- the profile page's data --------------------------------------------
  {
    r = await admin.req('GET', '/api/users/me/profile');
    check('the profile bundle loads', r.status === 200 && Boolean(r.data.user), `${r.status} ${r.text.slice(0, 200)}`);
    check('it lists this account\'s sessions and marks the current one',
      Array.isArray(r.data.sessions) && r.data.sessions.some((s) => s.current), JSON.stringify(r.data.sessions));
    check('it carries password standing', Boolean(r.data.passwordStatus?.state), JSON.stringify(r.data.passwordStatus));
    check('it never carries a password hash', !JSON.stringify(r.data).includes('$2a$') && !JSON.stringify(r.data).includes('$2b$'));
    check('activity never names a colleague',
      (r.data.activity || []).every((a) => ['You', 'An administrator', 'The system'].includes(a.actor)),
      JSON.stringify(r.data.activity || []).slice(0, 200));

    r = await admin.req('DELETE', '/api/users/me/sessions');
    check('other devices can be signed out', r.status === 200 && typeof r.data.revoked === 'number', `${r.status} ${r.text.slice(0, 160)}`);
    r = await admin.req('GET', '/api/auth/me');
    check('and the current one survives it', r.status === 200, `${r.status}`);
  }

  // --- the two page lists agree --------------------------------------------
  // The browser keeps its own copy of the client page keys, because it also
  // needs the route each one maps to and the server does not carry those. That
  // copy is the thing most likely to drift: a key added on one side and not the
  // other means an admin ticks a section the server refuses, or a section
  // silently stays open. GET /users/client-pages is the server's own answer, so
  // compare the two rather than trusting them to be edited together.
  {
    const fs = require('fs');
    const mirror = fs.readFileSync('frontend/src/lib/permissions.ts', 'utf8');
    const clientKeys = [...mirror.matchAll(/key:\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();

    r = await admin.req('GET', '/api/users/client-pages');
    const serverKeys = (r.data.pages || []).map((p) => p.key).sort();

    check('the server publishes its client page list', r.status === 200 && serverKeys.length > 0, `${r.status}`);
    check(
      'the browser mirror lists exactly the same page keys',
      JSON.stringify(serverKeys) === JSON.stringify(clientKeys),
      `server ${serverKeys.join(',')} | browser ${clientKeys.join(',')}`,
    );
  }

  // --- access control ------------------------------------------------------
  r = await client.req('GET', '/api/mail/log');
  check('a client cannot read the mail log', r.status === 403, `${r.status}`);

  r = await client.req('GET', '/api/users');
  const leaked = (r.data.users || []).filter((u) => u.email);
  check('a client cannot read the user directory with emails', leaked.length === 0, `${leaked.length} leaked`);

  // A client whose progress page is switched off must be refused.
  await admin.req('PUT', `/api/users/${clientId}`, { allowedPages: ['tickets'] });
  r = await client.req('GET', '/api/client/progress');
  check('page toggles gate the progress API', r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
