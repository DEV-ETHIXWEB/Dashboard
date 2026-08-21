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
      return { status: res.status, data, text };
    },
  };
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const admin = makeClient(base);
  const client = makeClient(base);

  // --- admin sign-in -------------------------------------------------------
  let r = await admin.req('POST', '/api/auth/login', { email: 'admin@ethixweb.local', password: 'Admin#2026!' });
  check('admin can sign in', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
  admin.setCsrf(r.data.csrfToken);

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
  const welcomeHtml = welcomeMail
    ? (await admin.req('GET', `/api/mail/log/${welcomeMail.id}`)).data.entry?.html || ''
    : '';
  const welcomeMatch = welcomeHtml.match(/(\/api\/auth\/magic-link\/verify\?token=[^"&<\s]+)/);
  check('the welcome email carries a one-tap link', Boolean(welcomeMatch), welcomeHtml.slice(0, 100));

  if (welcomeMatch) {
    const welcomeHit = await openLink(welcomeMatch[1]);
    check('the welcome link signs the new client in',
      welcomeHit.status === 302 && welcomeHit.headers.get('location') === '/portal',
      `${welcomeHit.status} ${welcomeHit.headers.get('location')}`);
  }


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
