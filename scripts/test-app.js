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

  /* --- an address has to be an address ----------------------------------
     JSON has types, and every one of them used to reach the row. A body
     carrying {"email": true} was stored as the string "true" -- and because
     an address is how somebody signs in, that locked the account out of the
     product as well as out of its inbox, silently, until they next tried to
     log in. {"name": {}} became a client called "{}" on every screen and in
     every message. The self-service version of the same screen did not store
     rubbish; it raised a 500 trying to lowercase it.                      */
  {
    // Exhaustively at the rule itself, which costs no requests. The write
    // routes sit behind a credential rate limiter, and spending forty of its
    // forty attempts proving the same rule twelve times would starve the
    // fixtures the rest of this suite builds.
    const userFieldsLib = require('../utils/userFields');
    for (const [label, value] of [
      ['a boolean', true], ['a number', 42], ['an array', ['a@b.c']],
      ['an object', { a: 1 }], ['null', null], ['undefined', undefined],
      ['text that is not an address', 'not-an-address'],
      ['an address with a space', 'two words@example.com'],
      ['no domain dot', 'someone@localhost'],
      ['two at signs', 'a@b@c.com'], ['empty', ''], ['only spaces', '   '],
    ]) {
      check(`an email of ${label} is refused`, userFieldsLib.normalizeEmail(value) === null,
        JSON.stringify(userFieldsLib.normalizeEmail(value)));
    }
    for (const [label, value, want] of [
      ['a plain address', 'someone@example.com', 'someone@example.com'],
      ['mixed case', 'Someone@Example.COM', 'someone@example.com'],
      ['surrounding space', '  a@b.co  ', 'a@b.co'],
      ['a plus tag', 'a+tag@b.co', 'a+tag@b.co'],
      ['a long new TLD', 'a@b.marketing', 'a@b.marketing'],
    ]) {
      check(`a real address (${label}) survives`, userFieldsLib.normalizeEmail(value) === want,
        String(userFieldsLib.normalizeEmail(value)));
    }
    for (const [label, value] of [
      ['a number', 123], ['an object', {}], ['an array', []],
      ['only spaces', '   '], ['empty', ''], ['null', null],
    ]) {
      check(`a name of ${label} is refused`, userFieldsLib.normalizeName(value) === null);
    }
    check('a real name survives, with its spacing tidied',
      userFieldsLib.normalizeName('  Ada   Lovelace ') === 'Ada Lovelace');

    // And three requests to prove the routes actually apply it.
    const victim = (await admin.req('POST', '/api/users', {
      name: 'Shape Probe', email: 'shape.probe@example.com', role: 'client',
      password: 'ShapeProbe#1',
    })).data.user;
    check('a probe account is created', Boolean(victim?.id));

    r = await admin.req('PUT', `/api/users/${victim.id}`, { email: true });
    check('the admin editor refuses a non-address instead of storing "true"',
      r.status === 400, `${r.status} ${r.text.slice(0, 90)}`);

    const after = (await admin.req('GET', '/api/users')).data.users.find((u) => u.id === victim.id);
    check('so the account can still be signed into and reached',
      after.email === 'shape.probe@example.com' && after.name === 'Shape Probe',
      `${after.name} / ${after.email}`);

    // The self-service screen answers the same way rather than with a 500.
    r = await admin.req('PUT', '/api/users/me', { email: { nope: 1 } });
    check('the profile screen refuses one rather than crashing',
      r.status === 400, `${r.status} ${r.text.slice(0, 90)}`);

    await admin.req('DELETE', `/api/users/${victim.id}`);
  }

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

  // --- membership: the plan catalogue and what one client is on ------------
  {
    const { db } = require('../db/setup');
    const iso = (ms) => new Date(ms).toISOString();

    r = await client.req('GET', '/api/plans');
    check('a client can read the plan catalogue', r.status === 200, `${r.status}`);
    check('it offers exactly three plans', r.data.plans?.length === 3, `${r.data.plans?.length}`);
    check('highest plan first', r.data.plans?.[0]?.key === 'unlimited', r.data.plans?.[0]?.key);
    check('and the cheapest last', r.data.plans?.[2]?.key === 'basic', r.data.plans?.[2]?.key);
    check('prices are in USD and nothing else', r.data.currency === 'USD', r.data.currency);
    check('the yearly price matches the playbook',
      r.data.plans?.[0]?.prices?.find((p) => p.months === 12)?.total === 278.40,
      JSON.stringify(r.data.plans?.[0]?.prices?.find((p) => p.months === 12)));
    check('manual payment is the default mode', r.data.paymentMode === 'manual', r.data.paymentMode);

    // Signed out, a price list is still not something this app answers to.
    r = await makeClient(base).req('GET', '/api/plans');
    check('the catalogue needs a session', r.status === 401, `${r.status}`);

    // --- the grandfather clause -------------------------------------------
    // Every client in the workspace is in this position on the morning this
    // ships, and the one thing that must not happen is their dashboard
    // closing. They are asked, not cut off.
    r = await client.req('GET', '/api/membership/status');
    check('a client with no plan can read their membership', r.status === 200, `${r.status}`);
    check('they are asked to choose one', r.data.membership?.needsPlan === true);
    check('and nothing is gated for them yet', r.data.membership?.grandfathered === true);
    check('so they still read the dashboard as Unlimited',
      r.data.membership?.effectivePlanKey === 'unlimited', r.data.membership?.effectivePlanKey);
    check('with no locked panels', r.data.membership?.locked?.length === 0,
      String(r.data.membership?.locked?.length));
    check('but no plan they are paying for', r.data.membership?.planKey === null,
      JSON.stringify(r.data.membership?.planKey));

    // Membership is deliberately NOT behind the Billing page toggle: the
    // "choose a plan" banner lives on the dashboard, which everybody keeps,
    // and an admin hiding Billing must not 403 the banner.
    await admin.req('PUT', `/api/users/${clientId}`, { allowedPages: ['tickets'] });
    r = await client.req('GET', '/api/membership/status');
    check('switching Billing off does not hide their own plan', r.status === 200, `${r.status}`);
    await admin.req('PUT', `/api/users/${clientId}`, {
      allowedPages: ['tickets', 'progress', 'projects', 'billing'],
    });

    // --- choosing a plan takes nothing away -------------------------------
    const pending = await db.insert('subscriptions', {
      clientId, planKey: 'managed', period: 6, amountUsd: 96.90,
      status: 'pending_payment', createdAt: iso(Date.now()),
    });
    r = await client.req('GET', '/api/membership/status');
    check('an unpaid plan is reported as awaiting payment',
      r.data.membership?.awaitingPayment === true);
    check('it unlocks nothing on its own', r.data.membership?.planKey === null,
      JSON.stringify(r.data.membership?.planKey));
    // The whole point: saying yes must not cost them the dashboard they had
    // five minutes ago, in the exact window they might change their mind.
    check('but choosing it does not take their dashboard away',
      r.data.membership?.effectivePlanKey === 'unlimited', r.data.membership?.effectivePlanKey);
    check('and the amount they were quoted is reported',
      r.data.membership?.subscription?.amountUsd === 96.90,
      String(r.data.membership?.subscription?.amountUsd));

    // --- paid ---------------------------------------------------------------
    await db.update('subscriptions', pending.id, {
      status: 'active', markedPaidAt: iso(Date.now()), markedPaidBy: 'admin',
      startedAt: iso(Date.now()), renewsAt: iso(Date.now() + 180 * 86400000),
    });
    r = await client.req('GET', '/api/membership/status');
    check('a paid plan is the one that governs', r.data.membership?.planKey === 'managed',
      r.data.membership?.planKey);
    check('they are no longer asked to choose', r.data.membership?.needsPlan === false);
    check('the grandfather clause stops applying', r.data.membership?.grandfathered === false);
    check('Managed unlocks the plugin updates', r.data.membership?.entitlements?.includes('software_plugin_updates'));
    check('and the monthly health check', r.data.membership?.entitlements?.includes('monthly_health_check'));
    check('but not daily backups', !r.data.membership?.entitlements?.includes('daily_backups'));
    check('nor the priority SLA', !r.data.membership?.entitlements?.includes('priority_sla'));
    check('so backups are offered as a locked panel',
      r.data.membership?.locked?.some((l) => l.key === 'daily_backups'));
    check('they are pointed at Unlimited', r.data.membership?.upgradeTo === 'unlimited',
      r.data.membership?.upgradeTo);
    check('the allowance is two a month', r.data.membership?.usage?.included === 2,
      String(r.data.membership?.usage?.included));
    check('none of it used yet', r.data.membership?.usage?.used === 0);
    check('so two remain', r.data.membership?.usage?.remaining === 2);
    check('and it has a reset date', Boolean(r.data.membership?.usage?.resetsAt));

    // --- a card that failed keeps the lights on ---------------------------
    await db.update('subscriptions', pending.id, { status: 'past_due' });
    r = await client.req('GET', '/api/membership/status');
    check('a failed payment is flagged', r.data.membership?.pastDue === true);
    check('but does not switch their plan off',
      r.data.membership?.effectivePlanKey === 'managed', r.data.membership?.effectivePlanKey);

    // --- cancellation runs to the end of the period -----------------------
    await db.update('subscriptions', pending.id, {
      status: 'cancelled', cancelledAt: iso(Date.now()),
      renewsAt: iso(Date.now() + 10 * 86400000),
    });
    r = await client.req('GET', '/api/membership/status');
    check('a cancelled plan says when it ends', Boolean(r.data.membership?.endingAt));
    check('and keeps working until then',
      r.data.membership?.effectivePlanKey === 'managed', r.data.membership?.effectivePlanKey);

    await db.update('subscriptions', pending.id, { renewsAt: iso(Date.now() - 86400000) });
    r = await client.req('GET', '/api/membership/status');
    check('once the period has run out it grants nothing',
      r.data.membership?.effectivePlanKey === null, r.data.membership?.effectivePlanKey);

    // --- one client never reads another -----------------------------------
    const other = await admin.req('POST', '/api/users', {
      name: 'Other Client', email: 'other.member@example.com', role: 'client',
      password: 'OtherPass#1', company: 'Other Co',
    });
    const otherId = other.data.user?.id;
    await db.insert('subscriptions', {
      clientId: otherId, planKey: 'unlimited', period: 1, amountUsd: 29,
      status: 'active', markedPaidAt: iso(Date.now()), startedAt: iso(Date.now()),
      createdAt: iso(Date.now()),
    });
    // The clientId parameter is read for staff and ignored for everybody else,
    // so this is not "asked and refused" -- it is unreachable.
    r = await client.req('GET', `/api/membership/status?clientId=${otherId}`);
    check('a client naming another client still gets their own membership',
      r.status === 200 && r.data.membership?.clientId === clientId,
      `${r.status} ${JSON.stringify(r.data.membership?.clientId)}`);
    check('and never the other one\'s plan', r.data.membership?.planKey !== 'unlimited',
      JSON.stringify(r.data.membership?.planKey));

    r = await admin.req('GET', `/api/membership/status?clientId=${otherId}`);
    check('an admin can read a named client', r.data.membership?.planKey === 'unlimited',
      r.data.membership?.planKey);

    // The funnel is staff-only: a client reading back how many upgrade
    // prompts they were shown would be unsettling rather than useful.
    r = await client.req('GET', '/api/membership/events');
    check('the funnel is not readable by a client', r.status === 403, `${r.status}`);
    r = await admin.req('GET', '/api/membership/events');
    check('but an admin can read it', r.status === 200, `${r.status}`);

    r = await client.req('GET', '/api/membership/history');
    check('a client can read their own plan history', r.status === 200, `${r.status}`);
    check('which holds the plan they had', r.data.subscriptions?.some((s) => s.planKey === 'managed'));
    check('and nobody else\'s', r.data.subscriptions?.every((s) => s.clientId === clientId));

    // Leave the account as the rest of the suite expects to find it.
    await db.remove('subscriptions', pending.id);
    for (const s of await db.filter('subscriptions', (s) => s.clientId === clientId)) {
      await db.remove('subscriptions', s.id);
    }
  }

  // --- membership: choosing a plan -----------------------------------------
  {
    const { db } = require('../db/setup');
    const plans = require('../lib/plans');
    const iso = (ms) => new Date(ms).toISOString();

    // --- what it would cost -----------------------------------------------
    r = await client.req('GET', '/api/membership/quote?planKey=unlimited&period=12');
    check('a client can price a plan before committing', r.status === 200, `${r.status}`);
    check('the yearly price is the playbook figure', r.data.quote?.listAmountUsd === 278.40,
      String(r.data.quote?.listAmountUsd));
    check('a first purchase is priced as new', r.data.quote?.kind === 'new', r.data.quote?.kind);
    check('with nothing to credit', r.data.quote?.creditUsd === 0, String(r.data.quote?.creditUsd));

    r = await client.req('GET', '/api/membership/quote?planKey=enterprise&period=12');
    check('an invented plan is refused', r.status === 400, `${r.status}`);
    r = await client.req('GET', '/api/membership/quote?planKey=unlimited&period=9');
    check('an invented period is refused', r.status === 400, `${r.status}`);

    // --- choosing ----------------------------------------------------------
    r = await client.req('POST', '/api/membership/select', { planKey: 'managed', period: 6 });
    check('a client can choose a plan', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
    check('it is created awaiting payment', r.data.subscription?.status === 'pending_payment',
      r.data.subscription?.status);
    check('priced from the config, not the request', r.data.subscription?.amountUsd === 96.90,
      String(r.data.subscription?.amountUsd));
    const firstChoiceId = r.data.subscription?.id;

    // The line the whole feature rests on.
    r = await client.req('GET', '/api/membership/status');
    check('choosing unlocks nothing on its own', r.data.membership?.planKey === null,
      JSON.stringify(r.data.membership?.planKey));
    check('and the pending choice is reported separately',
      r.data.membership?.pendingSubscription?.planKey === 'managed',
      r.data.membership?.pendingSubscription?.planKey);

    // The team has to hear about it, or a sale dies in an inbox.
    const alerts = await db.filter('notifications', (n) => n.type === 'billing'
      && String(n.message).includes('chose Managed'));
    check('the team is told to send payment details', alerts.length > 0, String(alerts.length));

    const chose = await db.filter('membership_events', (e) => e.type === 'plan_selected'
      && e.clientId === clientId);
    check('the choice is logged for the funnel', chose.length === 1, String(chose.length));
    check('with what was chosen', chose[0]?.metadata?.planKey === 'managed',
      JSON.stringify(chose[0]?.metadata));

    // --- pressing the button twice ----------------------------------------
    r = await client.req('POST', '/api/membership/select', { planKey: 'managed', period: 6 });
    check('choosing the same plan again is answered, not duplicated',
      r.status === 200 && r.data.alreadyChosen === true, `${r.status}`);
    check('and it is the same subscription', r.data.subscription?.id === firstChoiceId);
    let pendingRows = await db.filter('subscriptions', (s) => s.clientId === clientId
      && s.status === 'pending_payment');
    check('so there is still only one thing for an admin to chase', pendingRows.length === 1,
      String(pendingRows.length));

    // --- changing their mind before paying --------------------------------
    r = await client.req('POST', '/api/membership/select', { planKey: 'unlimited', period: 1 });
    check('a different choice replaces the first', r.status === 201, `${r.status}`);
    pendingRows = await db.filter('subscriptions', (s) => s.clientId === clientId
      && s.status === 'pending_payment');
    check('leaving one pending choice, not two', pendingRows.length === 1, String(pendingRows.length));
    check('and it is the newer one', pendingRows[0]?.planKey === 'unlimited', pendingRows[0]?.planKey);

    for (const s of await db.filter('subscriptions', (s) => s.clientId === clientId)) {
      await db.remove('subscriptions', s.id);
    }

    // --- upgrading part way through a period you paid for -----------------
    const start = Date.now() - 90 * 86400000;
    await db.insert('subscriptions', {
      clientId, planKey: 'managed', period: 6, amountUsd: 96.90, status: 'active',
      markedPaidAt: iso(start), startedAt: iso(start),
      renewsAt: plans.renewalDate(iso(start), 6).toISOString(), createdAt: iso(start),
    });

    r = await client.req('GET', '/api/membership/quote?planKey=unlimited&period=6');
    check('an upgrade is recognised as one', r.data.quote?.kind === 'upgrade', r.data.quote?.kind);
    check('the unused days are credited', r.data.quote?.creditUsd > 40 && r.data.quote?.creditUsd < 60,
      String(r.data.quote?.creditUsd));
    check('so they pay the difference, not the full price',
      r.data.quote?.amountUsd === plans.money(147.90 - r.data.quote.creditUsd),
      `${r.data.quote?.amountUsd} vs ${147.90 - r.data.quote?.creditUsd}`);

    // --- downgrading is scheduled, never refunded -------------------------
    // Crediting ~$49 of Managed against $9 of Basic would hand out a free
    // month and quietly burn the other $40. The cheaper plan starts when the
    // paid period ends instead.
    r = await client.req('GET', '/api/membership/quote?planKey=basic&period=1');
    check('a downgrade is recognised as one', r.data.quote?.kind === 'downgrade', r.data.quote?.kind);
    check('nothing is credited against it', r.data.quote?.creditUsd === 0,
      String(r.data.quote?.creditUsd));
    check('nothing is due today', r.data.quote?.dueNowUsd === 0, String(r.data.quote?.dueNowUsd));
    check('it starts when the paid period ends', Boolean(r.data.quote?.startsAt));

    // --- an upgrade does not cancel what they already paid for ------------
    r = await client.req('POST', '/api/membership/select', { planKey: 'unlimited', period: 6 });
    check('an upgrade can be chosen', r.status === 201, `${r.status}`);
    r = await client.req('GET', '/api/membership/status');
    check('the plan they paid for keeps running', r.data.membership?.planKey === 'managed',
      r.data.membership?.planKey);
    check('and still unlocks exactly what Managed unlocks',
      r.data.membership?.entitlements?.includes('monthly_health_check')
      && !r.data.membership?.entitlements?.includes('daily_backups'));
    check('while the upgrade waits on payment',
      r.data.membership?.pendingSubscription?.planKey === 'unlimited',
      r.data.membership?.pendingSubscription?.planKey);
    check('with the credit recorded on it', r.data.membership?.pendingSubscription?.creditUsd > 0,
      String(r.data.membership?.pendingSubscription?.creditUsd));

    // --- one client never chooses for another -----------------------------
    const victim = (await db.filter('users', (u) => u.role === 'client' && u.id !== clientId))[0];
    if (victim) {
      const before = (await db.filter('subscriptions', (s) => s.clientId === victim.id)).length;
      r = await client.req('POST', '/api/membership/select', {
        planKey: 'basic', period: 1, clientId: victim.id,
      });
      const after = (await db.filter('subscriptions', (s) => s.clientId === victim.id)).length;
      check('a client naming another client cannot put a plan on them', after === before,
        `${before} -> ${after}`);
    }

    // --- the modal is shown once ------------------------------------------
    r = await client.req('POST', '/api/membership/modal-seen', {});
    check('the modal can be marked seen', r.status === 200, `${r.status}`);
    let me = await db.find('users', clientId);
    const seenAt = me.plansModalSeenAt;
    check('and the moment is recorded', Boolean(seenAt));
    r = await client.req('POST', '/api/membership/modal-seen', {});
    me = await db.find('users', clientId);
    check('a second call does not move the timestamp', me.plansModalSeenAt === seenAt,
      `${seenAt} -> ${me.plansModalSeenAt}`);
    const shown = await db.filter('membership_events', (e) => e.type === 'plans_modal_shown'
      && e.clientId === clientId);
    check('so the funnel counts one showing, not two', shown.length === 1, String(shown.length));

    // Leave the account as the rest of the suite expects to find it.
    for (const s of await db.filter('subscriptions', (s) => s.clientId === clientId)) {
      await db.remove('subscriptions', s.id);
    }
    await db.update('users', clientId, { plansModalSeenAt: null });
  }

  // --- membership: confirming the money ------------------------------------
  {
    const { db } = require('../db/setup');
    const plans = require('../lib/plans');
    const subscriptionsUtil = require('../utils/subscriptions');
    const iso = (ms) => new Date(ms).toISOString();

    r = await client.req('POST', '/api/membership/select', { planKey: 'managed', period: 6 });
    const subId = r.data.subscription?.id;
    check('a plan is waiting on payment', r.data.subscription?.status === 'pending_payment');

    // --- who may confirm a payment ----------------------------------------
    r = await client.req('POST', `/api/membership/${subId}/mark-paid`, {});
    check('a client cannot mark their own plan paid', r.status === 403, `${r.status}`);
    let still = await db.find('subscriptions', subId);
    check('and nothing moved when they tried', still.status === 'pending_payment', still.status);

    r = await admin.req('GET', '/api/membership/pending');
    check('an admin sees who is waiting', r.status === 200 && r.data.pending?.length >= 1,
      `${r.status} ${r.data.pending?.length}`);
    const waiting = r.data.pending?.find((p) => p.id === subId);
    check('with the name to send details to', Boolean(waiting?.clientEmail));
    check('and the amount to ask for', waiting?.amountUsd === 96.90, String(waiting?.amountUsd));

    r = await client.req('GET', '/api/membership/pending');
    check('a client cannot read the payment queue', r.status === 403, `${r.status}`);

    // --- confirming it -----------------------------------------------------
    r = await admin.req('POST', `/api/membership/${subId}/mark-paid`, {});
    check('an admin can confirm the payment', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    check('the plan starts', r.data.subscription?.status === 'active', r.data.subscription?.status);
    check('and it is a first purchase, not an upgrade', r.data.kind === 'new', r.data.kind);
    check('a renewal date is set', Boolean(r.data.subscription?.renewsAt));

    const renewsAt = r.data.subscription.renewsAt;
    const startedAt = r.data.subscription.startedAt;
    check('six months out from the day it started',
      renewsAt.slice(0, 10) === plans.renewalDate(startedAt, 6).toISOString().slice(0, 10),
      `${startedAt} -> ${renewsAt}`);

    // --- now, and only now, the perks ------------------------------------
    r = await client.req('GET', '/api/membership/status');
    check('the client is on the plan they paid for', r.data.membership?.planKey === 'managed',
      r.data.membership?.planKey);
    check('and is no longer asked to choose', r.data.membership?.needsPlan === false);
    check('the grandfather clause has stopped applying',
      r.data.membership?.grandfathered === false);
    check('Managed perks are unlocked',
      r.data.membership?.entitlements?.includes('monthly_health_check'));
    check('Unlimited ones are not',
      !r.data.membership?.entitlements?.includes('daily_backups'));
    check('the unlock moment has not been shown yet',
      r.data.membership?.subscription?.unlockSeenAt === null,
      JSON.stringify(r.data.membership?.subscription?.unlockSeenAt));

    const told = await db.filter('notifications', (n) => n.userId === clientId
      && String(n.message).includes('Payment confirmed'));
    check('the client is told their plan started', told.length === 1, String(told.length));

    const confirmed = await db.filter('membership_events', (e) => e.type === 'payment_confirmed'
      && e.clientId === clientId);
    check('the confirmation is logged for the funnel', confirmed.length === 1, String(confirmed.length));

    // --- a double click must not move their renewal date ------------------
    r = await admin.req('POST', `/api/membership/${subId}/mark-paid`, {});
    check('confirming twice is answered, not replayed', r.status === 200 && r.data.alreadyActive === true,
      `${r.status}`);
    still = await db.find('subscriptions', subId);
    check('and the renewal date did not move a month into the future',
      still.renewsAt === renewsAt, `${renewsAt} -> ${still.renewsAt}`);

    // --- upgrading, and what happens to the plan being replaced -----------
    r = await client.req('POST', '/api/membership/select', { planKey: 'unlimited', period: 6 });
    const upgradeId = r.data.subscription?.id;
    check('an upgrade is credited for the days already paid for',
      r.data.subscription?.creditUsd > 0, String(r.data.subscription?.creditUsd));

    r = await admin.req('POST', `/api/membership/${upgradeId}/mark-paid`, {});
    check('the upgrade is confirmed as an upgrade', r.data.kind === 'upgrade', r.data.kind);
    check('and the plan it replaced is named', r.data.superseded?.planKey === 'managed',
      r.data.superseded?.planKey);

    const actives = await db.filter('subscriptions', (s) => s.clientId === clientId
      && s.status === 'active');
    // The partial unique index in db/setup.js is the backstop; this is the
    // code that is supposed to make it never fire.
    check('a client is on exactly one plan, never two', actives.length === 1, String(actives.length));
    check('and it is the one they just upgraded to', actives[0]?.planKey === 'unlimited',
      actives[0]?.planKey);

    const superseded = await db.find('subscriptions', subId);
    check('the replaced plan is expired, not cancelled', superseded.status === 'expired',
      superseded.status);

    r = await client.req('GET', '/api/membership/status');
    check('every Unlimited perk is now unlocked', r.data.membership?.entitlements?.length === 15,
      String(r.data.membership?.entitlements?.length));
    check('and nothing is locked any more', r.data.membership?.locked?.length === 0);

    const upgradedEvents = await db.filter('membership_events', (e) => e.type === 'upgraded'
      && e.clientId === clientId);
    check('the upgrade is logged so churn after it can be measured',
      upgradedEvents.length === 1, String(upgradedEvents.length));

    // --- the unlock moment, and the email that goes with it ---------------
    {
      // Confirming the Managed plan above should have produced exactly one of
      // each, and the upgrade to Unlimited a second of each.
      r = await client.req('GET', '/api/membership/status');
      const unlock = r.data.membership?.unlock;
      check('the unlock moment is owed after an upgrade', Boolean(unlock));
      check('it names the plan they moved to', unlock?.planName === 'Unlimited', unlock?.planName);
      check('and the one they came from', unlock?.fromPlanName === 'Managed', unlock?.fromPlanName);
      check('it knows this was a step up', unlock?.isUpgrade === true);

      const keys = (unlock?.gained || []).map((g) => g.key);
      // Only the difference. Reading somebody their whole plan after an
      // upgrade makes the step they just paid for look like nothing changed.
      check('it lists what is new', keys.includes('daily_backups') && keys.includes('priority_sla'));
      check('and not what they already had', !keys.includes('hosting')
        && !keys.includes('monthly_health_check'), keys.join(','));
      check('every perk with a panel points at it',
        (unlock?.gained || []).filter((g) => g.surface).every((g) => g.surface.to.startsWith('/portal')));
      check('and Unlimited can raise a request', unlock?.canRaiseRequest === true);

      // --- shown once -----------------------------------------------------
      r = await client.req('POST', '/api/membership/unlock-seen', {});
      check('the unlock moment can be marked seen', r.status === 200, `${r.status}`);
      r = await client.req('GET', '/api/membership/status');
      check('and is not owed twice', r.data.membership?.unlock === null,
        JSON.stringify(r.data.membership?.unlock));

      // The stamp is on the subscription, not the account, so an upgrade
      // later is a second unlock rather than one swallowed by a flag.
      const activeNow = (await db.filter('subscriptions', (s) => s.clientId === clientId
        && s.status === 'active'))[0];
      check('the stamp sits on the subscription', Boolean(activeNow?.unlockSeenAt));

      // --- the confirmation email ----------------------------------------
      const confirmations = (await db.all('email_log'))
        .filter((e) => e.template === 'plan_confirmed');
      check('a confirmation went out for each plan that started',
        confirmations.length === 2, String(confirmations.length));
      check('addressed to the client',
        confirmations.every((e) => String(e.toEmails).includes('qa.client@example.com')),
        confirmations.map((e) => e.toEmails).join(' '));

      // Sent once per subscription. A client reading the same confirmation
      // twice has a reason to wonder whether they were charged twice.
      const stamped = await db.filter('subscriptions', (s) => s.clientId === clientId
        && s.confirmationSentAt);
      check('each one is stamped so it cannot send again', stamped.length === 2,
        String(stamped.length));

      const resent = await subscriptionsUtil.sendConfirmation(activeNow);
      check('asking again declines rather than sending a second', resent === false);
      check('and no second message was queued',
        (await db.all('email_log')).filter((e) => e.template === 'plan_confirmed').length === 2);

      // A client whose plan has not been confirmed is owed nothing.
      r = await admin.req('GET', `/api/membership/status?clientId=u-client`);
      check('a client with no active plan is owed no unlock moment',
        r.data.membership?.unlock === null, JSON.stringify(r.data.membership?.unlock));
    }

    // --- an admin nobody has vouched for yet ------------------------------
    // Confirming a payment starts a billing period, retires the plan they were
    // on and unlocks everything, on the strength of a bank notification
    // somebody read out. A five-minute-old admin account doing that alone is
    // exactly what the second-signature queue is for.
    {
      const rookie = makeClient(base);
      let a = await admin.req('POST', '/api/users', {
        name: 'Rookie Admin', email: 'rookie.admin@ethixweb.local', role: 'admin',
        password: 'RookieAdmin#1',
      });
      check('a rookie admin can be appointed', a.status === 201, `${a.status}`);
      a = await signIn(rookie, 'rookie.admin@ethixweb.local', 'RookieAdmin#1');
      check('and can sign in', a.status === 200, `${a.status}`);

      // A renewal, not a downgrade. A downgrade is deliberately *not* payable
      // on the day it is chosen -- it is recorded as `scheduled` and starts
      // when the period already paid for runs out -- so it would never reach
      // the signature queue this block exists to test. The gate being checked
      // here is the one on confirming money, and a renewal is money.
      a = await client.req('POST', '/api/membership/select', { planKey: 'unlimited', period: 3 });
      const rookieTarget = a.data.subscription?.id;
      check('a renewal is payable now, so there is something to confirm',
        a.data.subscription?.status === 'pending_payment', a.data.subscription?.status);

      a = await rookie.req('POST', `/api/membership/${rookieTarget}/mark-paid`, {});
      check('a rookie admin cannot confirm a payment alone', a.status === 202, `${a.status}`);
      check('and is told nothing has changed yet', a.data.pendingApproval === true);
      check('the proposal says what it would do in plain words',
        /Confirm \$78\.30 USD from .* and start their Unlimited plan/.test(a.data.request?.summary || ''),
        a.data.request?.summary);

      const held = await db.find('subscriptions', rookieTarget);
      check('the plan did NOT start while it waits for a signature',
        held.status === 'pending_payment', held.status);
      let m = (await client.req('GET', '/api/membership/status')).data.membership;
      check('and the client is still on the plan they had', m.planKey === 'unlimited', m.planKey);
      check('no money is counted while it waits', held.markedPaidAt == null,
        String(held.markedPaidAt));

      // A second admin signs it off, and only then does the money count.
      a = await admin.req('POST', `/api/approvals/${a.data.request.id}/approve`, {});
      check('a trusted admin can sign it off', a.status === 200, `${a.status} ${a.text.slice(0, 200)}`);

      const released = await db.find('subscriptions', rookieTarget);
      check('and the plan starts only then', released.status === 'active', released.status);
      check('the money is counted at that point, not before',
        Boolean(released.markedPaidAt));
      m = (await client.req('GET', '/api/membership/status')).data.membership;
      check('the client is moved onto it', m.planKey === 'unlimited', m.planKey);
      check('with the new period running', m.subscription?.id === rookieTarget,
        String(m.subscription?.id));

      const stillOne = await db.filter('subscriptions', (s) => s.clientId === clientId
        && s.status === 'active');
      check('and they are still on exactly one plan', stillOne.length === 1, String(stillOne.length));
    }

    // --- a downgrade is scheduled, and nobody can collect for it yet ------
    // The client is told "your current plan runs until <date>, and the cheaper
    // one starts after that. There is nothing to pay now." Confirming it today
    // would bill them for a plan they were told they did not owe for, and cut
    // short the period of the dearer one they had already paid for.
    {
      let d = await client.req('POST', '/api/membership/select', { planKey: 'basic', period: 1 });
      check('a client may choose a cheaper plan', d.status === 201, `${d.status}`);
      const scheduled = d.data.subscription;
      check('it is scheduled rather than awaiting payment',
        scheduled?.status === 'scheduled', scheduled?.status);
      check('and it says when it begins', Boolean(scheduled?.startsAt), String(scheduled?.startsAt));

      d = await admin.req('GET', '/api/membership/pending');
      check('it is not on the admin list of payments to collect',
        !(d.data.pending || []).some((p) => p.id === scheduled.id));

      d = await admin.req('POST', `/api/membership/${scheduled.id}/mark-paid`, {});
      check('EXPLOIT BLOCKED: an admin cannot start it early', d.status === 409, `${d.status}`);
      check('and is told when it does start', /starts on/.test(d.data.error || ''), d.data.error);

      const m = (await client.req('GET', '/api/membership/status')).data.membership;
      check('the client keeps the plan they paid for', m.planKey === 'unlimited', m.planKey);
      check('with every perk of it still unlocked', m.entitlements.length === 15,
        String(m.entitlements.length));
      check('the scheduled change is reported on its own',
        m.scheduledSubscription?.planKey === 'basic', String(m.scheduledSubscription?.planKey));
      check('and is not reported as a payment we are waiting on',
        m.awaitingPayment === false, String(m.awaitingPayment));
    }

    // --- nothing to confirm -----------------------------------------------
    r = await admin.req('POST', `/api/membership/${subId}/mark-paid`, {});
    check('an expired plan cannot be revived by confirming it', r.status === 409, `${r.status}`);
    r = await admin.req('POST', '/api/membership/does-not-exist/mark-paid', {});
    check('an unknown subscription is a 404, not a crash', r.status === 404, `${r.status}`);

    // Leave the account as the rest of the suite expects to find it.
    for (const s of await db.filter('subscriptions', (s) => s.clientId === clientId)) {
      await db.remove('subscriptions', s.id);
    }
    void iso;
  }

  // --- membership: the legal pages ------------------------------------------
  {
    const messages = require('../utils/emailMessages');

    // They are React routes, so the server answers them with the app shell and
    // the router takes it from there. What matters here is that they are not
    // behind the auth guard: every email footer links to them, and somebody
    // deciding whether to buy is as likely to be signed out as in.
    for (const path of ['/terms', '/privacy']) {
      const anon = makeClient(base);
      const res = await anon.req('GET', path);
      check(`${path} is readable without signing in`, res.status === 200, `${res.status}`);
      check(`${path} serves the app rather than a redirect`,
        typeof res.text === 'string' && res.text.includes('<div id="root">'),
        res.text.slice(0, 80));
    }

    // And the links that point at them actually say those paths, so a rename
    // here would fail the suite rather than quietly producing dead links in
    // every email we send.
    for (const key of ['welcome_with_plans', 'plan_confirmed', 'renewal_reminder']) {
      const preview = messages.renderPreview(key);
      check(`${key} links to the terms`, preview.html.includes('/terms'), key);
      check(`${key} links to the privacy policy`, preview.html.includes('/privacy'), key);
    }
  }

  // --- membership: leaving ---------------------------------------------------
  {
    const { db } = require('../db/setup');
    const plans = require('../lib/plans');
    const subs = require('../utils/subscriptions');
    const iso = (ms) => new Date(ms).toISOString();
    const DAY = 86400000;

    const onPlan = async (planKey, period, { renewsInDays = 90 } = {}) => {
      for (const s of await db.filter('subscriptions', (s) => s.clientId === clientId)) {
        await db.remove('subscriptions', s.id);
      }
      const start = Date.now() - 30 * DAY;
      return db.insert('subscriptions', {
        clientId, planKey, period, amountUsd: plans.amountFor(planKey, period),
        status: 'active', markedPaidAt: iso(start), startedAt: iso(start),
        renewsAt: iso(Date.now() + renewsInDays * DAY),
        confirmationSentAt: iso(start), unlockSeenAt: iso(start), createdAt: iso(start),
      });
    };

    // --- cancelling ---------------------------------------------------------
    await onPlan('unlimited', 12);
    r = await client.req('POST', '/api/membership/cancel', { reason: 'Too expensive' });
    check('a client can cancel their own plan', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    check('and it is recorded as cancelled', r.data.subscription?.status === 'cancelled',
      r.data.subscription?.status);
    check('with the reason they gave', r.data.subscription?.cancelReason === 'Too expensive',
      r.data.subscription?.cancelReason);

    // The promise the playbook makes: hosting runs to the end of the period
    // they paid for. Switching anything off today would break it.
    r = await client.req('GET', '/api/membership/status');
    check('nothing is switched off today',
      r.data.membership?.effectivePlanKey === 'unlimited', r.data.membership?.effectivePlanKey);
    check('every perk still works', r.data.membership?.entitlements?.length === 15,
      String(r.data.membership?.entitlements?.length));
    check('and the client is told when it ends', Boolean(r.data.membership?.endingAt));

    const told = await db.filter('notifications', (n) => n.type === 'billing'
      && /cancelled their Unlimited plan/.test(String(n.message)));
    check('the team hears about it', told.length > 0, String(told.length));
    const cancelLogged = await db.filter('membership_events', (e) => e.type === 'cancelled'
      && e.clientId === clientId);
    check('and it is logged so churn can be measured', cancelLogged.length === 1,
      String(cancelLogged.length));

    // --- a lapsed plan grants nothing --------------------------------------
    {
      const current = (await db.filter('subscriptions', (s) => s.clientId === clientId
        && s.status === 'cancelled'))[0];
      await db.update('subscriptions', current.id, { renewsAt: iso(Date.now() - DAY) });
      r = await client.req('GET', '/api/membership/status');
      check('once the paid period runs out it grants nothing',
        r.data.membership?.effectivePlanKey === null, r.data.membership?.effectivePlanKey);
    }

    // --- cancelling drops a pending upgrade too ----------------------------
    await onPlan('managed', 6);
    await client.req('POST', '/api/membership/select', { planKey: 'unlimited', period: 6 });
    r = await client.req('POST', '/api/membership/cancel', {});
    check('cancelling is allowed with no reason given', r.status === 200, `${r.status}`);
    const stillPending = await db.filter('subscriptions', (s) => s.clientId === clientId
      && s.status === 'pending_payment');
    // Leaving one behind would put somebody who is leaving on an admin's list
    // of people to chase for money.
    check('a pending upgrade does not survive the cancellation', stillPending.length === 0,
      String(stillPending.length));

    // --- the website files --------------------------------------------------
    r = await client.req('POST', '/api/membership/handover', {});
    check('a leaving client can ask for their website files', r.status === 200, `${r.status}`);
    check('and the moment is recorded', Boolean(r.data.requestedAt));
    r = await client.req('POST', '/api/membership/handover', {});
    check('asking twice does not raise it twice', r.data.alreadyRequested === true);
    const handovers = await db.filter('membership_events', (e) => e.type === 'handover_requested'
      && e.clientId === clientId);
    check('so the team is told once', handovers.length === 1, String(handovers.length));

    // --- nothing to cancel ---------------------------------------------------
    for (const s of await db.filter('subscriptions', (s) => s.clientId === clientId)) {
      await db.remove('subscriptions', s.id);
    }
    r = await client.req('POST', '/api/membership/cancel', {});
    check('cancelling with no plan is refused cleanly', r.status === 409, `${r.status}`);

    // --- one client never cancels another ----------------------------------
    {
      const victim = (await db.filter('users', (u) => u.role === 'client' && u.id !== clientId))[0];
      if (victim) {
        const theirs = await db.insert('subscriptions', {
          clientId: victim.id, planKey: 'managed', period: 1, amountUsd: 19,
          status: 'active', markedPaidAt: iso(Date.now()), startedAt: iso(Date.now()),
          renewsAt: iso(Date.now() + 30 * DAY), createdAt: iso(Date.now()),
        });
        await client.req('POST', '/api/membership/cancel', { clientId: victim.id });
        const after = await db.find('subscriptions', theirs.id);
        check('a client naming another client cannot cancel their plan',
          after.status === 'active', after.status);
        await db.remove('subscriptions', theirs.id);
      }
    }

    // --- the renewal reminder ------------------------------------------------
    {
      // Six days out, on a twelve month plan: inside the window.
      const sub = await onPlan('unlimited', 12, { renewsInDays: 6 });
      const sent = await subs.sendRenewalReminders();
      check('a multi-month plan renewing in a week is reminded', sent === 1, String(sent));

      const mailed = (await db.all('email_log')).filter((e) => e.template === 'renewal_reminder');
      check('the reminder was addressed to the client',
        mailed.some((e) => String(e.toEmails).includes('qa.client@example.com')));

      const after = await db.find('subscriptions', sub.id);
      check('and stamped so it cannot send again', Boolean(after.renewalReminderSentAt));
      check('a second sweep sends nothing', (await subs.sendRenewalReminders()) === 0);

      // A monthly plan is its own reminder; mailing one every four weeks is
      // nagging, so it is out of scope by period rather than by chance.
      await onPlan('managed', 1, { renewsInDays: 6 });
      check('a monthly plan is never reminded', (await subs.sendRenewalReminders()) === 0);

      // And a renewal still months away is not due yet.
      await onPlan('unlimited', 12, { renewsInDays: 60 });
      check('and neither is one two months out', (await subs.sendRenewalReminders()) === 0);
    }

    for (const s of await db.filter('subscriptions', (s) => s.clientId === clientId)) {
      await db.remove('subscriptions', s.id);
    }
  }

  // --- membership: when we are allowed to ask -------------------------------
  {
    const { db } = require('../db/setup');
    const plans = require('../lib/plans');
    const upsell = require('../utils/upsell');
    const iso = (ms) => new Date(ms).toISOString();
    const DAY = 86400000;

    /** Put the client on a plan that started long enough ago to be askable. */
    const onPlan = async (planKey, { startedDaysAgo = 60 } = {}) => {
      for (const s of await db.filter('subscriptions', (s) => s.clientId === clientId)) {
        await db.remove('subscriptions', s.id);
      }
      for (const e of await db.filter('membership_events', (e) => e.clientId === clientId)) {
        await db.remove('membership_events', e.id);
      }
      await db.update('users', clientId, {
        upsellDismissStreak: 0, upsellSnoozedUntil: null,
        upsellLastShownAt: null, upsellLastMessage: null,
      });
      const start = Date.now() - startedDaysAgo * DAY;
      return db.insert('subscriptions', {
        clientId, planKey, period: 1, amountUsd: plans.amountFor(planKey, 1),
        status: 'active', markedPaidAt: iso(start), startedAt: iso(start),
        renewsAt: iso(Date.now() + 30 * DAY),
        confirmationSentAt: iso(start), unlockSeenAt: iso(start), createdAt: iso(start),
      });
    };
    const fresh = () => db.find('users', clientId);

    // --- who never sees one ------------------------------------------------
    await onPlan('unlimited');
    let why = await upsell.eligibility(await fresh());
    check('Unlimited is never asked to upgrade', why.ok === false && why.reason === 'top_plan',
      why.reason);
    r = await client.req('GET', '/api/membership/upsell');
    check('and the endpoint hands over nothing', r.data.prompt === null,
      JSON.stringify(r.data.prompt));

    await onPlan('managed', { startedDaysAgo: 2 });
    why = await upsell.eligibility(await fresh());
    // Somebody who decided two days ago is not somebody to sell to.
    check('nobody is asked in the first week of a plan',
      why.ok === false && why.reason === 'settling_in', why.reason);

    {
      const sub = await onPlan('managed');
      await db.update('subscriptions', sub.id, { status: 'past_due' });
      why = await upsell.eligibility(await fresh());
      check('a client behind on payment is never upsold',
        why.ok === false && ['past_due', 'no_active_plan'].includes(why.reason), why.reason);
    }

    {
      const sub = await onPlan('managed');
      await db.update('subscriptions', sub.id, {
        status: 'cancelled', cancelledAt: iso(Date.now()), renewsAt: iso(Date.now() + 10 * DAY),
      });
      why = await upsell.eligibility(await fresh());
      check('and neither is one who is leaving',
        why.ok === false && why.reason === 'cancelling', why.reason);
    }

    // --- who does ----------------------------------------------------------
    await onPlan('managed');
    why = await upsell.eligibility(await fresh());
    check('a settled Managed client may be asked', why.ok === true, why.reason);

    r = await client.req('GET', '/api/membership/upsell');
    check('and gets a prompt', Boolean(r.data.prompt));
    check('pointed at Unlimited', r.data.prompt?.to?.key === 'unlimited', r.data.prompt?.to?.key);
    check('with the monthly difference worked out', r.data.prompt?.differenceUsd === 10,
      String(r.data.prompt?.differenceUsd));
    // Only the difference. Repeating what they already have makes the step up
    // look smaller than it is.
    const gainedKeys = (r.data.prompt?.gained || []).map((g) => g.key);
    check('listing only what the upgrade adds',
      gainedKeys.includes('daily_backups') && !gainedKeys.includes('hosting'),
      gainedKeys.join(','));
    const firstMessage = r.data.prompt?.messageKey;

    // Basic is sold Managed, not Unlimited: the step that describes their life.
    await onPlan('basic');
    r = await client.req('GET', '/api/membership/upsell');
    check('a Basic client is sold Managed first', r.data.prompt?.to?.key === 'managed',
      r.data.prompt?.to?.key);

    // --- fetching is not showing -------------------------------------------
    await onPlan('managed');
    await client.req('GET', '/api/membership/upsell');
    await client.req('GET', '/api/membership/upsell');
    let shownEvents = await db.filter('membership_events', (e) => e.type === 'upsell_shown'
      && e.clientId === clientId);
    // A tab opened in the background and never looked at must not spend the
    // week's one prompt.
    check('asking twice does not count as showing twice', shownEvents.length === 0,
      String(shownEvents.length));

    // --- the ceiling -------------------------------------------------------
    r = await client.req('POST', '/api/membership/upsell/shown', { messageKey: firstMessage });
    check('the browser reports when it actually appears', r.status === 200, `${r.status}`);
    why = await upsell.eligibility(await fresh());
    check('and we may not ask again this week',
      why.ok === false && why.reason === 'asked_recently', why.reason);
    r = await client.req('GET', '/api/membership/upsell');
    check('so the endpoint hands over nothing', r.data.prompt === null);

    // --- the ticket form spends the same budget ---------------------------
    await onPlan('managed');
    // Use up the allowance, then get turned away -- which is an upgrade
    // prompt, and must count.
    await client.req('POST', '/api/tickets', { subject: 'A', category: 'Website', description: 'x' });
    await client.req('POST', '/api/tickets', { subject: 'B', category: 'Website', description: 'y' });
    r = await client.req('POST', '/api/tickets', { subject: 'C', category: 'Website', description: 'z' });
    check('the third request is turned away', r.status === 409, `${r.status}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    shownEvents = await db.filter('membership_events', (e) => e.type === 'upsell_shown'
      && e.clientId === clientId);
    check('and that counts as having asked them', shownEvents.length === 1, String(shownEvents.length));
    why = await upsell.eligibility(await fresh());
    // A client offered Unlimited on the ticket form on Monday must not also
    // get a modal about it on Wednesday.
    check('so no modal follows it the same week',
      why.ok === false && why.reason === 'asked_recently', why.reason);

    // --- the ways out ------------------------------------------------------
    await onPlan('managed');
    r = await client.req('POST', '/api/membership/upsell/snoozed', { messageKey: 'managed-seo' });
    check('"Remind me in 30 days" is accepted', r.status === 200 && Boolean(r.data.until));
    why = await upsell.eligibility(await fresh());
    check('and honoured', why.ok === false && why.reason === 'snoozed', why.reason);
    let me = await fresh();
    check('a snooze is not counted as a refusal', Number(me.upsellDismissStreak || 0) === 0,
      String(me.upsellDismissStreak));

    // --- three refusals in a row --------------------------------------------
    await onPlan('managed');
    for (let i = 1; i <= 3; i += 1) {
      r = await client.req('POST', '/api/membership/upsell/dismissed', { messageKey: `m${i}` });
      check(`"Not now" number ${i} is counted`, r.data.streak === i, String(r.data.streak));
    }
    me = await fresh();
    check('after three in a row the gap widens to 30 days',
      upsell.gapDaysFor(me) === upsell.BACKED_OFF_GAP_DAYS, String(upsell.gapDaysFor(me)));

    // Eight days on, the ordinary ceiling would allow another. The backed-off
    // one does not.
    await db.update('users', clientId, { upsellSnoozedUntil: null });
    for (const e of await db.filter('membership_events', (e) => e.clientId === clientId
      && e.type === 'upsell_shown')) {
      await db.update('membership_events', e.id, { createdAt: iso(Date.now() - 8 * DAY) });
    }
    await db.insert('membership_events', {
      clientId, type: 'upsell_shown', createdAt: iso(Date.now() - 8 * DAY),
    });
    why = await upsell.eligibility(await fresh());
    check('so a prompt eight days later is still held back',
      why.ok === false && why.reason === 'asked_recently', why.reason);

    // --- clicking through forgives the streak ------------------------------
    r = await client.req('POST', '/api/membership/upsell/clicked', { messageKey: 'managed-seo' });
    check('clicking through is recorded', r.status === 200);
    me = await fresh();
    check('and resets the streak', Number(me.upsellDismissStreak || 0) === 0,
      String(me.upsellDismissStreak));
    check('and clears any snooze', !me.upsellSnoozedUntil, String(me.upsellSnoozedUntil));
    check('so the ordinary weekly ceiling applies again',
      upsell.gapDaysFor(me) === upsell.NORMAL_GAP_DAYS, String(upsell.gapDaysFor(me)));

    // --- never the same line twice in a row --------------------------------
    {
      const list = upsell.MESSAGES.managed;
      for (const current of list) {
        const next = upsell.pickMessage('managed', current.key);
        check(`a message after ${current.key} is a different one`, next.key !== current.key,
          next.key);
      }
    }

    // --- only true statements ----------------------------------------------
    {
      await onPlan('managed');
      const atLimit = await upsell.monthsAtLimit(clientId, 2);
      check('a client with no history is not told they hit their limit', atLimit === 0,
        String(atLimit));

      // Two finished months where they used both updates. Now it is true.
      const subs = require('../utils/subscriptions');
      for (const back of [1, 2]) {
        const periodStart = iso(Date.now() - back * 31 * DAY);
        await db.insert('update_request_usage', {
          id: subs.usageId(clientId, periodStart),
          clientId, periodStart, periodEnd: iso(Date.now() - (back - 1) * 31 * DAY - DAY),
          count: 2, extraCount: 0, updatedAt: periodStart,
        });
      }
      check('but a client who really did is', (await upsell.monthsAtLimit(clientId, 2)) === 2,
        String(await upsell.monthsAtLimit(clientId, 2)));

      for (const u of await db.filter('update_request_usage', (u) => u.clientId === clientId)) {
        await db.remove('update_request_usage', u.id);
      }
    }

    // --- staff are not customers -------------------------------------------
    r = await admin.req('GET', '/api/membership/upsell');
    check('staff are never shown an upgrade prompt', r.data.prompt === null);

    r = await client.req('POST', '/api/membership/upsell/nonsense', {});
    check('an unknown action is refused', r.status === 400, `${r.status}`);

    for (const s of await db.filter('subscriptions', (s) => s.clientId === clientId)) {
      await db.remove('subscriptions', s.id);
    }
    await db.update('users', clientId, {
      upsellDismissStreak: 0, upsellSnoozedUntil: null,
      upsellLastShownAt: null, upsellLastMessage: null,
    });
  }

  // --- membership: the locked panels ---------------------------------------
  {
    const { db } = require('../db/setup');
    const plans = require('../lib/plans');
    const iso = (ms) => new Date(ms).toISOString();

    const onPlan = async (planKey) => {
      for (const s of await db.filter('subscriptions', (s) => s.clientId === clientId)) {
        await db.remove('subscriptions', s.id);
      }
      const start = Date.now();
      return db.insert('subscriptions', {
        clientId, planKey, period: 1, amountUsd: plans.amountFor(planKey, 1),
        status: 'active', markedPaidAt: iso(start), startedAt: iso(start),
        renewsAt: plans.renewalDate(iso(start), 1).toISOString(),
        confirmationSentAt: iso(start), unlockSeenAt: iso(start), createdAt: iso(start),
      });
    };

    // Something real to be refused.
    r = await admin.req('POST', '/api/site-records', {
      clientId, kind: 'daily_backups', title: 'Full site backup',
      detail: 'Files and database', status: 'Stored',
    });
    check('staff can log work on a site', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
    const recordId = r.data.record?.id;

    r = await admin.req('POST', '/api/site-records', {
      clientId, kind: 'not_a_panel', title: 'Nonsense',
    });
    check('an unknown panel is refused', r.status === 400, `${r.status}`);

    // --- Unlimited sees it -------------------------------------------------
    await onPlan('unlimited');
    r = await client.req('GET', '/api/site-records?kind=daily_backups');
    check('an Unlimited client sees their backups', r.status === 200 && r.data.locked === false,
      `${r.status} ${r.data.locked}`);
    check('with the row we logged', r.data.records?.[0]?.title === 'Full site backup',
      r.data.records?.[0]?.title);

    // --- Managed does not --------------------------------------------------
    await onPlan('managed');
    r = await client.req('GET', '/api/site-records?kind=daily_backups');
    check('a Managed client is told the panel is locked', r.data.locked === true);
    // This is the line that matters. Hiding a panel in the browser while the
    // API still hands the rows over is not a lock, it is a cover.
    check('and is sent no rows at all', (r.data.records || []).length === 0,
      JSON.stringify(r.data.records));
    check('they are pointed at Unlimited', r.data.recommended === 'unlimited', r.data.recommended);

    // The panels Managed does include still work.
    r = await client.req('GET', '/api/site-records?kind=monthly_health_check');
    check('but a panel Managed does include is not locked', r.data.locked === false);

    // --- Basic sees even less ----------------------------------------------
    await onPlan('basic');
    for (const kind of ['daily_backups', 'uptime_monitoring', 'monthly_health_check']) {
      r = await client.req(`GET`, `/api/site-records?kind=${kind}`);
      check(`Basic is locked out of ${kind}`, r.data.locked === true, JSON.stringify(r.data.locked));
      check(`and sent no ${kind} rows`, (r.data.records || []).length === 0);
    }

    // --- one client never reads another ------------------------------------
    await onPlan('unlimited');
    const stranger = (await db.filter('users', (u) => u.role === 'client' && u.id !== clientId))[0];
    if (stranger) {
      await db.insert('site_records', {
        clientId: stranger.id, kind: 'daily_backups', title: 'Not yours',
        occurredAt: iso(Date.now()), createdAt: iso(Date.now()),
      });
      r = await client.req('GET', `/api/site-records?kind=daily_backups&clientId=${stranger.id}`);
      check('a client naming another client still gets their own rows',
        (r.data.records || []).every((x) => x.title !== 'Not yours'),
        JSON.stringify((r.data.records || []).map((x) => x.title)));
    }

    // --- only staff write --------------------------------------------------
    r = await client.req('POST', '/api/site-records', {
      clientId, kind: 'daily_backups', title: 'I did this myself',
    });
    check('a client cannot write their own history', r.status === 403, `${r.status}`);

    // --- every locked entitlement has a panel behind it --------------------
    const panelKinds = require('../routes/siteRecords').PANEL_KINDS;
    check('every lockable entitlement is a real panel',
      plans.ENTITLEMENTS.filter((e) => e.locked).every((e) => panelKinds.includes(e.key)),
      panelKinds.join(','));
    for (const kind of panelKinds) {
      r = await client.req('GET', `/api/site-records?kind=${kind}`);
      check(`${kind} answers rather than erroring`, r.status === 200, `${r.status}`);
    }

    await db.remove('site_records', recordId);
    for (const s of await db.filter('subscriptions', (s) => s.clientId === clientId)) {
      await db.remove('subscriptions', s.id);
    }
  }

  // --- membership: the welcome email ---------------------------------------
  {
    const { db } = require('../db/setup');
    const subscriptionsUtil = require('../utils/subscriptions');

    const welcomes = () => db.filter('email_log', (e) => e.template === 'welcome_with_plans');

    // --- a brand new client is greeted at once ----------------------------
    r = await admin.req('POST', '/api/users', {
      name: 'Welcome Tester', email: 'welcome.tester@example.com', role: 'client',
      password: 'WelcomePass#1', company: 'Welcome Co',
    });
    check('a new client account is created', r.status === 201, `${r.status}`);
    const welcomedId = r.data.user?.id;

    let sent = (await welcomes()).filter((e) => String(e.toEmails).includes('welcome.tester@example.com'));
    check('and is sent the welcome email straight away', sent.length === 1, String(sent.length));
    check('with the subject from the brief',
      sent[0]?.subject === 'Your Ethixweb dashboard is ready, here are your plan options',
      sent[0]?.subject);

    let record = await db.find('users', welcomedId);
    check('the send is stamped on the account', Boolean(record.welcomeEmailSentAt));

    const logged = await db.filter('membership_events', (e) => e.type === 'welcome_email_sent'
      && e.clientId === welcomedId);
    check('and logged for the funnel', logged.length === 1, String(logged.length));
    check('as a signup rather than a first login', logged[0]?.metadata?.reason === 'signup',
      JSON.stringify(logged[0]?.metadata));

    // --- and never twice --------------------------------------------------
    const resent = await subscriptionsUtil.sendWelcome(record, { reason: 'first_login' });
    check('asking again declines rather than sending a second', resent === false);
    sent = (await welcomes()).filter((e) => String(e.toEmails).includes('welcome.tester@example.com'));
    check('so there is still only one', sent.length === 1, String(sent.length));

    // --- a client who predates the feature gets it on first sign-in -------
    // Exactly the state every existing client is in on the morning this ships:
    // an account, no welcome on record, and no first login stamped.
    await db.update('users', welcomedId, { welcomeEmailSentAt: null, firstLoginAt: null });
    const existing = await db.find('users', welcomedId);
    const greeted = await subscriptionsUtil.sendWelcome(existing, { reason: 'first_login' });
    check('a client who predates plans is greeted on first sign-in', greeted === true);

    const firstLogin = await db.filter('membership_events', (e) => e.type === 'welcome_email_sent'
      && e.clientId === welcomedId && e.metadata?.reason === 'first_login');
    check('and it is recorded as a first login, not a signup', firstLogin.length === 1,
      String(firstLogin.length));

    // --- staff are never sent it ------------------------------------------
    const staff = await db.find('users', 'u-pm');
    check('staff are never sent a client welcome',
      (await subscriptionsUtil.sendWelcome(staff, { reason: 'signup' })) === false);

    // --- the figures come from the config, not the template ---------------
    const messages = require('../utils/emailMessages');
    const preview = messages.renderPreview('welcome_with_plans');
    const plansConfig = require('../lib/plans');
    // Asserts that the figure came from the config and reached the message,
    // not that any particular sentence survives a copy edit.
    for (const plan of plansConfig.PLANS) {
      const money = plansConfig.formatUsd(plan.monthlyUsd);
      check(`the welcome quotes ${plan.name} at ${money}`,
        preview.text.includes(plan.name) && preview.text.includes(`${money}/month USD`),
        plan.key);
      check(`and ${plan.name} leads with what it includes`,
        plansConfig.highlightsFor(plan.key).every((h) => preview.text.includes(h.label)),
        plansConfig.highlightsFor(plan.key).map((h) => h.label).join(' | '));
    }
    const yearly = plansConfig.priceFor(29, 12);
    check('and the yearly figure matches the playbook',
      preview.text.includes(`${plansConfig.formatUsd(yearly.perMonth)} a month`),
      plansConfig.formatUsd(yearly.perMonth));
    check('it points at the plans page', preview.text.includes('/portal/billing/plans'));
    check('and offers a way back to the dashboard', /Log in:/.test(preview.text));

    // The brief is explicit about both of these.
    check('no checkmark glyphs anywhere in it',
      !/&#10003;|&check;|✓|✔/.test(preview.html));
    check('and no discount maths in the subject line',
      !/%|save|off/i.test(preview.subject), preview.subject);

    await db.remove('users', welcomedId);
  }

  // --- membership: what a plan lets you ask for ----------------------------
  {
    const { db } = require('../db/setup');
    const plans = require('../lib/plans');
    const updateRequests = require('../utils/updateRequests');
    const iso = (ms) => new Date(ms).toISOString();

    const onPlan = async (planKey, period = 1) => {
      for (const s of await db.filter('subscriptions', (s) => s.clientId === clientId)) {
        await db.remove('subscriptions', s.id);
      }
      for (const u of await db.filter('update_request_usage', (u) => u.clientId === clientId)) {
        await db.remove('update_request_usage', u.id);
      }
      const start = Date.now();
      return db.insert('subscriptions', {
        clientId, planKey, period, amountUsd: plans.amountFor(planKey, period),
        status: 'active', markedPaidAt: iso(start), startedAt: iso(start),
        renewsAt: plans.renewalDate(iso(start), period).toISOString(),
        confirmationSentAt: iso(start), unlockSeenAt: iso(start), createdAt: iso(start),
      });
    };

    // --- a grandfathered client is not gated at all ------------------------
    for (const s of await db.filter('subscriptions', (s) => s.clientId === clientId)) {
      await db.remove('subscriptions', s.id);
    }
    r = await client.req('POST', '/api/tickets', {
      subject: 'Grandfathered change', category: 'Website', description: 'Still works.',
    });
    check('a client with no plan can still raise a request', r.status === 201, `${r.status}`);

    // --- Basic: hosting only ----------------------------------------------
    await onPlan('basic');

    r = await client.req('POST', '/api/tickets', {
      subject: 'Please change the homepage banner',
      category: 'Website',
      description: 'Swap the photo for the new one.',
    });
    check('Basic cannot raise a change request', r.status === 403, `${r.status}`);
    check('and is offered Managed rather than a closed door',
      r.data.recommended === 'managed', r.data.recommended);
    check('the reason is machine readable', r.data.reason === 'category_not_included', r.data.reason);
    check('the message explains it in plain words',
      /hosting only/i.test(r.data.error || ''), r.data.error);

    // An outage always gets through. A client whose site is down must be able
    // to reach us whatever they pay.
    r = await client.req('POST', '/api/tickets', {
      subject: 'Site is down', category: 'Site down', description: 'Nothing loads at all.',
    });
    check('but an outage always gets through on Basic', r.status === 201, `${r.status}`);

    r = await client.req('POST', '/api/tickets', {
      subject: 'Question about my invoice', category: 'Billing', description: 'What is this line?',
    });
    check('and so does a billing question', r.status === 201, `${r.status}`);

    // --- Managed: two a month, then a decision ----------------------------
    await onPlan('managed', 6);

    r = await client.req('POST', '/api/tickets', {
      subject: 'Change one', category: 'Website', description: 'First change.',
    });
    check('Managed can raise the first of two', r.status === 201, `${r.status}`);
    r = await client.req('POST', '/api/tickets', {
      subject: 'Change two', category: 'Website', description: 'Second change.',
    });
    check('and the second', r.status === 201, `${r.status}`);

    r = await client.req('GET', '/api/membership/status');
    check('the meter reads two of two used', r.data.membership?.usage?.used === 2,
      String(r.data.membership?.usage?.used));
    check('with none remaining', r.data.membership?.usage?.remaining === 0);

    // An outage still gets through, and does NOT eat an update.
    r = await client.req('POST', '/api/tickets', {
      subject: 'Site down again', category: 'Site down', description: 'Down since 9am.',
    });
    check('an outage still gets through with the allowance spent', r.status === 201, `${r.status}`);
    r = await client.req('GET', '/api/membership/status');
    check('and an outage never eats an update', r.data.membership?.usage?.used === 2,
      String(r.data.membership?.usage?.used));

    // --- the third change ---------------------------------------------------
    const third = {
      subject: 'Change three',
      category: 'Website',
      description: 'The long paragraph a client typed and must not lose.',
    };
    r = await client.req('POST', '/api/tickets', third);
    check('the third change is held for a decision, not refused', r.status === 409, `${r.status}`);
    check('it is flagged as the allowance running out',
      r.data.reason === 'allowance_used', r.data.reason);
    check('it says when the next two unlock', Boolean(r.data.resetsAt));
    check('and that an extra can be paid for', r.data.chargeable === true);
    check('with Unlimited offered too', r.data.recommended === 'unlimited', r.data.recommended);

    let madeIt = await db.filter('tickets', (t) => t.subject === 'Change three');
    check('nothing was created while they decide', madeIt.length === 0, String(madeIt.length));

    // --- option one: wait for the reset -----------------------------------
    r = await client.req('POST', '/api/tickets', { ...third, queueForNextPeriod: true });
    check('they can save it for next month', r.status === 202, `${r.status}`);
    check('and the text they typed is kept word for word',
      r.data.queued?.description === third.description, r.data.queued?.description);

    r = await client.req('GET', '/api/tickets/queued');
    check('it shows in what they are holding', r.data.queued?.length === 1,
      String(r.data.queued?.length));

    // A held request is NOT a ticket. Putting it in the queue would start an
    // SLA clock nobody agreed to and bury the real queue.
    madeIt = await db.filter('tickets', (t) => t.subject === 'Change three');
    check('and it is still not in the ticket queue', madeIt.length === 0, String(madeIt.length));

    const heldId = r.data.queued[0].id;
    r = await client.req('DELETE', `/api/tickets/queued/${heldId}`);
    check('they can change their mind about holding it', r.status === 200, `${r.status}`);
    r = await client.req('GET', '/api/tickets/queued');
    check('and it stops being held', r.data.queued?.length === 0, String(r.data.queued?.length));

    // --- option two: pay for it -------------------------------------------
    r = await client.req('POST', '/api/tickets', { ...third, acceptExtraCharge: true });
    check('or they can agree to be quoted for an extra', r.status === 201, `${r.status}`);
    check('and the ticket says it is a chargeable extra', r.data.chargedAsExtra === true);

    r = await client.req('GET', '/api/membership/status');
    check('the extra is counted separately', r.data.membership?.usage?.extraUsed === 1,
      String(r.data.membership?.usage?.extraUsed));
    // "2 of 2 used" and "1 extra" are different facts. Adding them together
    // would tell a Managed client they had used three of two.
    check('and never added to the included two', r.data.membership?.usage?.used === 2,
      String(r.data.membership?.usage?.used));

    const bought = await db.filter('membership_events', (e) => e.type === 'extra_update_purchased'
      && e.clientId === clientId);
    check('paying for an extra is logged', bought.length === 1, String(bought.length));

    // --- a held request becomes a ticket when it lands --------------------
    {
      await onPlan('managed', 6);
      const held = await updateRequests.queue(clientId, {
        subject: 'Held until the reset', category: 'Website',
        description: 'Kept exactly as typed.', priority: 'Normal',
        releaseAt: iso(Date.now() - 60_000),
      });
      const count = await updateRequests.releaseDue();
      check('a held request is released once its date passes', count === 1, String(count));

      const now = await db.find('queued_requests', held.id);
      check('it is marked released rather than released twice', Boolean(now.releasedAt));
      check('and points at the ticket it became', Boolean(now.ticketId));
      const asTicket = await db.find('tickets', now.ticketId);
      check('which carries the text they typed',
        asTicket?.description === 'Kept exactly as typed.', asTicket?.description);
      check('and is numbered like every other ticket', /^ticket-\d+$/.test(now.ticketId),
        now.ticketId);

      // Releasing spends one of the new month's updates: the client chose to
      // spend a future allowance rather than pay for an extra.
      r = await client.req('GET', '/api/membership/status');
      check('releasing it spends one of the new allowance',
        r.data.membership?.usage?.used === 1, String(r.data.membership?.usage?.used));

      check('and a second sweep releases nothing', (await updateRequests.releaseDue()) === 0);
    }

    // --- Unlimited is never counted ---------------------------------------
    await onPlan('unlimited', 12);
    for (let i = 0; i < 4; i += 1) {
      r = await client.req('POST', '/api/tickets', {
        subject: `Unlimited change ${i}`, category: 'Website', description: 'No limit here.',
      });
      if (r.status !== 201) break;
    }
    check('Unlimited can raise as many as they like', r.status === 201, `${r.status}`);
    r = await client.req('GET', '/api/membership/status');
    check('and sees no meter at all', r.data.membership?.usage?.unlimited === true);
    check('with nothing counted against them', r.data.membership?.usage?.included === null,
      String(r.data.membership?.usage?.included));

    // --- the limit is on the client, never on us --------------------------
    await onPlan('basic');
    r = await admin.req('POST', '/api/tickets', {
      clientId, subject: 'Logged after a phone call', category: 'Website',
      description: 'Raised by the team on their behalf.',
    });
    // Staff raise tickets for clients constantly -- after a call, off a text.
    // Refusing those would mean the plan limits the team, not the customer.
    check('staff can still raise a ticket for a Basic client', r.status === 201, `${r.status}`);

    // Leave the account as the rest of the suite expects to find it.
    for (const s of await db.filter('subscriptions', (s) => s.clientId === clientId)) {
      await db.remove('subscriptions', s.id);
    }
    for (const u of await db.filter('update_request_usage', (u) => u.clientId === clientId)) {
      await db.remove('update_request_usage', u.id);
    }
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

  // --- the SMS <-> Slack bridge ---------------------------------------------
  // Twilio and Slack are both driven through a stubbed global.fetch here, on
  // the same principle as the Stripe section above: the bridge is a pure
  // function of the webhook/event bodies it receives, so its behaviour can be
  // proven without a network call or a real credential. Only the two outbound
  // HTTP calls this code ever makes -- Twilio's Messages API and Slack's
  // chat.postMessage -- are intercepted; everything else (including this
  // test's own requests to the local server) passes through untouched.
  {
    const crypto = require('crypto');
    const { db } = require('../db/setup');

    process.env.TWILIO_ACCOUNT_SID = 'ACtest0000000000000000000000000';
    process.env.TWILIO_AUTH_TOKEN = 'test_auth_token';
    process.env.TWILIO_NUMBER = '+15550001111';
    process.env.TWILIO_WEBHOOK_URL = `${base}/api/sms/webhook`;
    process.env.SMS_OUTBOUND_ENABLED = 'on';
    process.env.SMS_SLACK_CHANNEL = 'CSMSBRIDGE';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_SIGNING_SECRET = 'test_signing_secret';
    // The directory and channel list are cached for half an hour, and earlier
    // sections of this suite may already have filled them from a different
    // stub. Drop both so the fixtures below are what gets read.
    require('../utils/integrationCache').invalidate('slack:');

    let slackTsCounter = 0;
    const twilioSends = [];
    const slackPosts = [];
    // Card edits are chat.update, not chat.postMessage. Kept apart because the
    // whole point of the task card is that a state change edits one message
    // rather than adding another -- a test that cannot tell them apart cannot
    // prove that.
    const slackUpdates = [];
    let twilioShouldFail = false;
    // Makes the card edit fail, which is the only acknowledgement most commands
    // get -- so it is worth being able to prove what happens when it does not.
    let slackUpdateShouldFail = false;
    // Fails only sends to this one number, leaving the rest of a batch
    // untouched -- for proving one bad recipient doesn't stop the others.
    let twilioFailForNumber = null;

    const realFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
      const href = String(url);
      if (href.startsWith('https://api.twilio.com/')) {
        const params = new URLSearchParams(opts.body);
        const to = params.get('To');
        twilioSends.push({ to, body: params.get('Body') });
        if (twilioShouldFail || to === twilioFailForNumber) {
          return { ok: false, status: 400, json: async () => ({ code: 21211, message: 'Invalid To number' }) };
        }
        return { ok: true, status: 201, json: async () => ({ sid: `SMFAKE${twilioSends.length}` }) };
      }
      if (href === 'https://slack.com/api/chat.postMessage') {
        const payload = JSON.parse(opts.body);
        slackTsCounter += 1;
        const ts = `1700000000.${String(slackTsCounter).padStart(6, '0')}`;
        slackPosts.push({ channel: payload.channel, thread_ts: payload.thread_ts || null, ts, text: payload.text });
        return { ok: true, status: 200, json: async () => ({ ok: true, ts, channel: payload.channel }) };
      }
      if (href === 'https://slack.com/api/chat.update') {
        const payload = JSON.parse(opts.body);
        if (slackUpdateShouldFail) {
          return { ok: true, status: 200, json: async () => ({ ok: false, error: 'message_not_found' }) };
        }
        slackUpdates.push({ channel: payload.channel, ts: payload.ts, text: payload.text });
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: payload.ts, channel: payload.channel }) };
      }
      // The directory and thread reads the completion drafter walks on its way
      // to the notes. Stubbed rather than left to the real network so a bare
      // `@send` is deterministic and offline.
      if (href.startsWith('https://slack.com/api/conversations.list')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, channels: [{ id: 'CSMSBRIDGE', name: 'client-sms', is_member: true }] }) };
      }
      if (href.startsWith('https://slack.com/api/users.list')) {
        // Real members, because who typed a command now decides whether it
        // runs. Emails are the join onto the seeded dashboard accounts:
        // admin and Priya are admins, Ryan is a project manager, Jordan is an
        // employee, and the guest has no email at all -- which is what a
        // workspace without the users:read.email scope looks like.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            members: [
              { id: 'U_STAFF_1', name: 'admin', is_bot: false, profile: { real_name: 'Admin User', email: 'admin@ethixweb.local' } },
              { id: 'U_STAFF_2', name: 'priya', is_bot: false, profile: { real_name: 'Priya Nair', email: 'priya.nair@ethixweb.local' } },
              { id: 'U0DEV0001', name: 'ryan', is_bot: false, profile: { real_name: 'Ryan Coleman', email: 'ryan.coleman@ethixweb.local' } },
              // Made further down rather than seeded: the approval section of
              // this suite deletes the seeded employee, and an account that
              // vanishes halfway through is no use as a role fixture.
              { id: 'U0DEV0002', name: 'sms-employee', is_bot: false, profile: { real_name: 'SMS Employee', email: 'sms.employee@ethixweb.local' } },
              { id: 'U_GUEST', name: 'guest', is_bot: false, profile: { real_name: 'Channel Guest' } },
            ],
          }),
        };
      }
      if (href.startsWith('https://slack.com/api/conversations.replies')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, messages: [] }) };
      }
      return realFetch(url, opts);
    };

    function twilioSignature(url, params) {
      let payload = url;
      for (const key of Object.keys(params).sort()) payload += key + params[key];
      return crypto.createHmac('sha1', process.env.TWILIO_AUTH_TOKEN).update(Buffer.from(payload, 'utf8')).digest('base64');
    }

    async function postTwilioWebhook(fields) {
      const body = new URLSearchParams(fields).toString();
      const sig = twilioSignature(process.env.TWILIO_WEBHOOK_URL, fields);
      const res = await fetch(`${base}/api/sms/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig },
        body,
      });
      return { status: res.status, text: await res.text() };
    }

    function slackSignature(rawBody, timestamp) {
      const basestring = `v0:${timestamp}:${rawBody}`;
      return `v0=${crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET).update(basestring, 'utf8').digest('hex')}`;
    }

    async function postSlackEvent(payload) {
      const raw = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const res = await fetch(`${base}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Slack-Signature': slackSignature(raw, timestamp),
          'X-Slack-Request-Timestamp': timestamp,
        },
        body: raw,
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }

      // The route answers Slack the moment it has claimed the event id and
      // runs the command afterwards, off the request -- Slack's three-second
      // deadline cannot accommodate a draft-and-send. So every assertion about
      // what an event *did* has to wait for the work, not just the reply.
      await require('../routes/slackEvents').whenIdle();

      return { status: res.status, data };
    }

    // Test 1 -- inbound Twilio SMS creates exactly one message
    const customerA = '+15551230001';
    const beforeCount = (await db.all('sms_messages')).length;
    r = await postTwilioWebhook({
      MessageSid: 'SMinboundA1', From: customerA, To: process.env.TWILIO_NUMBER,
      Body: 'Hi, my invoice looks wrong', NumMedia: '0',
    });
    check('Twilio inbound webhook accepts a correctly signed request', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
    let allMessages = await db.all('sms_messages');
    check('exactly one message was created', allMessages.length === beforeCount + 1, `${allMessages.length - beforeCount}`);
    const rowA1 = allMessages.find((m) => m.providerSid === 'SMinboundA1');
    check('it is stored inbound, from the customer\'s number', rowA1?.direction === 'inbound' && rowA1?.fromNumber === customerA);

    // Test 3 -- routed into a Slack conversation, a fresh thread opened for it
    const convoA = (await db.filter('sms_conversations', (c) => c.phoneNumber === customerA))[0];
    check('a conversation record was opened for the new number', Boolean(convoA), JSON.stringify(convoA));
    check('it is threaded into the configured SMS channel', convoA?.slackChannelId === 'CSMSBRIDGE', convoA?.slackChannelId);
    check('exactly one new Slack thread was opened for it', slackPosts.filter((p) => !p.thread_ts).length === 1, slackPosts.length);

    // Test 2 -- a replayed Twilio webhook (same MessageSid) does not duplicate it
    r = await postTwilioWebhook({
      MessageSid: 'SMinboundA1', From: customerA, To: process.env.TWILIO_NUMBER,
      Body: 'Hi, my invoice looks wrong', NumMedia: '0',
    });
    check('a replayed Twilio webhook still answers 200', r.status === 200, r.status);
    allMessages = await db.all('sms_messages');
    check('the replay did not create a second message', allMessages.length === beforeCount + 1, `${allMessages.length - beforeCount}`);

    // A second, distinct text from the same customer reuses the same thread.
    r = await postTwilioWebhook({
      MessageSid: 'SMinboundA2', From: customerA, To: process.env.TWILIO_NUMBER,
      Body: 'Following up on that', NumMedia: '0',
    });
    check('a second text from the same customer is accepted', r.status === 200, r.status);
    const convoA2 = (await db.filter('sms_conversations', (c) => c.phoneNumber === customerA))[0];
    check('the same customer keeps one conversation record, not a second one',
      convoA2?.id === convoA.id && convoA2?.slackThreadTs === convoA.slackThreadTs);
    check('the second text replied inside the existing thread rather than opening a new one',
      slackPosts.filter((p) => p.thread_ts === convoA.slackThreadTs).length === 1, slackPosts.length);

    // Test 4 -- a brand-new, unknown customer is handled on its own
    const customerB = '+15551230002';
    r = await postTwilioWebhook({
      MessageSid: 'SMinboundB1', From: customerB, To: process.env.TWILIO_NUMBER,
      Body: 'Can someone call me back', NumMedia: '0',
    });
    check('an unknown customer\'s text is accepted', r.status === 200, r.status);
    const rowB1 = (await db.all('sms_messages')).find((m) => m.providerSid === 'SMinboundB1');
    check('an unknown number is stored with no client attached', rowB1 && rowB1.clientId === null, JSON.stringify(rowB1?.clientId));
    const convoB = (await db.filter('sms_conversations', (c) => c.phoneNumber === customerB))[0];
    check('it gets its own conversation, separate from customer A\'s', Boolean(convoB) && convoB.id !== convoA.id);
    check('multiple customers stay on separate threads (Test 11)', convoB?.slackThreadTs !== convoA.slackThreadTs);

    // --- the task flow -----------------------------------------------------
    // A thread is a workspace now, not a megaphone: people talk in it freely
    // and exactly one message ever reaches the customer, from @send.

    let evCounter = 0;
    async function threadSay(threadTs, text, eventId, user = 'U_STAFF_1') {
      evCounter += 1;
      return postSlackEvent({
        type: 'event_callback',
        event_id: eventId,
        event: {
          type: 'message', channel: 'CSMSBRIDGE', user, text,
          ts: `17000005${String(evCounter).padStart(2, '0')}.000100`,
          thread_ts: threadTs,
        },
      });
    }

    async function taskFor(conversationId) {
      const rows = await db.filter('sms_tasks', (t) => t.conversationId === conversationId);
      rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return rows[0] || null;
    }

    const lastPost = () => slackPosts[slackPosts.length - 1];

    // Test 5 -- the inbound text opened a task, and ordinary talk sends nothing
    const taskA = await taskFor(convoA.id);
    check('an inbound text opens a task', Boolean(taskA), JSON.stringify(taskA));
    check('the task starts in NEW', taskA?.state === 'NEW', taskA?.state);
    check('its card is the thread the bridge routes replies to',
      taskA?.slackMessageTs === convoA.slackThreadTs, `${taskA?.slackMessageTs} vs ${convoA.slackThreadTs}`);
    check('the second text did not open a second task',
      (await db.filter('sms_tasks', (t) => t.conversationId === convoA.id)).length === 1);

    const sendsBeforeChat = twilioSends.length;
    r = await threadSay(convoA.slackThreadTs, 'Looking into this, might be the billing sync.', 'EvChat1');
    check('ordinary talk in a task thread is accepted', r.status === 200, JSON.stringify(r.data));
    check('and reaches the customer not at all', twilioSends.length === sendsBeforeChat, twilioSends.length);

    // Test 5b -- @send is gated on the task having an owner
    r = await threadSay(convoA.slackThreadTs, '@send', 'EvSendTooEarly');
    check('@send on an unassigned task sends nothing', twilioSends.length === sendsBeforeChat, twilioSends.length);
    check('and says why in the thread',
      lastPost()?.thread_ts === convoA.slackThreadTs && /assign an owner/i.test(lastPost()?.text || ''), lastPost()?.text);

    // Test 5c -- @accept claims it, and edits the card rather than posting again
    const updatesBeforeAccept = slackUpdates.length;
    const postsBeforeAccept = slackPosts.length;
    r = await threadSay(convoA.slackThreadTs, '@accept', 'EvAccept1');
    let taskA2 = await taskFor(convoA.id);
    check('@accept moves the task to ACCEPTED', taskA2?.state === 'ACCEPTED', taskA2?.state);
    check('and records who claimed it', taskA2?.acceptedBy === 'U_STAFF_1', taskA2?.acceptedBy);
    check('the card was edited in place', slackUpdates.length === updatesBeforeAccept + 1, slackUpdates.length);
    check('the edit targets the card itself', slackUpdates[slackUpdates.length - 1]?.ts === taskA.slackMessageTs);
    check('and no follow-up message was posted for the state change',
      slackPosts.length === postsBeforeAccept, slackPosts.length - postsBeforeAccept);
    check('the card now shows the new state', /ACCEPTED/.test(slackUpdates[slackUpdates.length - 1]?.text || ''));

    // Test 5d -- the state machine refuses a repeat
    r = await threadSay(convoA.slackThreadTs, '@accept', 'EvAccept2');
    check('a second @accept is refused with one line', /already/i.test(lastPost()?.text || ''), lastPost()?.text);
    check('and the task is untouched', (await taskFor(convoA.id))?.state === 'ACCEPTED');

    // Test 5e -- @assign names an owner
    r = await threadSay(convoA.slackThreadTs, '@assign <@U0DEV0001>', 'EvAssign1');
    taskA2 = await taskFor(convoA.id);
    check('@assign moves the task to ASSIGNED', taskA2?.state === 'ASSIGNED', taskA2?.state);
    check('and stores the owner', taskA2?.ownerSlackId === 'U0DEV0001', taskA2?.ownerSlackId);

    r = await threadSay(convoA.slackThreadTs, '@assign', 'EvAssignNobody');
    check('@assign with nobody named asks for a name', /name somebody/i.test(lastPost()?.text || ''), lastPost()?.text);
    check('and leaves the existing owner alone', (await taskFor(convoA.id))?.ownerSlackId === 'U0DEV0001');

    // Test 5f -- @send <text> sends those exact words, once, and closes the task
    const exactWords = 'Your invoice has been corrected and resent.';
    const sendsBeforeSend = twilioSends.length;
    r = await threadSay(convoA.slackThreadTs, `@send ${exactWords}`, 'EvSend1');
    check('@send sends exactly one SMS', twilioSends.length === sendsBeforeSend + 1, twilioSends.length);
    check('to the customer that task belongs to', twilioSends[twilioSends.length - 1]?.to === customerA);
    check('with the exact words given, not a rewrite', twilioSends[twilioSends.length - 1]?.body === exactWords,
      twilioSends[twilioSends.length - 1]?.body);
    taskA2 = await taskFor(convoA.id);
    check('the task is CLOSED', taskA2?.state === 'CLOSED', taskA2?.state);
    check('and remembers what was sent', taskA2?.sentBody === exactWords, taskA2?.sentBody);
    check('the thread shows the exact text that was delivered', lastPost()?.text?.includes(exactWords), lastPost()?.text);
    const sentRow = (await db.all('sms_messages'))
      .filter((m) => m.direction === 'outbound' && m.toNumber === customerA)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    check('the send was persisted as an outbound message', sentRow?.body === exactWords, sentRow?.body);
    check('and marked as successfully sent', sentRow?.deliveryStatus === 'sent', sentRow?.deliveryStatus);

    // Test 6 -- a duplicate Slack event (a retry) does not send a second SMS
    const sendsAfterSend = twilioSends.length;
    r = await threadSay(convoA.slackThreadTs, `@send ${exactWords}`, 'EvSend1');
    check('the replayed Slack event still answers 200', r.status === 200);
    check('no second SMS was sent for the replayed event', twilioSends.length === sendsAfterSend, twilioSends.length);

    // Test 6b -- a closed task refuses everything, quietly and once
    r = await threadSay(convoA.slackThreadTs, '@accept', 'EvAfterClose');
    check('a command on a closed task is refused', /closed/i.test(lastPost()?.text || ''), lastPost()?.text);
    check('and sends nothing', twilioSends.length === sendsAfterSend, twilioSends.length);

    // Test 7 -- a bot-authored message (our own card, draft, or confirmation)
    // must never be read back as a command.
    const sendsBeforeBot = twilioSends.length;
    r = await postSlackEvent({
      type: 'event_callback', event_id: 'EvBot1',
      event: {
        type: 'message', channel: 'CSMSBRIDGE', bot_id: 'B0BOTOWN',
        text: '@send this looks like a command but we posted it ourselves',
        ts: '1700000200.000200', thread_ts: convoA.slackThreadTs,
      },
    });
    check('a bot-authored event is accepted without error', r.status === 200);
    check('a bot message never triggers an SMS (loop prevention)', twilioSends.length === sendsBeforeBot, twilioSends.length);

    // Test 8 -- a command in a thread this bridge never opened does nothing
    const sendsBeforeUnknown = twilioSends.length;
    r = await threadSay('9999999999.000000', '@accept', 'EvUnknownThread1');
    check('an unrecognised thread is accepted without error', r.status === 200);
    check('no SMS is sent for a thread with no matching task', twilioSends.length === sendsBeforeUnknown, twilioSends.length);

    // Test 9 -- a Twilio failure leaves the task open, never silently closed
    await threadSay(convoB.slackThreadTs, '@accept', 'EvBAccept');
    await threadSay(convoB.slackThreadTs, '@assign <@U0DEV0002>', 'EvBAssign');
    check('customer B has a task assigned and ready to send', (await taskFor(convoB.id))?.state === 'ASSIGNED');

    twilioShouldFail = true;
    const sendsBeforeFailure = twilioSends.length;
    r = await threadSay(convoB.slackThreadTs, '@send This one will fail to send.', 'EvBSend');
    twilioShouldFail = false;
    check('the Slack event is still accepted even though the send failed', r.status === 200);
    check('Twilio was actually attempted', twilioSends.length === sendsBeforeFailure + 1, twilioSends.length);
    check('the failed attempt was addressed to customer B, never customer A',
      twilioSends[twilioSends.length - 1]?.to === customerB, twilioSends[twilioSends.length - 1]?.to);
    const failedRow = (await db.all('sms_messages'))
      .filter((m) => m.direction === 'outbound' && m.toNumber === customerB)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    check('the failed send was recorded, not lost', Boolean(failedRow), JSON.stringify(failedRow));
    check('it is marked failed rather than reported as sent', failedRow?.deliveryStatus === 'failed', failedRow?.deliveryStatus);
    check('and carries no Twilio SID, since none was ever issued', !failedRow?.providerSid, failedRow?.providerSid);
    const taskBAfterFailure = await taskFor(convoB.id);
    check('a task whose send failed stays open for somebody to notice',
      taskBAfterFailure?.state === 'ASSIGNED', taskBAfterFailure?.state);
    check('and the thread says so', /did not send/i.test(lastPost()?.text || ''), lastPost()?.text);

    // Test 9b -- a bare @send with no drafting configured declines cleanly
    // rather than inventing something to tell a customer.
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const sendsBeforeDraft = twilioSends.length;
    r = await threadSay(convoB.slackThreadTs, '@send', 'EvBDraft');
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    check('a bare @send with no drafting available sends nothing',
      twilioSends.length === sendsBeforeDraft, twilioSends.length);
    check('and explains how to send your own words instead',
      /@send <text>/.test(lastPost()?.text || ''), lastPost()?.text);
    check('the task is still open after a declined draft', (await taskFor(convoB.id))?.state === 'ASSIGNED');

    // Test 9c -- Slack is answered before the work runs.
    //
    // Slack retires a Request URL that misses its three-second deadline, and a
    // bare @send cannot meet it. So the route claims the event id, replies, and
    // works afterwards. Held to a much tighter bound than three seconds here
    // because the reply must not be waiting on anything at all.
    {
      const raw = JSON.stringify({
        type: 'event_callback',
        event_id: 'EvAckSpeed',
        event: {
          type: 'message', channel: 'CSMSBRIDGE', user: 'U_STAFF_1',
          text: 'just talking, not a command', ts: '1700000900.000100',
          thread_ts: convoB.slackThreadTs,
        },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const startedAt = Date.now();
      const res = await fetch(`${base}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Slack-Signature': slackSignature(raw, timestamp),
          'X-Slack-Request-Timestamp': timestamp,
        },
        body: raw,
      });
      const ackMs = Date.now() - startedAt;
      check('Slack is acknowledged with a 200', res.status === 200, res.status);
      check('and acknowledged promptly, not after the work', ackMs < 1500, `${ackMs}ms`);
      await require('../routes/slackEvents').whenIdle();
    }

    // Test 9d -- a channel configured by name still matches inbound events.
    //
    // chat.postMessage takes a name or an id; an event only ever carries an id.
    // Configuring the name used to post cards fine and then silently drop every
    // command typed in their threads, because the raw setting was compared
    // against event.channel. The resolver is what closes that.
    {
      const tasksModule = require('../utils/smsTasks');
      process.env.SMS_SLACK_CHANNEL = '#client-sms';
      const resolved = await tasksModule.channelId();
      check('a channel written as a name resolves to its id', resolved === 'CSMSBRIDGE', resolved);

      process.env.SMS_SLACK_CHANNEL = 'CSMSBRIDGE';
      check('and an id is passed through untouched',
        (await tasksModule.channelId()) === 'CSMSBRIDGE');

      process.env.SMS_SLACK_CHANNEL = '#no-such-channel';
      check('a name matching nothing resolves to nothing rather than a wrong guess',
        (await tasksModule.channelId()) === null);
      process.env.SMS_SLACK_CHANNEL = 'CSMSBRIDGE';
    }

    // Test 9e -- two admins typing @send at the same moment send one text.
    //
    // Two Slack events, two ids, so the retry ledger has no reason to connect
    // them; and the gap between reading sent_at and writing it is a thread
    // fetch plus a draft. Only the claim makes this one text.
    {
      const customerC = '+15551230009';
      r = await postTwilioWebhook({
        MessageSid: 'SMinboundRace', From: customerC, To: process.env.TWILIO_NUMBER,
        Body: 'Two people are about to close this at once.', NumMedia: '0',
      });
      check('the race fixture texted in cleanly', r.status === 200, r.status);

      const raceConvo = (await db.filter('sms_conversations', (c) => c.phoneNumber === customerC))[0];
      const convoC = raceConvo;
      await threadSay(raceConvo.slackThreadTs, '@accept', 'EvRaceAccept');
      await threadSay(raceConvo.slackThreadTs, '@assign <@U0DEV0001>', 'EvRaceAssign');
      const raceTask = await taskFor(convoC.id);
      check('the race fixture is assigned and ready to send', raceTask?.state === 'ASSIGNED', raceTask?.state);

      const sendsBeforeRace = twilioSends.length;
      await Promise.all([
        threadSay(raceConvo.slackThreadTs, '@send First admin closing this.', 'EvRaceSend1'),
        threadSay(raceConvo.slackThreadTs, '@send Second admin closing this.', 'EvRaceSend2'),
      ]);
      await require('../routes/slackEvents').whenIdle();

      check('two simultaneous @sends produce exactly one text',
        twilioSends.length === sendsBeforeRace + 1, twilioSends.length - sendsBeforeRace);
      check('and the loser is told it did nothing',
        slackPosts.some((p) => /already sending/i.test(p.text || '')),
        slackPosts.slice(-4).map((p) => p.text).join(' | '));
      check('the task closed once', (await taskFor(convoC.id))?.state === 'CLOSED');
    }

    // Test 9f -- an id that is already taken is a conflict, on either driver.
    //
    // The Slack retry ledger is built on a failed insert, not on a returned
    // value. The Firestore driver used to `set` here, which overwrote the
    // ledger row and let the retry go on to send a second text.
    {
      const ledgerId = `EvLedger-${Date.now()}`;
      await db.insert('slack_events', { id: ledgerId, processedAt: new Date().toISOString() });
      let conflict = null;
      try {
        await db.insert('slack_events', { id: ledgerId, processedAt: new Date().toISOString() });
      } catch (err) {
        conflict = err;
      }
      check('inserting a duplicate id throws', Boolean(conflict), 'no error thrown');
      check('and reports the unique-violation code the retry guard checks for',
        conflict?.code === '23505', conflict?.code);
    }

    // Test 9g -- only staff can work a task.
    //
    // Slack channels hold contractors, clients and guests, and @send reaches a
    // phone outside the company. Being able to see the thread is not authority
    // to close it.
    {
      const customerD = '+15551230011';
      r = await postTwilioWebhook({
        MessageSid: 'SMinboundAuthz', From: customerD, To: process.env.TWILIO_NUMBER,
        Body: 'Who is allowed to answer this?', NumMedia: '0',
      });
      const authzConvo = (await db.filter('sms_conversations', (c) => c.phoneNumber === customerD))[0];

      const sendsBeforeAuthz = twilioSends.length;

      // The employee behind U0DEV0002 in the directory stub above.
      r = await admin.req('POST', '/api/users', {
        name: 'SMS Employee', email: 'sms.employee@ethixweb.local', role: 'employee',
      });
      check('the employee fixture was created', r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);

      // An employee is staff, but not staff who closes customer tasks.
      r = await threadSay(authzConvo.slackThreadTs, '@accept', 'EvAuthzEmployee', 'U0DEV0002');
      check('an employee cannot claim a customer task',
        (await taskFor(authzConvo.id))?.state === 'NEW', (await taskFor(authzConvo.id))?.state);
      check('and is told why', /admins and project managers/i.test(lastPost()?.text || ''), lastPost()?.text);

      // A guest with no email is exactly what a workspace missing the
      // users:read.email scope looks like: unidentifiable, so refused.
      r = await threadSay(authzConvo.slackThreadTs, '@accept', 'EvAuthzGuest', 'U_GUEST');
      check('somebody we cannot identify cannot claim a task',
        (await taskFor(authzConvo.id))?.state === 'NEW');
      check('and the refusal says how an admin fixes it',
        /users:read\.email|SMS_TASK_OPERATORS/.test(lastPost()?.text || ''), lastPost()?.text);

      // Nobody unauthorised got anywhere near Twilio.
      check('no refused command sent anything', twilioSends.length === sendsBeforeAuthz, twilioSends.length);

      // A project manager is.
      r = await threadSay(authzConvo.slackThreadTs, '@accept', 'EvAuthzPm', 'U0DEV0001');
      check('a project manager can claim a task', (await taskFor(authzConvo.id))?.state === 'ACCEPTED');

      // The explicit allowlist is the other way to answer, and needs no scope.
      process.env.SMS_TASK_OPERATORS = 'U_GUEST';
      r = await threadSay(authzConvo.slackThreadTs, '@assign <@U0DEV0002>', 'EvAuthzListAdmin', 'U_STAFF_1');
      check('with an allowlist set, an admin who is not on it is refused',
        (await taskFor(authzConvo.id))?.state === 'ACCEPTED');
      check('and is pointed at the allowlist',
        /SMS_TASK_OPERATORS/.test(lastPost()?.text || ''), lastPost()?.text);

      r = await threadSay(authzConvo.slackThreadTs, '@assign <@U0DEV0002>', 'EvAuthzListGuest', 'U_GUEST');
      check('and somebody on the allowlist is allowed, with no directory lookup',
        (await taskFor(authzConvo.id))?.state === 'ASSIGNED');
      delete process.env.SMS_TASK_OPERATORS;
    }

    // Test 9h -- the subtypes that are still a person typing.
    //
    // "Also send to channel" and a screenshot with the command as its comment
    // are both ordinary ways to work a task, and both used to do nothing.
    {
      const customerE = '+15551230012';
      r = await postTwilioWebhook({
        MessageSid: 'SMinboundSubtype', From: customerE, To: process.env.TWILIO_NUMBER,
        Body: 'Testing how the command was typed.', NumMedia: '0',
      });
      const subConvo = (await db.filter('sms_conversations', (c) => c.phoneNumber === customerE))[0];

      async function subtypeSay(subtype, text, eventId, extra = {}) {
        return postSlackEvent({
          type: 'event_callback',
          event_id: eventId,
          event: {
            type: 'message', subtype, channel: 'CSMSBRIDGE', user: 'U_STAFF_1', text,
            ts: `17000007${String(eventId.length).padStart(2, '0')}.000100`,
            thread_ts: subConvo.slackThreadTs,
            ...extra,
          },
        });
      }

      await subtypeSay('thread_broadcast', '@accept', 'EvSubBroadcast');
      check('a command sent with "Also send to channel" still runs',
        (await taskFor(subConvo.id))?.state === 'ACCEPTED', (await taskFor(subConvo.id))?.state);

      await subtypeSay('file_share', '@assign <@U0DEV0001>', 'EvSubFile', { files: [{ id: 'F1' }] });
      check('a command typed as a file comment still runs',
        (await taskFor(subConvo.id))?.state === 'ASSIGNED', (await taskFor(subConvo.id))?.state);

      const sendsBeforeEdit = twilioSends.length;
      await subtypeSay('message_changed', '@send Edited into existence.', 'EvSubEdited');
      check('an edited message is still not a command', twilioSends.length === sendsBeforeEdit);
      check('and the task is untouched by it', (await taskFor(subConvo.id))?.state === 'ASSIGNED');
    }

    // Test 9i -- how people actually type the commands.
    {
      const p = require('../routes/slackEvents').parseCommand;

      check('the bot being addressed first still parses',
        p('<@UBOT123> @accept')?.name === 'accept', JSON.stringify(p('<@UBOT123> @accept')));
      check('and with a comma after the mention, as Slack often leaves it',
        p('<@UBOT123>, @send Done.')?.name === 'send');
      check('the past tense in our own docs parses', p('@accepted')?.name === 'accept');
      check('@assigned parses too', p('@assigned <@U0DEV0001>')?.userId === 'U0DEV0001');
      check('@sent parses too', p('@sent')?.name === 'send');

      // The one that would have texted a customer a full stop.
      check('@send. is a draft request, not an override of "."',
        p('@send.')?.name === 'send' && p('@send.').override === null,
        JSON.stringify(p('@send.')));
      check('but real words after @send are still an override',
        p('@send All fixed, thanks!')?.override === 'All fixed, thanks!');
      check('@assign still finds the person named after it',
        p('@assign <@U0DEV0001|ryan>')?.userId === 'U0DEV0001');

      check('a near miss is recognised as one', p('@approved')?.name === 'unknown');
      check('and carries the word that was typed', p('@approved')?.word === 'approved');
      check('a person being mentioned by a name Slack could not resolve is left alone',
        p('@priya can you look at this') === null);
      check('and ordinary conversation is still ordinary', p('all done on my side') === null);
    }

    // The near-miss reply reaches the thread, once, and changes nothing.
    {
      const customerF = '+15551230013';
      r = await postTwilioWebhook({
        MessageSid: 'SMinboundNearMiss', From: customerF, To: process.env.TWILIO_NUMBER,
        Body: 'Testing a mistyped command.', NumMedia: '0',
      });
      const nmConvo = (await db.filter('sms_conversations', (c) => c.phoneNumber === customerF))[0];

      await threadSay(nmConvo.slackThreadTs, '@approve', 'EvNearMiss');
      check('a near miss is answered with the usage line',
        /not a command/i.test(lastPost()?.text || '') && /@accept/.test(lastPost()?.text || ''),
        lastPost()?.text);
      check('and the task is unchanged', (await taskFor(nmConvo.id))?.state === 'NEW');

      const postsBeforeChatter = slackPosts.length;
      await threadSay(nmConvo.slackThreadTs, '@priya can you take a look', 'EvChatter');
      check('but ordinary talk gets no reply at all', slackPosts.length === postsBeforeChatter);
    }

    // Test 9j -- Twilio accepting a message is not the handset receiving it.
    //
    // A carrier rejection lands seconds or minutes after @send has already
    // closed the card. The work is done, the customer does not know, and the
    // card is the only place anybody would find that out.
    {
      async function postStatus(fields) {
        const url = `${base}/api/sms/status`;
        const sig = twilioSignature(url, fields);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig },
          body: new URLSearchParams(fields).toString(),
        });
        return { status: res.status, text: await res.text() };
      }

      const customerG = '+15551230014';
      r = await postTwilioWebhook({
        MessageSid: 'SMinboundDelivery', From: customerG, To: process.env.TWILIO_NUMBER,
        Body: 'Does the completion actually arrive?', NumMedia: '0',
      });
      const delConvo = (await db.filter('sms_conversations', (c) => c.phoneNumber === customerG))[0];

      await threadSay(delConvo.slackThreadTs, '@accept', 'EvDelAccept');
      await threadSay(delConvo.slackThreadTs, '@assign <@U0DEV0001>', 'EvDelAssign');
      await threadSay(delConvo.slackThreadTs, '@send All sorted, thanks for waiting.', 'EvDelSend');

      let delTask = await taskFor(delConvo.id);
      check('the task closed on Twilio accepting the message', delTask?.state === 'CLOSED', delTask?.state);
      check('and remembered which message it closed on', Boolean(delTask?.sentSid), delTask?.sentSid);

      // An interim status is recorded and changes nothing else.
      r = await postStatus({ MessageSid: delTask.sentSid, MessageStatus: 'sent' });
      check('an interim status callback is accepted', r.status === 204, r.status);
      check('and leaves the closed task alone', (await taskFor(delConvo.id))?.state === 'CLOSED');

      // The carrier gives up. This is the case that used to vanish.
      r = await postStatus({ MessageSid: delTask.sentSid, MessageStatus: 'undelivered', ErrorCode: '30005' });
      check('a terminal failure callback is accepted', r.status === 204, r.status);

      const outbound = (await db.filter('sms_messages', (m) => m.providerSid === delTask.sentSid))[0];
      check('the message is no longer recorded as sent', outbound?.deliveryStatus === 'undelivered', outbound?.deliveryStatus);
      check('and says why in words, not a code',
        /number does not exist/i.test(outbound?.deliveryError || ''), outbound?.deliveryError);

      delTask = await taskFor(delConvo.id);
      check('the task is open again', delTask?.state === 'ASSIGNED', delTask?.state);
      check('and can be sent again, because the claim went back', !delTask?.sentAt, delTask?.sentAt);
      check('the thread says the customer never got it',
        /never reached/i.test(lastPost()?.text || ''), lastPost()?.text);
      check('and the card was repainted to say so',
        /never reached them/i.test(slackUpdates[slackUpdates.length - 1]?.text || ''),
        slackUpdates[slackUpdates.length - 1]?.text);

      // Unsigned callbacks are somebody else's traffic.
      const forged = await fetch(`${base}/api/sms/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'v0=nope' },
        body: new URLSearchParams({ MessageSid: delTask.sentSid, MessageStatus: 'delivered' }).toString(),
      });
      check('an unsigned status callback is refused', forged.status === 403, forged.status);
    }

    // Test 9k -- a command whose card edit failed still says something.
    //
    // The card rewriting itself is the acknowledgement. When Slack refuses the
    // edit the card is stale *and* silent, and the person who typed @accept sees
    // nothing at all and types it again.
    {
      const customerH = '+15551230015';
      r = await postTwilioWebhook({
        MessageSid: 'SMinboundSilent', From: customerH, To: process.env.TWILIO_NUMBER,
        Body: 'What happens when the card will not update?', NumMedia: '0',
      });
      const silentConvo = (await db.filter('sms_conversations', (c) => c.phoneNumber === customerH))[0];

      slackUpdateShouldFail = true;
      await threadSay(silentConvo.slackThreadTs, '@accept', 'EvSilentAccept');
      slackUpdateShouldFail = false;

      check('the task still changed state', (await taskFor(silentConvo.id))?.state === 'ACCEPTED');
      check('and the thread says so instead of the card',
        /claimed by/i.test(lastPost()?.text || ''), lastPost()?.text);
      check('and admits the card is stale',
        /could not be updated/i.test(lastPost()?.text || ''), lastPost()?.text);

      // With the edit working again, a command says nothing: the card speaks.
      const postsBeforeQuiet = slackPosts.length;
      await threadSay(silentConvo.slackThreadTs, '@assign <@U0DEV0001>', 'EvSilentAssign');
      check('a command whose card edit worked stays quiet',
        slackPosts.length === postsBeforeQuiet, lastPost()?.text);
      check('but still took effect', (await taskFor(silentConvo.id))?.state === 'ASSIGNED');
    }

    // Test 9l -- the bridge says whether it can actually do its job.
    {
      const preflight = require('../utils/smsBridgePreflight');
      let report = await preflight.check();
      check('the preflight runs and reports every part',
        Array.isArray(report.checks) && report.checks.length >= 6, report.checks?.length);
      // Not asserting report.ok: this suite deliberately runs without an
      // Anthropic key, and the preflight is right to say so. What matters is
      // that the parts that *are* configured come back healthy.
      const named = (name) => report.checks.find((c) => c.name === name);
      check('Slack is reported connected', named('Slack connection')?.ok === true);
      check('the task channel is reported healthy', named('Task channel')?.ok === true,
        named('Task channel')?.detail);
      check('and it knows who may work a task', named('Who may work a task')?.ok === true,
        named('Who may work a task')?.detail);
      check('the missing drafting key is reported as a problem',
        named('Drafting the completion')?.ok === false,
        named('Drafting the completion')?.detail);

      // The failure everybody actually hits: the bot is not in the channel.
      const cache = require('../utils/integrationCache');
      const savedChannel = process.env.SMS_SLACK_CHANNEL;
      process.env.SMS_SLACK_CHANNEL = 'CNOTAMEMBER';
      cache.invalidate('slack:');
      report = await preflight.check();
      check('a channel the bot cannot see is reported, not swallowed',
        report.ok === false && report.problems.some((p) => p.name === 'Task channel'),
        JSON.stringify(report.problems.map((p) => p.name)));
      check('and the report says how to fix it',
        report.problems.some((p) => /invite/i.test(p.fix || '') || /invite/i.test(p.detail || '')),
        JSON.stringify(report.problems));

      process.env.SMS_SLACK_CHANNEL = savedChannel;
      cache.invalidate('slack:');

      // And an admin can read the same report without going to the server log.
      r = await admin.req('GET', '/api/integrations/sms-bridge/health');
      check('an admin can read the bridge health', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
      check('and it comes back with the checks', Array.isArray(r.data.checks), r.text.slice(0, 160));
    }

    // Test 9m -- Firestore has no UNIQUE columns, so it is given some.
    //
    // Postgres enforces these itself; Firestore cannot, and several callers in
    // this codebase treat a rejected insert as a guarantee rather than an error.
    // The test that matters most is the drift one: a UNIQUE column added to the
    // Postgres schema and forgotten here is silently unenforced on the other
    // driver, which is exactly how provider_sid came to be unprotected.
    {
      const fs = require('fs');
      const schemas = require('../db/schemas');
      const firestore = require('../db/firestore');

      const setupSql = fs.readFileSync(require('path').join(__dirname, '..', 'db', 'setup.js'), 'utf8');
      const declared = {};
      for (const block of setupSql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\)`/g)) {
        const [, table, columns] = block;
        for (const col of columns.matchAll(/(\w+) +[A-Z]+(?:\(\d+\))? +UNIQUE/g)) {
          (declared[table] ||= []).push(schemas.toCamel(col[1]));
        }
      }

      const missing = [];
      for (const [table, columns] of Object.entries(declared)) {
        for (const column of columns) {
          if (!schemas.uniqueFields(table).includes(column)) missing.push(`${table}.${column}`);
        }
      }

      check('every UNIQUE column in the Postgres schema is declared for Firestore too',
        missing.length === 0, missing.join(', '));
      check('and the one the Twilio retry guard depends on is among them',
        schemas.uniqueFields('sms_messages').includes('providerSid'));
      check('as is the one the conversation guard depends on',
        schemas.uniqueFields('sms_conversations').includes('phoneNumber'));

      // A value is reserved by encoding it into a document id, which is the
      // only uniqueness Firestore actually offers.
      const a = firestore.reservationId('sms_messages', 'providerSid', 'SM123');
      const b = firestore.reservationId('sms_messages', 'providerSid', 'SM124');
      check('two values reserve two different ids', a !== b);
      check('the same value reserves the same id every time',
        a === firestore.reservationId('sms_messages', 'providerSid', 'SM123'));
      check('and the id is safe to use as a Firestore document id',
        !/[/\s]/.test(a) && a.length < 1500, a);

      // NULL is not a value two rows can share -- same as Postgres.
      check('a null unique field reserves nothing',
        firestore.reservationsFor('sms_messages', { providerSid: null }).length === 0);
      check('an absent one reserves nothing either',
        firestore.reservationsFor('sms_messages', { body: 'hi' }).length === 0);
      check('but a real one does',
        firestore.reservationsFor('sms_messages', { providerSid: 'SM9' }).length === 1);
    }

    // Test 10 -- a Slack outage during inbound intake must not lose the SMS
    const realNotifySlack = require('../utils/slack').notifySlack;
    require('../utils/slack').notifySlack = async () => { throw new Error('Slack is down'); };
    const beforeSlackDown = (await db.all('sms_messages')).length;
    r = await postTwilioWebhook({
      MessageSid: 'SMinboundC1', From: '+15551230003', To: process.env.TWILIO_NUMBER,
      Body: 'Testing while Slack is unreachable', NumMedia: '0',
    });
    require('../utils/slack').notifySlack = realNotifySlack;
    check('the webhook still answers cleanly while Slack is down', r.status === 200, r.status);
    const afterSlackDown = await db.all('sms_messages');
    check('the inbound text was still saved despite the Slack outage', afterSlackDown.length === beforeSlackDown + 1);
    check('and it is exactly the message that came in', afterSlackDown.some((m) => m.providerSid === 'SMinboundC1'));

    // A dashboard-typed reply is a second way to reply, and echoes into the
    // same Slack thread a Slack-typed reply would use.
    const postsBeforeDashboardReply = slackPosts.length;
    r = await admin.req('POST', `/api/sms/${rowA1.id}/reply`, { body: 'Reply typed from the dashboard' });
    check('a dashboard reply still sends and records normally', r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
    check('a dashboard reply is echoed into the customer\'s Slack thread',
      slackPosts.length === postsBeforeDashboardReply + 1 && slackPosts[slackPosts.length - 1].thread_ts === convoA.slackThreadTs);

    // --- broadcast: one message, a chosen list of clients ------------------
    {
      async function makeClientWithPhone(name, email, phone) {
        const created = await admin.req('POST', '/api/users', { name, email, role: 'client' });
        const id = created.data.user.id;
        // No API sets a client's phone directly (it is only ever backfilled by
        // linking an inbound text) -- write it straight to the row, the same
        // way the rest of this suite reaches state nothing exposes a route for.
        if (phone) await db.update('users', id, { phone });
        return id;
      }

      const bc1 = await makeClientWithPhone('Broadcast One', 'broadcast1@example.com', '+15559990001');
      const bc2 = await makeClientWithPhone('Broadcast Two', 'broadcast2@example.com', '+15559990002');
      const bc3 = await makeClientWithPhone('Broadcast Three (no phone)', 'broadcast3@example.com', null);

      const messagesBeforeBroadcast = (await db.all('sms_messages')).length;
      r = await admin.req('POST', '/api/sms/broadcast', {
        body: 'Scheduled maintenance tonight, expect brief downtime.',
        clientIds: [bc1, bc2, bc3],
      });
      check('the broadcast is accepted', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
      check('it reports one result per recipient', (r.data.results || []).length === 3, JSON.stringify(r.data.results));

      const resultFor = (id) => (r.data.results || []).find((x) => x.clientId === id);
      check('the two clients with phones are marked sent', resultFor(bc1)?.status === 'sent' && resultFor(bc2)?.status === 'sent');
      check('the client with no phone is marked failed, not silently dropped', resultFor(bc3)?.status === 'failed');
      check('and it says why', /phone/i.test(resultFor(bc3)?.error || ''), resultFor(bc3)?.error);

      const messagesAfterBroadcast = await db.all('sms_messages');
      check('exactly two outbound messages were created (the recipient with no phone sent nothing)',
        messagesAfterBroadcast.length === messagesBeforeBroadcast + 2, `${messagesAfterBroadcast.length - messagesBeforeBroadcast}`);

      const broadcastRows = messagesAfterBroadcast.filter((m) => m.broadcastId === r.data.broadcastId);
      check('both sent messages are tagged with the same broadcast id', broadcastRows.length === 2, broadcastRows.length);
      check('each is a normal outbound message, not a group text', broadcastRows.every((m) => m.direction === 'outbound' && m.channel === 'sms'));

      const broadcastRow = (await db.filter('sms_broadcasts', (b) => b.id === r.data.broadcastId))[0];
      check('the batch itself was recorded', Boolean(broadcastRow), JSON.stringify(broadcastRow));
      check('with the full recipient count, including the one that failed', broadcastRow?.recipientCount === 3, broadcastRow?.recipientCount);

      // A Twilio failure for one recipient must not stop the other from sending.
      const bc4 = await makeClientWithPhone('Broadcast Four', 'broadcast4@example.com', '+15559990004');
      const bc5 = await makeClientWithPhone('Broadcast Five (will fail)', 'broadcast5@example.com', '+15559990005');
      twilioFailForNumber = '+15559990005';
      r = await admin.req('POST', '/api/sms/broadcast', {
        body: 'Second batch, one bad number in the middle of it.',
        clientIds: [bc4, bc5],
      });
      twilioFailForNumber = null;
      check('the batch with a failing recipient is still accepted', r.status === 201, r.status);
      check('the good recipient still sent despite the other failing',
        resultFor(bc4)?.status === 'sent', JSON.stringify(resultFor(bc4)));
      check('the bad recipient is recorded as failed, not silently skipped',
        resultFor(bc5)?.status === 'failed', JSON.stringify(resultFor(bc5)));
      const failedBroadcastRow = (await db.all('sms_messages')).find((m) => m.toNumber === '+15559990005' && m.broadcastId === r.data.broadcastId);
      check('the failed send is a real row with a failed delivery status, not missing',
        failedBroadcastRow?.deliveryStatus === 'failed', JSON.stringify(failedBroadcastRow));

      // Only admin/sales/project_manager may send one at all.
      r = await client.req('POST', '/api/sms/broadcast', { body: 'Should never send.', clientIds: [bc1] });
      check('a client account is refused', r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);
    }

    global.fetch = realFetch;
    for (const key of [
      'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER', 'TWILIO_WEBHOOK_URL',
      'SMS_OUTBOUND_ENABLED', 'SMS_SLACK_CHANNEL', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET',
    ]) delete process.env[key];
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
