'use strict';

/* Proves the mail system really delivers: stands up an actual SMTP server on
   localhost, points the app's transport at it, sends through the normal app
   path, and asserts on the bytes that arrived over the wire.

   Run from the repo root:
     npm run test:mail                          */

const net = require('net');

/** The brand red the renderer actually ships, so a rebrand moves one file. */
const BRAND_RED = require('../utils/emailTemplates').TOKENS.brand;
const HOSTED_ASSETS = 'https://sjzhvegnywiftvmprnlf.supabase.co/storage/v1/object/public/EMAIL%20TEMPLATE%20IMAGES';

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

/** A minimal but real ESMTP server: EHLO, AUTH LOGIN, MAIL, RCPT, DATA, QUIT. */
function startSmtpServer() {
  const received = [];

  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let message = { from: null, to: [], data: '', auth: null };
    let awaitingAuth = null;

    const say = (line) => socket.write(`${line}\r\n`);
    say('220 localhost ESMTP test');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            received.push(message);
            message = { from: null, to: [], data: '', auth: message.auth };
            say('250 2.0.0 Queued');
          } else {
            // Undo dot-stuffing, exactly as a real server must.
            message.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
          continue;
        }

        if (awaitingAuth === 'username') {
          message.auth = { user: Buffer.from(line, 'base64').toString('utf8') };
          awaitingAuth = 'password';
          say('334 UGFzc3dvcmQ6');
          continue;
        }
        if (awaitingAuth === 'password') {
          message.auth = { ...message.auth, pass: Buffer.from(line, 'base64').toString('utf8') };
          awaitingAuth = null;
          say('235 2.7.0 Authentication successful');
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          say('250-localhost');
          say('250-AUTH LOGIN PLAIN');
          say('250-8BITMIME');
          say('250 SIZE 10485760');
        } else if (upper.startsWith('AUTH PLAIN')) {
          // AUTH PLAIN carries \x00user\x00pass base64-encoded on the same line.
          const parts = Buffer.from(line.split(' ')[2] || '', 'base64').toString('utf8').split('\x00');
          message.auth = { user: parts[1], pass: parts[2] };
          say('235 2.7.0 Authentication successful');
        } else if (upper.startsWith('AUTH LOGIN')) {
          awaitingAuth = 'username';
          say('334 VXNlcm5hbWU6');
        } else if (upper.startsWith('MAIL FROM')) {
          message.from = line.slice(line.indexOf(':') + 1).trim();
          say('250 2.1.0 Sender ok');
        } else if (upper.startsWith('RCPT TO')) {
          message.to.push(line.slice(line.indexOf(':') + 1).trim());
          say('250 2.1.5 Recipient ok');
        } else if (upper === 'DATA') {
          inData = true;
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (upper === 'QUIT') {
          say('221 2.0.0 Bye');
          socket.end();
        } else if (upper === 'RSET') {
          message = { from: null, to: [], data: '', auth: message.auth };
          say('250 2.0.0 Reset');
        } else {
          say('250 2.0.0 OK');
        }
      }
    });

    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}

async function main() {
  const smtp = await startSmtpServer();

  // The log table lives in the same database the app uses, so create the
  // schema before sending -- this test exercises the real logging path too.
  await require('../db/setup').seed();

  // This suite exercises the SMTP path against a local server, so pin the
  // transport: a real SMTP2GO key in the developer's environment would
  // otherwise win the auto-detection and send nothing here.
  process.env.MAIL_TRANSPORT = 'smtp';
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(smtp.port);
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_USER = 'dashboard@ethixweb.test';
  process.env.SMTP_PASSWORD = 'app-password-123';
  process.env.MAIL_FROM = 'EthixWeb <dashboard@ethixweb.test>';
  process.env.APP_BASE_URL = 'https://dashboard.example.com';

  const mailer = require('../utils/mailer');
  const messages = require('../utils/emailMessages');

  check('SMTP is detected as the transport', mailer.transportName() === 'smtp', mailer.transportName());
  check('transport reports as configured', mailer.isEnabled() === true);

  const verified = await mailer.verifyTransport();
  check('credentials verify against a live server', verified.ok === true, JSON.stringify(verified));

  // Send through the normal application path, not a special test path.
  const result = await mailer.sendTemplate({
    to: ['client@example.com', 'owner@example.com'],
    message: messages.ticketReceiptForClient({
      ticket: {
        id: 'ticket-2001',
        subject: 'Checkout page throws a 500',
        category: 'Bug',
        status: 'Open',
        priority: 'Urgent',
        progress: 0,
        createdAt: new Date().toISOString(),
        responseDueAt: Date.now() + 3600000,
      },
      clientName: 'David Shaw',
      assigneeName: 'Ryan Coleman',
    }),
    template: 'ticket_receipt_client',
    entity: 'ticket',
    entityId: 'ticket-2001',
  });

  check('send reports success', result.ok === true, JSON.stringify(result));
  check('send reports the smtp transport', result.transport === 'smtp', String(result.transport));
  check('a message id came back from the server', Boolean(result.providerId));

  // Give the server a moment to finish the DATA stanza.
  await new Promise((r) => setTimeout(r, 300));

  check('exactly one message reached the server', smtp.received.length === 1, `${smtp.received.length}`);
  const sent = smtp.received[0];

  if (sent) {
    check('the server authenticated the app', sent.auth?.user === 'dashboard@ethixweb.test' && sent.auth?.pass === 'app-password-123', JSON.stringify(sent.auth));
    check('envelope sender is the configured from address', sent.from.includes('dashboard@ethixweb.test'), sent.from);
    check('both recipients were delivered to', sent.to.length === 2, sent.to.join(','));
    check('subject line survived', /^Subject: .*We got your request/m.test(sent.data.replace(/\n\s+/g, ' ')), sent.data.split('\n').find((l) => l.startsWith('Subject')) || 'no subject header');
    check('message is multipart with a plain-text part', sent.data.includes('multipart/alternative') && sent.data.includes('text/plain'));
    check('HTML part is present', sent.data.includes('text/html'));

    // Decode only the text/html part. The message also carries the wordmark
    // and one inline PNG per fact icon, all base64 -- lumping every base64
    // run together and decoding it yields image bytes, not markup.
    const htmlPart = (raw) => {
      const at = raw.search(/Content-Type:\s*text\/html/i);
      if (at < 0) return '';
      const part = raw.slice(at);
      const split = part.search(/\r?\n\r?\n/);
      const headers = part.slice(0, split);
      let body = part.slice(split).replace(/^\r?\n\r?\n/, '');
      const stop = body.search(/\r?\n--/);
      if (stop >= 0) body = body.slice(0, stop);
      return /base64/i.test(headers)
        ? Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8')
        : body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    };
    const decoded = htmlPart(sent.data);

    check('the EthixWeb red survived transport', decoded.includes(BRAND_RED), decoded.slice(0, 120));
    // The artwork moved to object storage, so the masthead no longer points at
    // this deployment. What matters now is that every image is an absolute
    // https URL an inbox can actually fetch, and that nothing rides along as
    // an attachment any more.
    check('the logo is linked absolutely', decoded.includes(`${HOSTED_ASSETS}/ethixweb.png`), decoded.slice(0, 200));
    const srcs = [...new Set((decoded.match(/src="[^"]+"/g) || []))];
    check('every image is a hosted https URL', srcs.every((s) => s.startsWith('src="https://')), srcs.join(' '));
    check('no artwork rides along as an attachment', !/Content-ID|cid:/i.test(sent.data), 'a cid: reference survived');
    check('the call to action links back to the portal', decoded.includes('https://dashboard.example.com/portal/tickets?ticket=ticket-2001'));
  }

  // --- a provider in test mode ---------------------------------------------
  // Most providers' free tiers refuse every address except the account owner's.
  // The app has to say something an admin can act on, not forward the JSON.
  {
    const sandbox = 'SMTP2GO rejected the message (403): {"data":{"error":"You can only send testing emails '
      + 'to your own email address (owner@example.com). Verify a sender domain to send to other recipients.",'
      + '"error_code":"E_ApiResponseCodes.SENDER_NOT_VERIFIED"}}';
    const explained = mailer.explainSendError(sandbox);
    check('a sandbox rejection is explained in a sentence', !explained.includes('{'), explained);
    check('and it names the address that would work', explained.includes('owner@example.com'), explained);
    check('and it says what to do about it', /verify a sending domain/i.test(explained), explained);
    check('a long provider error is trimmed, not dumped', explained.length < 220, `${explained.length} chars`);

    check('a refused key reads as a key problem',
      /credentials|API key|SMTP2GO_API_KEY/i.test(mailer.explainSendError(
        'SMTP2GO rejected the message (401): {"data":{"error":"API key is invalid","error_code":"E_ApiResponseCodes.API_KEY_INVALID"}}')));
    check('an unverified sender reads as a sender problem',
      /verified sender|MAIL_FROM/i.test(mailer.explainSendError(
        'SMTP2GO rejected the message (400): {"data":{"error":"sender not allowed","error_code":"E_ApiResponseCodes.SENDER_NOT_VERIFIED"}}')));
    check('an unreachable server reads as a connection problem',
      /Could not reach the mail server/.test(mailer.explainSendError('connect ECONNREFUSED 127.0.0.1:2525')));
  }

  // --- MAIL_REDIRECT_TO ------------------------------------------------------
  // The escape hatch that makes a sandboxed provider usable: everything goes to
  // one inbox, and the record still says who it was meant for.
  {
    process.env.SMTP_PORT = String(smtp.port);
    process.env.MAIL_REDIRECT_TO = 'test-inbox@example.com';
    const before = smtp.received.length;

    const result = await mailer.sendMail({
      to: 'real.client@example.com',
      subject: 'Your weekly summary',
      text: 'Hello',
      html: '<p>Hello</p>',
      template: 'progress_digest',
      entity: 'user',
      entityId: 'u-redirect',
    });

    check('a redirected send still reports success', result.ok === true, JSON.stringify(result));
    check('it says where it actually went', result.redirectedTo === 'test-inbox@example.com', result.redirectedTo);
    check('it still reports who it was for', (result.recipients || []).includes('real.client@example.com'),
      JSON.stringify(result.recipients));

    const sent = smtp.received[before];
    check('exactly one message left', smtp.received.length === before + 1, `${smtp.received.length - before}`);
    check('it was delivered to the test inbox', (sent?.to || []).some((a) => a.includes('test-inbox@example.com')),
      JSON.stringify(sent?.to));
    check('and NOT to the real client', !(sent?.to || []).some((a) => a.includes('real.client@example.com')),
      JSON.stringify(sent?.to));
    check('the subject names the intended recipient',
      /to: real\.client@example\.com/.test(sent?.data || ''), (sent?.data || '').slice(0, 120));

    const logged = (await mailer.recentLog(5)).find((e) => e.entityId === 'u-redirect');
    check('the log records who it was meant for, not the test inbox',
      String(logged?.toEmails).includes('real.client@example.com'), logged?.toEmails);
    check('the log notes that it was redirected', /MAIL_REDIRECT_TO/.test(String(logged?.error)), logged?.error);

    delete process.env.MAIL_REDIRECT_TO;
    check('unsetting it restores normal delivery', mailer.redirectTo() === null);
  }

  // A wrong port must fail loudly rather than silently pretending.
  process.env.SMTP_PORT = String(smtp.port + 1);
  const bad = await mailer.verifyTransport();
  check('a broken connection is reported, not swallowed', bad.ok === false && Boolean(bad.error), JSON.stringify(bad));

  // The delivery must also be on the record an admin can read.
  const logged = await mailer.recentLog(10);
  const entry = logged.find((e) => e.entityId === 'ticket-2001');
  check('the delivery is written to the mail log', Boolean(entry), `${logged.length} entries`);
  check('the log records it as sent over smtp', entry?.status === 'sent' && entry?.transport === 'smtp', JSON.stringify({ s: entry?.status, t: entry?.transport }));
  check('the log keeps the exact HTML that was sent', Boolean(entry?.html && entry.html.includes(BRAND_RED)));

  smtp.server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
