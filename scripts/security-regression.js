'use strict';

/*
 * Admin security regression suite.
 *
 * Every check in here started life as a confirmed exploit from the August 2026
 * admin security audit. Each one asserts the *secure* behaviour, so running
 * this file against the pre-remediation code fails loudly, and running it
 * afterwards is the proof the boundary holds.
 *
 * Three things are asserted for every boundary, not just the first:
 *
 *   EXPLOIT              -> blocked
 *   UNAUTHORIZED REQUEST -> denied
 *   AUTHORIZED REQUEST   -> still works
 *
 * Runs against an in-memory Postgres, like the other suites:
 *   npm run test:security
 */

process.env.MAIL_BRAND_NAME = 'EthixWeb';
// Deliberately NOT setting APP_BASE_URL: one of the findings is about what the
// app does when it is missing.
delete process.env.APP_BASE_URL;

const app = require('../server');
const { db } = require('../db/setup');
const { decryptCode } = require('../utils/otpCrypto');
const appUrl = require('../utils/appUrl');
const approvals = require('../utils/approvals');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    failures.push(label);
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
    get csrf() { return csrf; },
    get sid() { return jar.get('ew_sid'); },
    async req(method, path, body, extraHeaders = {}) {
      const headers = { 'Content-Type': 'application/json', ...extraHeaders };
      if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
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
    /** Multipart upload, for the report tests. */
    async upload(path, { filename, mimeType, content, fields = {} }) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append('file', new Blob([content], { type: mimeType }), filename);
      const headers = {};
      if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const res = await fetch(base + path, { method: 'POST', headers, body: form });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, text };
    },
  };
}

/** The newest live code for an account, read the way the server stores it. */
async function latestCodeFor(email) {
  const users = await db.filter('users', (u) => String(u.email).toLowerCase() === email.toLowerCase());
  const user = users[0];
  if (!user) return null;
  const otps = await db.filter('otp_codes', (o) => o.userId === user.id && !o.consumed);
  const otp = otps.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  return otp ? decryptCode(otp.code) : null;
}

/**
 * Sign in and finish whatever second step the server asks for. Works before
 * and after the remediation, so the same helper proves both states.
 */
async function loginAs(client, email, password) {
  let r = await client.req('POST', '/api/auth/login', { email, password });
  if (r.status !== 200) return { ok: false, first: r };
  const first = r;
  client.setCsrf(r.data.csrfToken);
  if (r.data.requiresOtp) {
    const code = await latestCodeFor(email);
    r = await client.req('POST', '/api/auth/verify-otp', { code });
    if (r.status !== 200) return { ok: false, first, second: r };
    client.setCsrf(r.data.csrfToken);
  }
  return { ok: true, first, second: r };
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const superAdmin = makeClient(base);   // admin@ethixweb.local, isSuperAdmin
  const trusted = makeClient(base);      // admin, adminTrusted, NOT super
  const untrusted = makeClient(base);    // admin, brand new -- Priya from the seed
  const employee = makeClient(base);     // lowest staff role
  const client = makeClient(base);       // a client account

  // ---------------------------------------------------------------- set-up --
  section('Set-up');

  let login = await loginAs(superAdmin, 'admin@ethixweb.local', 'Admin#2026!');
  check('super admin can sign in', login.ok, JSON.stringify(login.second?.data || login.first?.data).slice(0, 200));
  const superMe = (await superAdmin.req('GET', '/api/auth/me')).data;
  check('super admin has the super-admin capability', superMe.capabilities?.isSuperAdmin === true);

  // A trusted-but-not-super admin, created the legitimate way.
  let r = await superAdmin.req('POST', '/api/users', {
    name: 'Trusted Admin', email: 'trusted.admin@ethixweb.local', role: 'admin', password: 'Trusted#2026!',
  });
  check('AUTHORIZED: super admin can appoint an administrator', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
  const trustedId = r.data.user?.id;
  r = await superAdmin.req('POST', `/api/users/${trustedId}/standing`, { trusted: true });
  check('AUTHORIZED: super admin can vouch for an admin', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);

  login = await loginAs(trusted, 'trusted.admin@ethixweb.local', 'Trusted#2026!');
  check('trusted admin can sign in', login.ok);
  login = await loginAs(untrusted, 'priya.nair@ethixweb.local', 'Admin#2026!');
  check('untrusted admin can sign in', login.ok);
  login = await loginAs(employee, 'jordan.brooks@ethixweb.local', 'Staff#2026!');
  check('employee can sign in', login.ok);
  login = await loginAs(client, 'client@brightpath-retail.com', 'Client#2026!');
  check('client can sign in', login.ok);

  const trustedMe = (await trusted.req('GET', '/api/auth/me')).data;
  const untrustedMe = (await untrusted.req('GET', '/api/auth/me')).data;
  const clientMe = (await client.req('GET', '/api/auth/me')).data;
  const untrustedId = untrustedMe.user.id;
  const clientId = clientMe.user.id;
  check('trusted admin is not a super admin', trustedMe.capabilities?.isSuperAdmin === false);
  check('untrusted admin needs approval', untrustedMe.capabilities?.needsApproval === true);

  // ------------------------------------------------- F4 / F14: login flow --
  section('Findings 4 and 14 -- admin authentication');

  const probeAdmin = makeClient(base);
  r = await probeAdmin.req('POST', '/api/auth/login', { email: 'admin@ethixweb.local', password: 'Admin#2026!' });
  check('EXPLOIT BLOCKED: an admin password alone does not open a session',
    r.status === 200 && r.data.requiresOtp === true && !r.data.user,
    `${r.status} ${r.text.slice(0, 200)}`);

  const probeClient = makeClient(base);
  const clientFirst = await probeClient.req('POST', '/api/auth/login', { email: 'client@brightpath-retail.com', password: 'Client#2026!' });
  check('an admin login response is indistinguishable from a client one',
    Object.keys(r.data).sort().join(',') === Object.keys(clientFirst.data).sort().join(','),
    `${Object.keys(r.data).sort().join(',')} vs ${Object.keys(clientFirst.data).sort().join(',')}`);

  // F11 -- the session identifier must be replaced when the code is accepted.
  const sidBefore = probeAdmin.sid;
  probeAdmin.setCsrf(r.data.csrfToken);
  const code = await latestCodeFor('admin@ethixweb.local');
  r = await probeAdmin.req('POST', '/api/auth/verify-otp', { code });
  check('AUTHORIZED: the emailed code completes an admin sign-in', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  check('EXPLOIT BLOCKED: the session identifier is replaced at the moment access is granted',
    Boolean(sidBefore) && probeAdmin.sid !== sidBefore,
    `${String(sidBefore).slice(0, 12)} -> ${String(probeAdmin.sid).slice(0, 12)}`);
  const oldSession = makeClient(base);
  r = await fetch(`${base}/api/auth/me`, { headers: { Cookie: `ew_sid=${sidBefore}` } });
  check('UNAUTHORIZED: the pre-verification session identifier is dead', r.status === 401, String(r.status));

  // The two-step toggle must actually be read somewhere in the login path.
  r = await superAdmin.req('POST', '/api/users/me/2fa/disable');
  check('AUTHORIZED: the two-step toggle is writable', [200, 503].includes(r.status), `${r.status} ${r.text.slice(0, 160)}`);

  // ------------------------------------------- F1 / F2: privilege escalation --
  section('Findings 1 and 2 -- privilege escalation through the user editor');

  const escalationBodies = [
    ['camelCase isSuperAdmin', { isSuperAdmin: true }],
    ['snake_case is_super_admin', { is_super_admin: true }],
    ['camelCase adminTrusted', { adminTrusted: true }],
    ['snake_case admin_trusted', { admin_trusted: true }],
    ['a privilege flag hidden behind a harmless name change', { name: 'Trusted Admin', is_super_admin: true }],
  ];
  for (const [label, body] of escalationBodies) {
    r = await trusted.req('PUT', `/api/users/${trustedId}`, body);
    check(`EXPLOIT BLOCKED: trusted admin cannot self-promote via ${label}`,
      r.status === 400, `${r.status} ${r.text.slice(0, 160)}`);
  }
  const stillTrusted = (await trusted.req('GET', '/api/auth/me')).data;
  check('EXPLOIT BLOCKED: the escalation attempts left the actor unprivileged',
    stillTrusted.capabilities?.isSuperAdmin === false,
    JSON.stringify(stillTrusted.capabilities));

  // The same class, one rung lower: an untrusted admin must not be able to
  // park a privilege change in the approval queue either.
  for (const [label, body] of escalationBodies) {
    r = await untrusted.req('PUT', `/api/users/${untrustedId}`, body);
    check(`EXPLOIT BLOCKED: untrusted admin cannot queue a promotion via ${label}`,
      r.status === 400, `${r.status} ${r.text.slice(0, 200)}`);
  }
  const stillUntrusted = (await untrusted.req('GET', '/api/auth/me')).data;
  check('EXPLOIT BLOCKED: the queued-promotion attempts left the actor unprivileged',
    stillUntrusted.capabilities?.isSuperAdmin === false && stillUntrusted.capabilities?.needsApproval === true,
    JSON.stringify(stillUntrusted.capabilities));

  r = await untrusted.req('GET', '/api/approvals');
  const queuedUserUpdates = (r.data.requests || []).filter((q) => q.action === 'user.update' && q.status === 'pending');
  check('EXPLOIT BLOCKED: nothing privileged is sitting in the approval queue',
    queuedUserUpdates.every((q) => !JSON.stringify(q.payload || {}).match(/super|trusted/i)),
    JSON.stringify(queuedUserUpdates.map((q) => q.payload)).slice(0, 300));

  // The legitimate door still opens.
  r = await superAdmin.req('POST', `/api/users/${untrustedId}/standing`, { trusted: true });
  check('AUTHORIZED: a super admin can still change standing on the proper endpoint',
    r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  r = await superAdmin.req('POST', `/api/users/${untrustedId}/standing`, { trusted: false });
  check('AUTHORIZED: a super admin can take standing away again', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  r = await trusted.req('POST', `/api/users/${trustedId}/standing`, { superAdmin: true });
  check('UNAUTHORIZED: a trusted admin cannot use the standing endpoint',
    r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);

  // An ordinary edit still saves.
  r = await trusted.req('PUT', `/api/users/${clientId}`, { name: 'David Shaw' });
  check('AUTHORIZED: an ordinary detail change still saves', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);

  // ------------------------------------------------ F3: account takeover --
  section('Finding 3 -- resetting another administrator\'s password');

  const superAdminId = superMe.user.id;
  r = await trusted.req('PUT', `/api/users/${superAdminId}`, { regeneratePassword: true, sendEmail: false });
  check('EXPLOIT BLOCKED: a peer admin cannot reset the super admin\'s password',
    r.status === 403 && !r.data.temporaryPassword, `${r.status} ${r.text.slice(0, 200)}`);
  r = await trusted.req('PUT', `/api/users/${untrustedId}`, { regeneratePassword: true, sendEmail: false });
  check('EXPLOIT BLOCKED: a peer admin cannot reset another admin\'s password',
    r.status === 403 && !r.data.temporaryPassword, `${r.status} ${r.text.slice(0, 200)}`);
  r = await untrusted.req('PUT', `/api/users/${trustedId}`, { regeneratePassword: true, sendEmail: false });
  check('EXPLOIT BLOCKED: an untrusted admin cannot queue an admin password reset',
    r.status === 403, `${r.status} ${r.text.slice(0, 200)}`);

  r = await trusted.req('PUT', `/api/users/${clientId}`, { regeneratePassword: true, sendEmail: false });
  check('AUTHORIZED: an admin can still reset a client\'s password',
    r.status === 200 && Boolean(r.data.temporaryPassword), `${r.status} ${r.text.slice(0, 200)}`);
  const clientPassword = r.data.temporaryPassword;

  // A password change has to end the sessions that were opened with the old
  // one, or the reset is cosmetic.
  r = await client.req('GET', '/api/auth/me');
  check('AUTHORIZED: a password reset ends that account\'s existing sessions', r.status === 401, String(r.status));
  login = await loginAs(client, 'client@brightpath-retail.com', clientPassword);
  check('AUTHORIZED: the client signs back in with the new password', login.ok);

  r = await superAdmin.req('PUT', `/api/users/${trustedId}`, { regeneratePassword: true, sendEmail: false });
  check('AUTHORIZED: a super admin can still reset an administrator\'s password',
    r.status === 200 && Boolean(r.data.temporaryPassword), `${r.status} ${r.text.slice(0, 200)}`);
  const trustedPassword = r.data.temporaryPassword;
  // Put the trusted admin back on a known session for the rest of the suite.
  login = await loginAs(trusted, 'trusted.admin@ethixweb.local', trustedPassword);
  check('AUTHORIZED: the reset administrator can sign in with the new password', login.ok);

  // ---------------------------------------------------- F5: login codes --
  section('Finding 5 -- reading other people\'s login codes');

  // Give the client a live code to aim at.
  const codeProbe = makeClient(base);
  await codeProbe.req('POST', '/api/auth/login', { email: 'client@brightpath-retail.com', password: clientPassword });

  let logs = (await trusted.req('GET', '/api/auth/otp-logs')).data.logs || [];
  const clientRow = logs.find((l) => l.userId === clientId);
  const adminRow = logs.find((l) => l.userId === superAdminId);
  check('EXPLOIT BLOCKED: administrator sign-in codes are not listed at all',
    !adminRow, JSON.stringify(adminRow || {}).slice(0, 200));

  const untrustedLogs = (await untrusted.req('GET', '/api/auth/otp-logs')).data.logs || [];
  check('EXPLOIT BLOCKED: an untrusted admin does not get everyone\'s IP address',
    untrustedLogs.every((l) => !l.ipAddress || l.ipAddress === 'hidden'),
    JSON.stringify(untrustedLogs[0] || {}).slice(0, 200));

  if (clientRow) {
    r = await untrusted.req('POST', `/api/auth/otp-logs/${clientRow.id}/reveal`);
    check('EXPLOIT BLOCKED: an untrusted admin cannot reveal a live code',
      r.status === 403, `${r.status} ${r.text.slice(0, 200)}`);
    r = await trusted.req('POST', `/api/auth/otp-logs/${clientRow.id}/reveal`);
    check('AUTHORIZED: a trusted admin can still read a client code out to them',
      r.status === 200 && typeof r.data.code === 'string', `${r.status} ${r.text.slice(0, 200)}`);
  } else {
    check('a client login code row exists to test against', false, 'no client row in the log');
  }

  // An administrator's own code must be unreadable by anybody, including the owner.
  const adminOtps = await db.filter('otp_codes', (o) => o.userId === superAdminId);
  const adminOtpId = adminOtps.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]?.id;
  if (adminOtpId) {
    r = await superAdmin.req('POST', `/api/auth/otp-logs/${adminOtpId}/reveal`);
    check('EXPLOIT BLOCKED: no one can reveal an administrator\'s sign-in code',
      r.status === 403, `${r.status} ${r.text.slice(0, 200)}`);
  }

  // ------------------------------------------------- F6: base URL poisoning --
  section('Finding 6 -- learning the deployment address from traffic');

  await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example.net' } });
  check('EXPLOIT BLOCKED: an attacker Origin header does not become the app\'s own address',
    !String(appUrl.baseUrl()).includes('evil.example.net'),
    `baseUrl() = ${appUrl.baseUrl() || '(empty)'}`);
  await fetch(`${base}/api/health`, { headers: { Referer: 'https://evil.example.net/x' } });
  check('EXPLOIT BLOCKED: an attacker Referer header does not become the app\'s own address',
    !String(appUrl.baseUrl()).includes('evil.example.net'),
    `baseUrl() = ${appUrl.baseUrl() || '(empty)'}`);
  await fetch(`${base}/api/health`, { headers: { Host: 'evil.example.net' } }).catch(() => {});
  check('EXPLOIT BLOCKED: an attacker Host header does not become the app\'s own address',
    !String(appUrl.baseUrl()).includes('evil.example.net'),
    `baseUrl() = ${appUrl.baseUrl() || '(empty)'}`);

  // ---------------------------------------------------------- F7: billing --
  section('Finding 7 -- billing readable by every staff role');

  r = await employee.req('GET', '/api/billing/status');
  check('UNAUTHORIZED: an employee cannot read billing status', r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);
  r = await employee.req('GET', '/api/billing/payments');
  check('UNAUTHORIZED: an employee cannot read the payment history', r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);
  r = await employee.req('GET', `/api/billing/payments?clientId=${clientId}`);
  check('UNAUTHORIZED: an employee cannot read one client\'s payments either', r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);
  r = await trusted.req('GET', '/api/billing/status');
  check('AUTHORIZED: an admin can still read billing status', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
  r = await trusted.req('GET', '/api/billing/payments');
  check('AUTHORIZED: an admin can still read the payment history', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
  r = await client.req('GET', '/api/billing/status');
  check('AUTHORIZED: a client can still read their own billing', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);

  // ---------------------------------------------------------- F8: tickets --
  section('Finding 8 -- any employee editing any ticket');

  const tickets = (await trusted.req('GET', '/api/tickets')).data.tickets || [];
  const foreign = tickets.find((t) => t.assigneeId && t.assigneeId !== employee.id);
  const pmTicket = tickets.find((t) => t.id === 'ticket-1002') || foreign;
  const ownTicket = tickets.find((t) => t.id === 'ticket-1001');

  // Make a second client to try to move a ticket to.
  r = await superAdmin.req('POST', '/api/users', {
    name: 'Second Client', email: 'second.client@example.com', role: 'client', company: 'Other Co', password: 'Client#2026!',
  });
  const otherClientId = r.data.user?.id;
  check('AUTHORIZED: a super admin can create a second client', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);

  if (ownTicket) {
    r = await employee.req('PUT', `/api/tickets/${ownTicket.id}`, { clientId: otherClientId });
    const after = (await trusted.req('GET', '/api/tickets')).data.tickets.find((t) => t.id === ownTicket.id);
    check('EXPLOIT BLOCKED: an employee cannot move a ticket to a different client',
      after?.clientId !== otherClientId, `clientId is now ${after?.clientId}`);
    r = await employee.req('PUT', `/api/tickets/${ownTicket.id}`, { description: 'Employee note' });
    check('AUTHORIZED: the assigned employee can still edit their own ticket',
      r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  }
  if (pmTicket && pmTicket.id !== ownTicket?.id) {
    r = await employee.req('PUT', `/api/tickets/${pmTicket.id}`, { status: 'Closed' });
    check('UNAUTHORIZED: an employee cannot edit a ticket that is not theirs',
      r.status === 403, `${r.status} ${r.text.slice(0, 200)}`);
  }
  r = await trusted.req('PUT', `/api/tickets/${ownTicket?.id}`, { description: 'Admin note' });
  check('AUTHORIZED: an admin can still edit any ticket', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);

  // ------------------------------------------------------ F9: login links --
  section('Finding 9 -- one-tap sign-in links as an impersonation tool');

  r = await untrusted.req('POST', `/api/auth/login-link/${clientId}`, {});
  check('UNAUTHORIZED: an untrusted admin cannot mint a client sign-in link',
    r.status === 403, `${r.status} ${r.text.slice(0, 200)}`);
  r = await trusted.req('POST', `/api/auth/login-link/${clientId}`, {});
  check('AUTHORIZED: a trusted admin can still mint a client sign-in link',
    r.status === 200 && Boolean(r.data.path), `${r.status} ${r.text.slice(0, 200)}`);

  const notes = (await db.filter('notifications', (n) => n.userId === clientId && n.type === 'security'));
  check('the client is told when a sign-in link is issued for their account',
    notes.length > 0, `${notes.length} security notifications`);

  const linkAudit = (await db.all('activity_log')).filter((a) => a.action === 'issue_login_link');
  check('issuing a sign-in link is recorded against the admin who did it',
    linkAudit.length > 0 && linkAudit.every((a) => a.actorId), JSON.stringify(linkAudit[0] || {}).slice(0, 200));

  // ------------------------------------------------------- F10: audit log --
  section('Finding 10 -- the audit log not recording what changed');

  r = await trusted.req('PUT', `/api/users/${clientId}`, { name: 'David Shaw Jr' });
  check('AUTHORIZED: the edit itself still works', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
  const auditRows = (await superAdmin.req('GET', '/api/approvals/audit-log')).data.entries || [];
  const userUpdate = auditRows.find((a) => a.action === 'update' && a.entity === 'user' && a.entityId === clientId);
  check('EXPLOIT BLOCKED: a user change records which fields moved',
    Boolean(userUpdate?.meta) && Array.isArray(userUpdate.meta.changed) && userUpdate.meta.changed.includes('name'),
    JSON.stringify(userUpdate || {}).slice(0, 250));
  check('the audit log never stores a password or a hash',
    !JSON.stringify(auditRows).match(/"password"|\$2[aby]\$/),
    'a password-shaped value reached the audit log');

  r = await trusted.req('GET', '/api/approvals/audit-log');
  check('UNAUTHORIZED: a non-super admin still cannot read the audit log', r.status === 403, String(r.status));

  // ------------------------------------------------------ F12: file uploads --
  section('Finding 12 -- unchecked report uploads');

  r = await trusted.upload('/api/reports', {
    filename: 'payload.svg', mimeType: 'image/svg+xml',
    content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    fields: { clientId, category: 'General' },
  });
  check('EXPLOIT BLOCKED: an SVG is refused at upload', r.status === 415 || r.status === 400, `${r.status} ${r.text.slice(0, 200)}`);

  r = await trusted.upload('/api/reports', {
    filename: 'payload.html', mimeType: 'text/html', content: '<h1>hi</h1>',
    fields: { clientId, category: 'General' },
  });
  check('EXPLOIT BLOCKED: an HTML file is refused at upload', r.status === 415 || r.status === 400, `${r.status} ${r.text.slice(0, 200)}`);

  r = await trusted.upload('/api/reports', {
    filename: 'payload.js', mimeType: 'application/pdf', content: 'alert(1)',
    fields: { clientId, category: 'General' },
  });
  check('EXPLOIT BLOCKED: a mislabelled .js file is refused on its extension',
    r.status === 415 || r.status === 400, `${r.status} ${r.text.slice(0, 200)}`);

  r = await trusted.upload('/api/reports', {
    filename: 'report.pdf', mimeType: 'application/pdf', content: '%PDF-1.4 test',
    fields: { clientId, category: 'Performance' },
  });
  check('AUTHORIZED: a genuine PDF still uploads', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
  const reportId = r.data.report?.id;

  if (reportId) {
    r = await trusted.req('GET', `/api/reports/${reportId}/download?disposition=inline`);
    check('AUTHORIZED: a PDF still opens inline',
      r.status === 200 && String(r.headers.get('content-disposition')).startsWith('inline'),
      `${r.status} ${r.headers.get('content-disposition')}`);
    const otherClient = makeClient(base);
    await loginAs(otherClient, 'second.client@example.com', 'Client#2026!');
    r = await otherClient.req('GET', `/api/reports/${reportId}/download`);
    check('UNAUTHORIZED: another client cannot download that document', r.status === 404, String(r.status));
  }

  // --------------------------------------------------- F13: staff directory --
  section('Finding 13 -- the staff list handed to clients');

  r = await client.req('GET', '/api/users');
  const seen = r.data.users || [];
  check('EXPLOIT BLOCKED: a client is not shown who the administrators are',
    !seen.some((u) => u.role === 'admin'),
    JSON.stringify(seen.filter((u) => u.role === 'admin')).slice(0, 200));
  check('a client still sees their own account', seen.some((u) => u.id === clientId), JSON.stringify(seen).slice(0, 200));
  r = await employee.req('GET', '/api/users');
  check('AUTHORIZED: staff still get the internal directory',
    (r.data.users || []).length > 1, `${(r.data.users || []).length} entries`);

  // ------------------------------------------------------------ Mail page --
  section('Mail page -- stored credentials readable by every admin');

  r = await superAdmin.req('POST', '/api/users', {
    name: 'Mail Probe', email: 'mail.probe@example.com', role: 'client', password: 'Probe#2026!',
  });
  check('AUTHORIZED: creating a client still works', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
  const probePassword = r.data.temporaryPassword;
  const mailRows = await db.all('email_log');
  const credentialMail = mailRows.filter((m) => m.template === 'credentials');
  check('EXPLOIT BLOCKED: the stored copy of a credentials email holds no plaintext password',
    credentialMail.every((m) => !probePassword || !String(m.html || '').includes(probePassword)),
    'a stored email still contains the password');
  check('EXPLOIT BLOCKED: the stored copy of an email holds no working sign-in link',
    mailRows.every((m) => !String(m.html || '').match(/magic-link\/verify\?token=[\w.-]{20,}/)),
    'a stored email still contains a usable sign-in token');

  const loginCodeMail = mailRows.filter((m) => m.template === 'login_code');
  check('EXPLOIT BLOCKED: the stored copy of a sign-in code email holds no code',
    loginCodeMail.every((m) => !String(m.html || '').match(/\b\d{6}\b/)),
    'a stored email still contains a six-digit code');

  // ------------------------------- the approved path equals the direct one --
  section('Approval queue -- what is signed off is what happens');

  r = await untrusted.req('POST', '/api/users', {
    name: 'Queued Client', email: 'queued.client@example.com', role: 'client', company: 'Queue Co',
    slackChannelId: 'C0123ABCD', slackChannelName: 'queued-client',
    allowedPages: ['tickets', 'reports'],
  });
  check('an untrusted admin still proposes an account rather than creating one',
    r.status === 202 && r.data.pendingApproval === true, `${r.status} ${r.text.slice(0, 200)}`);
  const queuedId = r.data.request?.id;
  const queuedKeys = Object.keys(r.data.request?.payload || {});
  check('the queue never shows the proposed password',
    !queuedKeys.includes('plaintextPassword') && !queuedKeys.includes('password'),
    queuedKeys.join(','));

  r = await untrusted.req('POST', `/api/approvals/${queuedId}/approve`);
  check('UNAUTHORIZED: nobody signs off their own proposal', r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);
  r = await employee.req('POST', `/api/approvals/${queuedId}/approve`);
  check('UNAUTHORIZED: a non-admin cannot sign off a proposal', r.status === 403, String(r.status));

  r = await trusted.req('POST', `/api/approvals/${queuedId}/approve`);
  check('AUTHORIZED: a trusted admin signs the proposal off', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);

  const queuedUser = (await db.filter('users', (u) => u.email === 'queued.client@example.com'))[0];
  check('the approved account keeps every field the proposal carried',
    queuedUser?.slackChannelId === 'C0123ABCD' && queuedUser?.company === 'Queue Co',
    JSON.stringify({ channel: queuedUser?.slackChannelId, company: queuedUser?.company }));
  const queuedMail = (await db.all('email_log')).filter(
    (m) => m.template === 'credentials' && m.entityId === queuedUser?.id,
  );
  check('the approved account actually receives its credentials',
    queuedMail.length > 0, `${queuedMail.length} credential emails`);

  const settled = await db.find('approval_requests', queuedId);
  check('a decided proposal no longer holds the password it carried',
    !JSON.stringify(approvals.parsePayload(settled?.payload)).includes('plaintextPassword'),
    String(settled?.payload).slice(0, 160));

  r = await trusted.req('POST', `/api/approvals/${queuedId}/approve`);
  check('EXPLOIT BLOCKED: an approval cannot be replayed', r.status === 409, `${r.status} ${r.text.slice(0, 160)}`);

  // A password reset proposed by an untrusted admin has to deliver too.
  r = await untrusted.req('PUT', `/api/users/${queuedUser?.id}`, { regeneratePassword: true });
  check('an untrusted admin proposes a password reset rather than doing it',
    r.status === 202, `${r.status} ${r.text.slice(0, 200)}`);
  const resetId = r.data.request?.id;
  check('the proposal says a new password is part of it',
    String(r.data.request?.summary || '').includes('a new password'), r.data.request?.summary);
  const beforeReset = (await db.all('email_log')).filter((m) => m.template === 'credentials').length;
  r = await trusted.req('POST', `/api/approvals/${resetId}/approve`);
  check('AUTHORIZED: the reset is signed off and runs', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  const afterReset = (await db.all('email_log')).filter((m) => m.template === 'credentials').length;
  check('an approved password reset delivers the new password',
    afterReset > beforeReset, `${beforeReset} -> ${afterReset}`);

  // --------------------------------------------- the two-step toggle bites --
  section('The two-step sign-in switch decides something');

  r = await superAdmin.req('POST', `/api/users/${clientId}`, {});
  const twoFactorRow = await db.find('users', clientId);
  await db.update('users', clientId, { twoFactorEnabled: true });
  r = await trusted.req('POST', `/api/auth/login-link/${clientId}`, {});
  check('EXPLOIT BLOCKED: no one-tap link for an account that asked for two steps',
    r.status === 409, `${r.status} ${r.text.slice(0, 200)}`);
  await db.update('users', clientId, { twoFactorEnabled: Boolean(twoFactorRow?.twoFactorEnabled) });

  // ------------------------------------------------------- CSRF still bites --
  section('Cross-site request protection');

  const noToken = await fetch(`${base}/api/users/${clientId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `ew_sid=${trusted.sid}` },
    body: JSON.stringify({ name: 'No Token' }),
  });
  check('UNAUTHORIZED: a state-changing request without the token is refused',
    noToken.status === 403, String(noToken.status));

  // ------------------------------------------------- F16: error handling --
  section('Finding 16 -- malformed input');

  const bad = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
  });
  check('malformed JSON is answered with 400, not 500', bad.status === 400, String(bad.status));
  const badText = await bad.text();
  check('the error body leaks no internals',
    !badText.match(/at \w+ \(|node_modules|SyntaxError|\.js:\d+/), badText.slice(0, 160));

  // ---------------------------------------- admin backup codes (lockout) --
  section('Administrator backup codes -- the way back in when mail is down');

  r = await employee.req('GET', '/api/users/me/recovery-codes');
  check('UNAUTHORIZED: backup codes are not offered to non-admins', r.status === 403, String(r.status));

  r = await trusted.req('POST', '/api/users/me/recovery-codes', {});
  check('AUTHORIZED: an admin can generate their own set', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  const backupCodes = r.data.codes || [];
  check('a set is eight codes', backupCodes.length === 8, `${backupCodes.length}`);
  check('the codes are readable down a phone line',
    backupCodes.every((c) => /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/.test(c)),
    backupCodes[0]);

  r = await trusted.req('GET', '/api/users/me/recovery-codes');
  check('the status endpoint never returns the codes themselves',
    !JSON.stringify(r.data).includes(backupCodes[0]) && r.data.status?.remaining === 8,
    JSON.stringify(r.data).slice(0, 160));

  const codeRows = await db.filter('recovery_codes', (x) => x.userId === trustedId);
  check('only the hash of a backup code is stored',
    codeRows.length === 8 && codeRows.every((x) => String(x.codeHash).startsWith('$2') && !backupCodes.includes(x.codeHash)),
    String(codeRows[0]?.codeHash || '').slice(0, 8));

  // The lockout scenario, end to end: mail is dead, so the emailed code never
  // arrives. The admin signs in with their password and a backup code instead.
  //
  // Note the sign-in budget. The login rate limiter is real and this suite runs
  // under it, so the negative cases below reuse one pending session rather than
  // signing in again each time -- a failed code leaves the pending session
  // alive, which is itself the behaviour being relied on.
  const lockedOut = makeClient(base);
  r = await lockedOut.req('POST', '/api/auth/login', { email: 'trusted.admin@ethixweb.local', password: trustedPassword });
  check('the password step still happens first', r.status === 200 && r.data.requiresOtp === true, String(r.status));
  lockedOut.setCsrf(r.data.csrfToken);
  const pendingSid = lockedOut.sid;

  r = await lockedOut.req('POST', '/api/auth/verify-otp', { code: 'AAAAA-AAAAA' });
  check('EXPLOIT BLOCKED: a wrong backup code is refused', r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);
  check('a failed backup code does not end the attempt', lockedOut.sid === pendingSid);

  r = await lockedOut.req('POST', '/api/auth/verify-otp', { code: backupCodes[0].toLowerCase().replace('-', ' ') });
  check('AUTHORIZED: a backup code signs the admin in, however it was typed',
    r.status === 200 && r.data.usedRecoveryCode === true, `${r.status} ${r.text.slice(0, 200)}`);
  check('the session identifier is replaced on that path too',
    lockedOut.sid && lockedOut.sid !== pendingSid, `${String(pendingSid).slice(0, 8)} -> ${String(lockedOut.sid).slice(0, 8)}`);
  lockedOut.setCsrf(r.data.csrfToken);
  r = await lockedOut.req('GET', '/api/auth/me');
  check('AUTHORIZED: that session is a real one', r.status === 200 && r.data.user?.role === 'admin', String(r.status));

  r = await lockedOut.req('GET', '/api/users/me/recovery-codes');
  check('the code that was used is spent', r.data.status?.remaining === 7 && r.data.status?.used === 1,
    JSON.stringify(r.data.status));

  // One pending session, three negative cases, no extra sign-ins.
  const probe = makeClient(base);
  r = await probe.req('POST', '/api/auth/login', { email: 'trusted.admin@ethixweb.local', password: trustedPassword });
  probe.setCsrf(r.data.csrfToken);

  r = await probe.req('POST', '/api/auth/verify-otp', { code: backupCodes[0] });
  check('EXPLOIT BLOCKED: a spent backup code cannot be used again',
    r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);

  // Regenerating invalidates every earlier code outright.
  r = await lockedOut.req('POST', '/api/users/me/recovery-codes', {});
  check('AUTHORIZED: an admin can replace their set', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  const secondSet = r.data.codes || [];
  check('the replacement set is entirely different',
    secondSet.length === 8 && !secondSet.some((c) => backupCodes.includes(c)));

  r = await probe.req('POST', '/api/auth/verify-otp', { code: backupCodes[2] });
  check('EXPLOIT BLOCKED: regenerating kills every earlier code',
    r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);

  // The replacement set works, on that same pending session.
  r = await probe.req('POST', '/api/auth/verify-otp', { code: secondSet[0] });
  check('AUTHORIZED: the replacement set works', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);

  // A backup code is a second factor, not a way past the first one.
  const noPassword = makeClient(base);
  r = await noPassword.req('POST', '/api/auth/verify-otp', { code: secondSet[1] });
  check('EXPLOIT BLOCKED: a backup code alone, with no password step, is refused',
    r.status === 401, `${r.status} ${r.text.slice(0, 160)}`);

  // Someone else's codes are not yours. The super admin has a pending session
  // of their own from the login-flow section, so this costs no sign-in either.
  const wrongOwner = makeClient(base);
  r = await wrongOwner.req('POST', '/api/auth/login', { email: 'admin@ethixweb.local', password: 'Admin#2026!' });
  wrongOwner.setCsrf(r.data.csrfToken);
  r = await wrongOwner.req('POST', '/api/auth/verify-otp', { code: secondSet[1] });
  check("EXPLOIT BLOCKED: one admin cannot sign in with another admin's backup code",
    r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);

  // Using one is announced, not silent.
  const brokeGlass = await db.filter('notifications', (n) => n.type === 'security'
    && String(n.message).includes('backup code'));
  check('using a backup code is announced to the other admins',
    brokeGlass.length > 0, `${brokeGlass.length} notifications`);
  const recoveryAudit = (await db.all('activity_log')).filter(
    (a) => a.action === 'login' && JSON.stringify(a.meta || '').includes('recovery_code'),
  );
  check('using a backup code is on the audit log', recoveryAudit.length > 0);

  // A demoted admin's codes go with the role.
  r = await superAdmin.req('POST', '/api/users', {
    name: 'Short Lived', email: 'short.lived@ethixweb.local', role: 'admin', password: 'Short#2026!',
  });
  check('a new admin is issued backup codes with their password',
    r.status === 201 && (r.data.recoveryCodes || []).length === 8, `${r.status} ${r.text.slice(0, 160)}`);
  const shortLivedId = r.data.user?.id;
  await superAdmin.req('PUT', `/api/users/${shortLivedId}`, { role: 'employee' });
  const orphaned = await db.filter('recovery_codes', (x) => x.userId === shortLivedId);
  check('a demoted admin keeps no backup codes', orphaned.length === 0, `${orphaned.length} left`);

  // ------------------------------- break-glass from the server console --
  section('Break-glass CLI -- the first admin, on a deployment with no mail');

  const breakGlass = require('./admin-recovery');

  // The listing is read-only and must never carry anything usable.
  const roster = await breakGlass.listAdmins();
  check('the CLI lists every administrator',
    roster.length >= 2 && roster.every((a) => a.email), `${roster.length} admins`);
  check('the CLI listing carries no codes, passwords or hashes',
    !JSON.stringify(roster).match(/code_hash|codeHash|password|\$2[aby]\$/),
    JSON.stringify(roster[0] || {}).slice(0, 200));
  check('the CLI listing says who is holding backup codes',
    roster.every((a) => typeof a.remaining === 'number' && typeof a.total === 'number'));
  check('the super admin is listed first, since that is who gets locked out',
    roster[0]?.isSuperAdmin === true, JSON.stringify(roster.map((a) => a.email)));

  // It refuses anything that is not an administrator.
  let refused = null;
  try {
    await breakGlass.issueFor('client@brightpath-retail.com');
  } catch (err) {
    refused = err;
  }
  check('EXPLOIT BLOCKED: the CLI refuses a non-admin account',
    refused instanceof breakGlass.RecoveryError && /not an administrator/.test(refused.message),
    String(refused?.message).slice(0, 120));

  refused = null;
  try {
    await breakGlass.issueFor('nobody@example.com');
  } catch (err) {
    refused = err;
  }
  check('the CLI refuses an address that does not exist',
    refused instanceof breakGlass.RecoveryError, String(refused?.message).slice(0, 120));

  // The real thing: codes for the super admin, the account with nobody above it.
  const auditBefore = (await db.all('activity_log')).length;
  const issued = await breakGlass.issueFor('admin@ethixweb.local', { reason: 'regression test' });
  check('AUTHORIZED: the CLI issues a set for the super admin',
    issued.codes.length === 8 && issued.user.email === 'admin@ethixweb.local', `${issued.codes.length} codes`);
  check('the CLI codes are the same shape as the in-app ones',
    issued.codes.every((c) => /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/.test(c)),
    issued.codes[0]);

  const cliRows = await db.filter('recovery_codes', (x) => x.userId === superAdminId);
  check('the CLI stores only hashes, never the codes',
    cliRows.length === 8 && cliRows.every((x) => String(x.codeHash).startsWith('$2')
      && !issued.codes.includes(x.codeHash)),
    String(cliRows[0]?.codeHash || '').slice(0, 8));

  // It has to leave a record, or it is indistinguishable from someone helping
  // themselves to the owner's account.
  const cliAudit = (await db.all('activity_log'))
    .filter((a) => a.action === 'recovery_codes' && a.entityId === superAdminId);
  const cliMeta = cliAudit.map((a) => (typeof a.meta === 'string' ? JSON.parse(a.meta) : a.meta || {}));
  check('the CLI writes an audit entry naming it as a server-console action',
    cliMeta.some((m) => m.action === 'issued_from_server'), JSON.stringify(cliMeta).slice(0, 200));
  check('the audit entry carries the stated reason',
    cliMeta.some((m) => m.reason === 'regression test'), JSON.stringify(cliMeta).slice(0, 200));
  check('the audit log grew, rather than the action passing silently',
    (await db.all('activity_log')).length > auditBefore);

  const cliAlert = await db.filter('notifications', (n) => n.type === 'security'
    && String(n.message).includes('from the server console'));
  check('every other admin is told a set was issued from the console',
    cliAlert.length > 0 && cliAlert.every((n) => n.userId !== superAdminId),
    `${cliAlert.length} alerts`);

  // And the codes actually work, through the ordinary sign-in path.
  const rescued = makeClient(base);
  r = await rescued.req('POST', '/api/auth/login', { email: 'admin@ethixweb.local', password: 'Admin#2026!' });
  check('the rescued admin still has to prove the password', r.status === 200 && r.data.requiresOtp === true, String(r.status));
  rescued.setCsrf(r.data.csrfToken);
  r = await rescued.req('POST', '/api/auth/verify-otp', { code: issued.codes[0] });
  check('AUTHORIZED: a CLI-issued code signs the locked-out admin back in',
    r.status === 200 && r.data.usedRecoveryCode === true, `${r.status} ${r.text.slice(0, 200)}`);
  r = await rescued.req('GET', '/api/auth/me');
  check('AUTHORIZED: that session is a full super-admin session',
    r.status === 200 && r.data.capabilities?.isSuperAdmin === true, String(r.status));

  // Issuing again replaces the set, exactly like the in-app button.
  const reissued = await breakGlass.issueFor('admin@ethixweb.local');
  check('re-issuing from the CLI replaces the previous set',
    reissued.replaced === 8 && !reissued.codes.some((c) => issued.codes.includes(c)));
  const stillSpent = makeClient(base);
  r = await stillSpent.req('POST', '/api/auth/login', { email: 'admin@ethixweb.local', password: 'Admin#2026!' });
  stillSpent.setCsrf(r.data.csrfToken);
  r = await stillSpent.req('POST', '/api/auth/verify-otp', { code: issued.codes[1] });
  check('EXPLOIT BLOCKED: a code from the replaced CLI set no longer works',
    r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);

  // The dry run is the default: no --yes, nothing changes.
  const parsed = breakGlass.parseArgs(['issue', 'admin@ethixweb.local']);
  check('the CLI does not act without an explicit --yes',
    parsed.command === 'issue' && parsed.confirmed === false, JSON.stringify(parsed));
  const parsedYes = breakGlass.parseArgs(['issue', 'admin@ethixweb.local', '--reason', 'mail down', '--yes']);
  check('the CLI reads --yes and --reason',
    parsedYes.confirmed === true && parsedYes.reason === 'mail down' && parsedYes.email === 'admin@ethixweb.local',
    JSON.stringify(parsedYes));

  // ------------------------------------------------------ bypass variants --
  section('Bypass variants -- the same boundary, reached another way');

  // The fix landed on PUT /api/users/:id. Its siblings have to hold too.
  r = await superAdmin.req('POST', '/api/users', {
    name: 'Sneaky Admin', email: 'sneaky@ethixweb.local', role: 'admin',
    password: 'Sneaky#2026!', isSuperAdmin: true, is_super_admin: true, adminTrusted: true, admin_trusted: true,
  });
  check('AUTHORIZED: the account is still created', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
  const sneaky = r.data.user;
  check('EXPLOIT BLOCKED: standing cannot be granted at creation time',
    sneaky && sneaky.isSuperAdmin !== true && sneaky.adminTrusted !== true,
    JSON.stringify({ superAdmin: sneaky?.isSuperAdmin, trusted: sneaky?.adminTrusted }));

  // ...and the self-service profile screen, which writes to the same table.
  for (const body of [{ isSuperAdmin: true }, { is_super_admin: true }, { role: 'admin', adminTrusted: true }]) {
    await trusted.req('PUT', '/api/users/me', body);
  }
  const afterSelfEdit = (await trusted.req('GET', '/api/auth/me')).data;
  check('EXPLOIT BLOCKED: the self-service profile cannot grant standing either',
    afterSelfEdit.capabilities?.isSuperAdmin === false,
    JSON.stringify(afterSelfEdit.capabilities));

  // Billing was fixed on two GETs; the write endpoint next to them counts too.
  r = await employee.req('POST', '/api/billing/sync', {});
  check('UNAUTHORIZED: an employee cannot trigger a billing sync',
    r.status === 403, `${r.status} ${r.text.slice(0, 160)}`);

  // Documents: an employee has never been on the reports allowlist. Confirm the
  // list, the upload and the download all agree about that.
  r = await employee.req('GET', '/api/reports');
  check('an employee sees no client documents', (r.data.reports || []).length === 0, `${(r.data.reports || []).length} rows`);
  if (reportId) {
    r = await employee.req('GET', `/api/reports/${reportId}/download`);
    check('UNAUTHORIZED: an employee cannot download a client document', r.status === 404, String(r.status));
  }
  r = await employee.upload('/api/reports', {
    filename: 'x.pdf', mimeType: 'application/pdf', content: '%PDF-1.4', fields: { clientId },
  });
  check('UNAUTHORIZED: an employee cannot upload a client document', r.status === 403, String(r.status));

  // ------------------------------- the field gate itself, both drivers --
  section('The data layer -- one column, one spelling');

  // Finding 1 was a route guard written against `isSuperAdmin` walked around
  // with `is_super_admin`. The guard is now above this, but the gate below it
  // is where the class of bug lived, and both drivers share it -- which is the
  // only way the Firestore deployment gets the fix too, since no live Firestore
  // is reachable from this harness.
  const { isWritableField } = require('../db/schemas');
  const gateCases = [
    ['users', 'isSuperAdmin', true],
    ['users', 'is_super_admin', false],
    ['users', 'adminTrusted', true],
    ['users', 'admin_trusted', false],
    ['users', 'allowedPages', true],
    ['users', 'allowed_pages', false],
    ['users', 'passwordExpiresAt', true],
    ['users', 'password_expires_at', false],
    ['tickets', 'clientId', true],
    ['tickets', 'client_id', false],
    ['users', 'somethingInvented', false],
    ['users', 'name', true],
  ];
  for (const [collection, key, expected] of gateCases) {
    check(`the field gate ${expected ? 'accepts' : 'refuses'} ${collection}.${key}`,
      isWritableField(collection, key) === expected);
  }
  const firestoreSource = require('fs').readFileSync(require.resolve('../db/firestore.js'), 'utf8');
  check('the Firestore driver goes through the same gate',
    firestoreSource.includes('isWritableField(collection, k)'),
    'firestore sanitize() does not use the shared gate');

  // A user record must never carry its own hash out of the server.
  const { safeUser } = require('../middleware/auth');
  const raw = await db.find('users', clientId);
  const shown = safeUser(raw);
  check('a user record never leaves the server with its password hash',
    !('password' in shown) && !('demoPassword' in shown), Object.keys(shown).join(','));

  // --------------------------------------------- unauthenticated baseline --
  section('Unauthenticated baseline');

  const anon = makeClient(base);
  const closedDoors = [
    ['GET', '/api/users'],
    ['GET', '/api/auth/otp-logs'],
    ['GET', '/api/approvals'],
    ['GET', '/api/approvals/audit-log'],
    ['GET', '/api/billing/status'],
    ['GET', '/api/billing/payments'],
    ['GET', '/api/mail/log'],
    ['GET', '/api/reports'],
    ['PUT', `/api/users/${clientId}`],
    ['POST', `/api/users/${clientId}/standing`],
    ['POST', `/api/auth/login-link/${clientId}`],
  ];
  for (const [method, path] of closedDoors) {
    const rr = await anon.req(method, path, method === 'GET' ? undefined : {});
    check(`UNAUTHENTICATED: ${method} ${path} is refused`, rr.status === 401 || rr.status === 403, String(rr.status));
  }

  // Cross-role: an employee at admin-only doors.
  for (const [method, path] of [
    ['GET', '/api/auth/otp-logs'],
    ['GET', '/api/approvals'],
    ['GET', '/api/mail/log'],
    ['POST', `/api/auth/login-link/${clientId}`],
  ]) {
    const rr = await employee.req(method, path, method === 'GET' ? undefined : {});
    check(`UNAUTHORIZED: an employee at ${method} ${path} is refused`, rr.status === 403, String(rr.status));
  }

  // Session invalidation still works.
  const doomed = makeClient(base);
  await loginAs(doomed, 'mail.probe@example.com', probePassword);
  r = await doomed.req('GET', '/api/auth/me');
  check('AUTHORIZED: the probe account has a live session', r.status === 200, String(r.status));
  await doomed.req('POST', '/api/auth/logout');
  r = await doomed.req('GET', '/api/auth/me');
  check('UNAUTHORIZED: a logged-out session cannot be reused', r.status === 401, String(r.status));

  // ------------------------------------------------------ F15: rate limits --
  section('Finding 15 -- rate limits on sensitive admin actions');

  let limited = false;
  for (let i = 0; i < 25; i++) {
    const rr = await trusted.req('POST', `/api/auth/otp-logs/${clientRow?.id || 'missing'}/reveal`);
    if (rr.status === 429) { limited = true; break; }
  }
  check('revealing sign-in codes has its own rate limit', limited, 'no 429 after 25 attempts');

  // --------------------------------------------------------------- done --
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nStill failing:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
