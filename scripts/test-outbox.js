'use strict';

/* Proves the outbound queue does what the rest of the app now trusts it to do:
   retries a message that failed for a reason worth retrying, gives up at once
   on one that is never going to work, sends a message exactly once however
   many sweeps race for it, falls through to a second transport, and refuses to
   hold a credential.

   Run from the repo root:
     npm run test:outbox                        */

const { db } = require('../db/setup');
const outbox = require('../utils/outbox');
const mailer = require('../utils/mailer');

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

/**
 * Stand in for the queue's email handler, so these tests never touch a real
 * provider.
 *
 * Only works on the path the *queue* takes: `handlers.email` fetches the
 * mailer through `require` at call time, so replacing the export is enough.
 * It deliberately does NOT intercept `mailer.sendMail` sending inline -- that
 * calls `sendNow` as a local function, which no amount of reassigning the
 * export will reach. Tests of the inline path assert on what comes back
 * instead, which is the contract rather than the call.
 */
function stubEmail(impl) {
  const original = mailer.sendNow;
  mailer.sendNow = impl;
  return () => { mailer.sendNow = original; };
}

async function main() {
  await require('../db/setup').seed();

  // --- retry ---------------------------------------------------------------

  section('A transient failure is retried, not dropped');
  {
    let calls = 0;
    const restore = stubEmail(async () => {
      calls += 1;
      // A connection that was refused: the moment, not the message.
      return { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:587', permanent: false };
    });

    const queued = await outbox.enqueue({
      channel: 'email',
      payload: { to: ['a@example.com'], subject: 'Retry me', html: '<p>hi</p>' },
      entity: 'test', entityId: 'retry-1',
    });
    check('the message is queued', queued.status === 'queued', queued.status);

    const first = await outbox.deliver(queued.id);
    check('the first attempt fails', first.retrying === true, JSON.stringify(first));

    let row = await db.find('outbox', queued.id);
    check('it is back in the queue, not failed', row.status === 'queued', row.status);
    check('the attempt was counted', Number(row.attempts) === 1, String(row.attempts));
    check('the error was kept for whoever looks', /ECONNREFUSED/.test(row.lastError), row.lastError);

    // The backoff is the point: it is deliberately NOT due again yet, so a
    // sweep running a second later must leave it alone rather than hammering
    // a provider that has just refused a connection.
    const dueNow = await db.dueOutboxMessages(Date.now(), 50);
    check('the backoff keeps it out of the next sweep', !dueNow.some((r) => r.id === queued.id),
      `${dueNow.length} due`);
    check('and only one attempt was actually made', calls === 1, String(calls));

    // Wind the clock forward by making the row due, which is what waiting out
    // the backoff amounts to.
    await db.update('outbox', queued.id, { nextAttemptAt: Date.now() - 1 });
    const dueLater = await db.dueOutboxMessages(Date.now(), 50);
    check('once the backoff has passed it is due again', dueLater.some((r) => r.id === queued.id));

    // Run it out of attempts and check it parks rather than retrying forever.
    for (let i = 0; i < outbox.DEFAULT_MAX_ATTEMPTS; i += 1) {
      await db.update('outbox', queued.id, { status: 'queued', nextAttemptAt: Date.now() - 1 });
      await outbox.deliver(queued.id);
    }
    row = await db.find('outbox', queued.id);
    check('it gives up rather than retrying for ever', row.status === 'failed', row.status);
    check('and the row says why', /ECONNREFUSED/.test(row.lastError), row.lastError);

    restore();
  }

  // --- permanent failure ---------------------------------------------------

  section('A permanent failure stops at once');
  {
    let calls = 0;
    const restore = stubEmail(async () => {
      calls += 1;
      return { ok: false, error: 'SMTP2GO refused our credentials. Check that SMTP2GO_API_KEY matches a live key.', permanent: true };
    });

    const queued = await outbox.enqueue({
      channel: 'email',
      payload: { to: ['b@example.com'], subject: 'Hopeless', html: '<p>hi</p>' },
      entity: 'test', entityId: 'permanent-1',
    });
    const result = await outbox.deliver(queued.id);

    check('it is failed, not retrying', result.failed === true, JSON.stringify(result));
    check('and said so', result.permanent === true);
    const row = await db.find('outbox', queued.id);
    check('the row is parked after one attempt', row.status === 'failed' && Number(row.attempts) === 1,
      JSON.stringify({ s: row.status, a: row.attempts }));
    check('the provider was only asked once', calls === 1, String(calls));

    restore();
  }

  // --- exactly once --------------------------------------------------------

  section('A message is sent once, however many sweeps race for it');
  {
    let calls = 0;
    const restore = stubEmail(async () => {
      calls += 1;
      // Slow enough that the second claim is attempted while this is in flight.
      await new Promise((r) => setTimeout(r, 40));
      return { ok: true, transport: 'smtp' };
    });

    const queued = await outbox.enqueue({
      channel: 'email',
      payload: { to: ['c@example.com'], subject: 'Once', html: '<p>hi</p>' },
      entity: 'test', entityId: 'once-1',
    });

    // Five sweeps on the same row at the same moment, which is what a cron
    // firing while somebody loads a page looks like.
    const results = await Promise.all([
      outbox.deliver(queued.id), outbox.deliver(queued.id), outbox.deliver(queued.id),
      outbox.deliver(queued.id), outbox.deliver(queued.id),
    ]);

    check('the provider was called exactly once', calls === 1, String(calls));
    check('exactly one caller sent it', results.filter((r) => r.sent).length === 1,
      JSON.stringify(results.map((r) => (r.sent ? 'sent' : r.skipped ? 'skipped' : 'other'))));
    check('the others found it already claimed', results.filter((r) => r.skipped).length === 4);

    const row = await db.find('outbox', queued.id);
    check('the row is sent', row.status === 'sent', row.status);
    check('and records the transport that did it', row.transport === 'smtp', row.transport);

    restore();
  }

  // --- a claim whose process died ------------------------------------------

  section('A claim that never finished goes back in the queue');
  {
    const queued = await outbox.enqueue({
      channel: 'email',
      payload: { to: ['d@example.com'], subject: 'Stuck', html: '<p>hi</p>' },
      entity: 'test', entityId: 'stale-1',
    });
    // Claim it, then abandon it -- a process that died mid-send.
    await db.claimOutboxMessage(queued.id);
    let row = await db.find('outbox', queued.id);
    check('it is held by a sender', row.status === 'sending', row.status);

    // A fresh claim is not stale, so the sweep must leave it alone.
    const released = await db.releaseStaleOutboxClaims(outbox.STALE_CLAIM_MS);
    check('a live claim is left alone', !released.some((r) => r.id === queued.id));

    // Age the claim past the threshold.
    await db.update('outbox', queued.id, { claimedAt: Date.now() - outbox.STALE_CLAIM_MS - 1000 });
    const releasedNow = await db.releaseStaleOutboxClaims(outbox.STALE_CLAIM_MS);
    check('a dead one is handed back', releasedNow.some((r) => r.id === queued.id));
    row = await db.find('outbox', queued.id);
    check('and is queued again', row.status === 'queued', row.status);
  }

  // --- dedupe --------------------------------------------------------------

  section('A caller that runs twice queues one message');
  {
    const key = `dedupe-test-${Date.now()}`;
    const first = await outbox.enqueue({
      channel: 'email', dedupeKey: key,
      payload: { to: ['e@example.com'], subject: 'Only once', html: '<p>hi</p>' },
    });
    const second = await outbox.enqueue({
      channel: 'email', dedupeKey: key,
      payload: { to: ['e@example.com'], subject: 'Only once', html: '<p>hi</p>' },
    });

    check('the second enqueue returns the first row', first.id === second.id,
      JSON.stringify({ first: first.id, second: second.id }));
    const all = await db.filter('outbox', (r) => r.dedupeKey === key);
    check('and there is only one row', all.length === 1, String(all.length));
  }

  // --- transport failover --------------------------------------------------

  section('A failed transport falls through to the next one');
  {
    delete process.env.MAIL_TRANSPORT;
    process.env.SMTP2GO_API_KEY = 'test-key';
    process.env.SMTP_HOST = 'localhost';

    check('both transports are in the chain', mailer.transportChain().join(',') === 'smtp2go,smtp',
      mailer.transportChain().join(','));
    check('a refused connection is worth another transport',
      mailer.worthAnotherTransport('connect ECONNREFUSED 1.2.3.4:587') === true);
    check('a 502 is worth another transport',
      mailer.worthAnotherTransport('SMTP2GO rejected the message (502): bad gateway') === true);
    check('an unverified sender is not -- every transport will say the same',
      mailer.worthAnotherTransport('domain is not verified') === false);
    check('nor is a rejected recipient',
      mailer.worthAnotherTransport('The server rejected nobody@example.com') === false);

    check('a bad API key is permanent', mailer.isPermanentFailure('SMTP2GO (401): unauthorized') === true);
    check('a timeout is not', mailer.isPermanentFailure('ETIMEDOUT') === false);

    delete process.env.SMTP2GO_API_KEY;
    delete process.env.SMTP_HOST;
  }

  // --- secrets are never queued -------------------------------------------

  section('Nothing that carries a credential is put in the queue');
  {
    process.env.MAIL_TRANSPORT = 'smtp';
    process.env.SMTP_HOST = 'localhost';

    // There is no SMTP server here, so these inline sends genuinely fail --
    // which is fine and is the point. What is being tested is the *route*
    // taken, not the delivery: a message that went inline comes back without
    // `queued`, and above all leaves no row behind holding its secret.
    for (const template of mailer.NEVER_QUEUED) {
      const before = (await db.filter('outbox', () => true)).length;

      const result = await mailer.sendMail({
        to: 'f@example.com', subject: 'Your code is 123456', text: 'x', html: '<p>123456</p>',
        template, entity: 'test', entityId: `secret-${template}`,
      });

      const after = (await db.filter('outbox', () => true)).length;
      check(`"${template}" is not queued`, result.queued !== true, JSON.stringify(result));
      check(`"${template}" leaves nothing in the queue`, after === before, `${after - before} rows`);
    }

    // The belt-and-braces half: a template nobody remembered to list, whose
    // body carries a live link, must still not be queued.
    {
      const before = (await db.filter('outbox', () => true)).length;

      const result = await mailer.sendMail({
        to: 'g@example.com', subject: 'Welcome', text: 'x',
        html: '<a href="https://app.example.com/set-password#token=live-secret-abc">Set your password</a>',
        template: 'a_template_nobody_listed', entity: 'test', entityId: 'secret-unlisted',
      });

      const after = (await db.filter('outbox', () => true)).length;
      check('an unlisted template carrying a token is not queued either', result.queued !== true,
        JSON.stringify(result));
      check('and leaves nothing in the queue', after === before, `${after - before} rows`);

      // The token must not have reached the mail log either, which is the
      // other place a body comes to rest.
      const logged = (await mailer.recentLog(50)).find((e) => e.entityId === 'secret-unlisted');
      check('and the token is redacted in the log', !/live-secret-abc/.test(String(logged?.html)),
        String(logged?.html).slice(0, 120));
    }

    // And the ordinary case still queues, or none of the above proves anything.
    {
      const before = (await db.filter('outbox', () => true)).length;
      const result = await mailer.sendMail({
        to: 'h@example.com', subject: 'Your weekly summary', text: 'x', html: '<p>no secrets here</p>',
        template: 'progress_digest', entity: 'test', entityId: 'ordinary-1',
      });
      const after = (await db.filter('outbox', () => true)).length;
      check('an ordinary message is queued', result.queued === true, JSON.stringify(result));
      check('and really is in the table', after === before + 1, `${after - before} rows`);
    }

    delete process.env.SMTP_HOST;
  }

  // --- the queued row is visible immediately -------------------------------

  section('A queued message is on the Mail page before it is sent');
  {
    process.env.MAIL_TRANSPORT = 'smtp';
    process.env.SMTP_HOST = 'localhost';

    const result = await mailer.sendMail({
      to: 'i@example.com', subject: 'Visible while waiting', text: 'x', html: '<p>hi</p>',
      template: 'progress_digest', entity: 'test', entityId: 'visible-1',
    });

    const logged = (await mailer.recentLog(50)).find((e) => e.entityId === 'visible-1');
    check('the log row exists already', Boolean(logged), 'no row');
    check('and reads as queued', logged?.status === 'queued', logged?.status);

    // Now send it, and check the SAME row is completed rather than a second
    // one appearing beside it.
    const restore = stubEmail(async ({ logId }) => {
      // Mimic what the real sendNow does with a logId.
      if (logId) await db.update('email_log', logId, { status: 'sent', transport: 'smtp', error: null });
      return { ok: true, transport: 'smtp' };
    });
    await outbox.deliver((await db.filter('outbox', (r) => r.entityId === 'visible-1'))[0].id);
    restore();

    const rows = (await mailer.recentLog(50)).filter((e) => e.entityId === 'visible-1');
    check('there is still exactly one log row', rows.length === 1, `${rows.length} rows`);
    check('and it now reads as sent', rows[0]?.status === 'sent', rows[0]?.status);

    delete process.env.SMTP_HOST;
  }

  // --- a payload that will not read back -----------------------------------

  section('A message that cannot be read back is parked, not retried');
  {
    const queued = await outbox.enqueue({
      channel: 'email',
      payload: { to: ['j@example.com'], subject: 'Corrupt', html: '<p>hi</p>' },
      entity: 'test', entityId: 'corrupt-1',
    });
    // Whatever wrote this put something unparseable in the column.
    await db.update('outbox', queued.id, { payload: 'not json at all' });

    const result = await outbox.deliver(queued.id);
    check('it fails rather than throwing', result.failed === true, JSON.stringify(result));
    const row = await db.find('outbox', queued.id);
    check('and is parked rather than retried', row.status === 'failed', row.status);
  }

  // --- an unknown channel --------------------------------------------------

  section('An unknown channel is refused at the door');
  {
    let threw = null;
    try {
      await outbox.enqueue({ channel: 'carrier-pigeon', payload: { to: 'k@example.com' } });
    } catch (err) {
      threw = err.message;
    }
    check('enqueue refuses a channel it cannot send', /carrier-pigeon/.test(String(threw)), String(threw));
  }

  // --- the sweep -----------------------------------------------------------

  section('The sweep sends what is due and leaves the rest');
  {
    const restore = stubEmail(async () => ({ ok: true, transport: 'smtp' }));

    // One due now, one due in an hour.
    const due = await outbox.enqueue({
      channel: 'email', payload: { to: ['l@example.com'], subject: 'Due', html: '<p>hi</p>' },
      entity: 'test', entityId: 'sweep-due',
    });
    const later = await outbox.enqueue({
      channel: 'email', payload: { to: ['m@example.com'], subject: 'Later', html: '<p>hi</p>' },
      entity: 'test', entityId: 'sweep-later', sendAt: Date.now() + 60 * 60 * 1000,
    });

    const result = await outbox.runSweep();
    check('the sweep reports what it did', result.sent >= 1, JSON.stringify(result));
    check('the due message went', (await db.find('outbox', due.id)).status === 'sent');
    check('the scheduled one did not', (await db.find('outbox', later.id)).status === 'queued');

    restore();
  }

  // --- SMS -----------------------------------------------------------------

  section('A text that could not be sent is retried, and its row caught up');
  {
    // A row written as 'queued' by routes/sms.js, standing for a reply whose
    // first attempt could not reach Twilio.
    const row = await db.insert('sms_messages', {
      provider: 'twilio', providerSid: null, channel: 'sms', direction: 'outbound',
      fromNumber: '+15550000000', toNumber: '+15551112222',
      body: 'Retried reply', numMedia: 0, status: 'read',
      deliveryStatus: 'queued', deliveryError: 'Could not reach Twilio',
      createdAt: new Date().toISOString(),
    });

    const queued = await outbox.enqueue({
      channel: 'sms',
      payload: { to: '+15551112222', body: 'Retried reply', messageId: row.id },
      entity: 'sms_message', entityId: row.id,
    });

    // Intercept Twilio at the fetch boundary, the way the app suite does.
    const realFetch = global.fetch;
    let twilioCalls = 0;
    global.fetch = async (url, opts = {}) => {
      if (String(url).startsWith('https://api.twilio.com/')) {
        twilioCalls += 1;
        return { ok: true, status: 201, json: async () => ({ sid: 'SMRETRIED1' }) };
      }
      return realFetch(url, opts);
    };
    process.env.SMS_OUTBOUND_ENABLED = 'on';
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_NUMBER = '+15550000000';

    const result = await outbox.deliver(queued.id);
    global.fetch = realFetch;

    check('the retry sends the text', result.sent === true, JSON.stringify(result));
    check('Twilio was called once', twilioCalls === 1, String(twilioCalls));

    const after = await db.find('sms_messages', row.id);
    check('the thread row now reads as sent', after.deliveryStatus === 'sent', after.deliveryStatus);
    check('and carries the SID the retry got back', after.providerSid === 'SMRETRIED1', after.providerSid);
    check('and the error it used to show is cleared', !after.deliveryError, String(after.deliveryError));

    delete process.env.SMS_OUTBOUND_ENABLED;
  }

  section('A text Twilio will never accept is not retried');
  {
    const realFetch = global.fetch;
    let twilioCalls = 0;
    global.fetch = async (url, opts = {}) => {
      if (String(url).startsWith('https://api.twilio.com/')) {
        twilioCalls += 1;
        // 21610: the recipient has replied STOP. Retrying this is both futile
        // and, for a recipient who opted out, the wrong thing to do.
        return { ok: false, status: 400, json: async () => ({ code: 21610, message: 'Unsubscribed recipient' }) };
      }
      return realFetch(url, opts);
    };
    process.env.SMS_OUTBOUND_ENABLED = 'on';
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_NUMBER = '+15550000000';

    const queued = await outbox.enqueue({
      channel: 'sms',
      payload: { to: '+15553334444', body: 'Should not retry' },
      entity: 'test', entityId: 'sms-permanent',
    });
    const result = await outbox.deliver(queued.id);
    global.fetch = realFetch;

    check('it is failed rather than retrying', result.failed === true, JSON.stringify(result));
    check('and marked permanent', result.permanent === true);
    check('Twilio was only asked once', twilioCalls === 1, String(twilioCalls));

    delete process.env.SMS_OUTBOUND_ENABLED;
  }

  // --- Slack ---------------------------------------------------------------

  section('A Slack post that failed is queued rather than lost');
  {
    const slack = require('../utils/slack');
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';

    const realFetch = global.fetch;
    let attempts = 0;
    global.fetch = async (url, opts = {}) => {
      if (String(url) === 'https://slack.com/api/chat.postMessage') {
        attempts += 1;
        // First call fails the way a Slack outage does; the queued retry works.
        if (attempts === 1) throw new Error('socket hang up');
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: '1700000000.000999', channel: 'C0THREAD' }) };
      }
      return realFetch(url, opts);
    };

    const before = (await db.filter('outbox', (r) => r.channel === 'slack')).length;
    const replied = await slack.replyInThread({
      channelId: 'C0THREAD', threadTs: '1700000000.000001', text: 'An update worth keeping',
    });
    check('the failed reply reports nothing, as before', replied === null, JSON.stringify(replied));

    const rows = await db.filter('outbox', (r) => r.channel === 'slack');
    check('but it is in the queue now', rows.length === before + 1, `${rows.length - before} rows`);

    const row = rows.find((r) => r.entityId === 'C0THREAD');
    check('with the thread it belongs to', row?.payload?.threadTs === '1700000000.000001',
      JSON.stringify(row?.payload));

    const result = await outbox.deliver(row.id);
    global.fetch = realFetch;
    check('and the retry posts it', result.sent === true, JSON.stringify(result));
    check('Slack was tried twice in total', attempts === 2, String(attempts));

    delete process.env.SLACK_BOT_TOKEN;
  }

  // --- the summary ---------------------------------------------------------

  section('The summary answers "is mail stuck?"');
  {
    const summary = await outbox.summary();
    check('it counts by status', typeof summary.counts === 'object' && 'queued' in summary.counts,
      JSON.stringify(summary.counts));
    check('it has seen failures from the tests above', summary.counts.failed >= 2, String(summary.counts.failed));
    check('and sent messages too', summary.counts.sent >= 2, String(summary.counts.sent));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
