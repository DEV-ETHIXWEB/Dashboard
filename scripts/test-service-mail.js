'use strict';

/* Proves the two things that decide whether a client gets a service email, and
   whether they get it twice: the launch announcement that fires when a project
   goes live, and the monthly summary sweep.

   Everything in here is about restraint. Sending the right email is easy; the
   tests that matter are the ones proving we do NOT send on a project with no
   service, on a reopened-and-reclosed project, on a second sweep in the same
   month, or to a client whose campaign has not launched yet.

   Run from the repo root:
     npm run test:service-mail                  */

const { db } = require('../db/setup');
const mailer = require('../utils/mailer');
const launch = require('../utils/serviceLaunch');
const digest = require('../utils/serviceDigest');
const service = require('../utils/serviceEmails');

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
 * Catch what would have been sent, and write the log row the real sender would
 * have written.
 *
 * That second half is the point: both guards in this feature read `email_log`
 * to decide whether a message already went out, so a stub that only counted
 * calls would prove the sends and nothing about the restraint.
 */
function captureSends() {
  const sent = [];
  const original = mailer.sendTemplate;
  mailer.sendTemplate = async (args) => {
    sent.push(args);
    await db.insert('email_log', {
      toEmails: args.to,
      subject: args.message.subject,
      template: args.template,
      status: 'sent',
      transport: 'test',
      entity: args.entity,
      entityId: args.entityId,
      createdAt: new Date().toISOString(),
    });
    return { ok: true };
  };
  return { sent, restore: () => { mailer.sendTemplate = original; } };
}

async function makeClient(id, name, email) {
  return db.insert('users', { id, name, email, role: 'client', company: 'Test Co' });
}

async function makeProject(fields) {
  return db.insert('projects', {
    name: 'Test project', type: 'General', status: 'In Progress',
    createdAt: new Date().toISOString(), ...fields,
  });
}

async function main() {
  await require('../db/setup').seed();

  // --- the mapping itself --------------------------------------------------

  section('Every service key maps to a template that renders');
  {
    check('there are twenty-two of them', service.SERVICE_KEYS.length === 22, `got ${service.SERVICE_KEYS.length}`);
    const broken = service.SERVICE_KEYS.filter((key) => {
      const built = service.launchFor(key, { clientName: 'Test' });
      return !built || !built.message?.subject || !built.message?.html || !built.message?.text;
    });
    check('each one builds a complete message', broken.length === 0, broken.join(', '));
    check('an unknown key builds nothing at all', service.launchFor('not_a_service') === null);
  }

  // --- the launch announcement ---------------------------------------------

  section('A project going live announces itself, once');
  {
    const { sent, restore } = captureSends();
    const client = await makeClient('svc-c1', 'David Shaw', 'david@example.com');
    const project = await makeProject({
      id: 'svc-p1', clientId: client.id, service: 'website_redesign',
      serviceContext: JSON.stringify({ domain: 'brightpath-retail.com' }),
    });

    await launch.onStatusChange(project, 'In Progress', 'Complete');
    check('the client was emailed', sent.length === 1, `sent ${sent.length}`);
    check('with the website launch template', sent[0]?.template === 'service_website_redesign_live', sent[0]?.template);
    check('to their own address', sent[0]?.to === 'david@example.com');
    check('the message carries the domain from the context blob',
      Boolean(sent[0]?.message?.html?.includes('brightpath-retail.com')));
    check('the log row points at the project', sent[0]?.entityId === 'svc-p1');

    // Reopened for a snag, then closed again -- an ordinary week.
    await launch.onStatusChange(project, 'In Progress', 'Complete');
    check('closing it a second time sends nothing', sent.length === 1, `sent ${sent.length}`);

    // And an edit to a project that was already live.
    await launch.onStatusChange(project, 'Complete', 'Complete');
    check('saving an already-live project sends nothing', sent.length === 1, `sent ${sent.length}`);

    restore();
  }

  section('Projects that should announce nothing, announce nothing');
  {
    const { sent, restore } = captureSends();
    const client = await makeClient('svc-c2', 'Jane Patel', 'jane@example.com');

    const plain = await makeProject({ id: 'svc-p2', clientId: client.id });
    await launch.onStatusChange(plain, 'In Progress', 'Complete');
    check('a project with no service key stays quiet', sent.length === 0, `sent ${sent.length}`);

    const movingOn = await makeProject({ id: 'svc-p3', clientId: client.id, service: 'seo' });
    await launch.onStatusChange(movingOn, 'To Do', 'In Progress');
    check('a project merely starting work stays quiet', sent.length === 0, `sent ${sent.length}`);

    const typo = await makeProject({ id: 'svc-p4', clientId: client.id, service: 'websight_redesign' });
    const result = await launch.announce(typo);
    check('a misspelled service key sends nothing', sent.length === 0, `sent ${sent.length}`);
    check('and says why, by name', String(result.reason).includes('websight_redesign'), result.reason);

    const orphan = await makeProject({ id: 'svc-p5', clientId: 'nobody', service: 'seo' });
    const orphanResult = await launch.announce(orphan);
    check('a project whose client does not exist sends nothing', sent.length === 0);
    check('and says so rather than throwing', orphanResult.sent === false);

    restore();
  }

  section('Live status is recognised however it was typed');
  {
    check('Complete', launch.isLaunched('Complete'));
    check('completed, lower case', launch.isLaunched('completed'));
    check('Live', launch.isLaunched('Live'));
    check('Launched, with stray spacing', launch.isLaunched('  Launched '));
    check('In Progress is not live', !launch.isLaunched('In Progress'));
    check('an empty status is not live', !launch.isLaunched(''));
  }

  // --- the monthly summaries -----------------------------------------------

  section('The monthly sweep sends one summary per client per month');
  {
    const { sent, restore } = captureSends();
    const client = await makeClient('svc-c3', 'Omar Haddad', 'omar@example.com');

    // Two live ad projects for one client. They want one email about their
    // advertising, not two.
    await makeProject({
      id: 'svc-p6', clientId: client.id, service: 'google_ads', status: 'Complete',
      serviceContext: JSON.stringify({ spend: '£1,180', leads: '47', costPerLead: '£25' }),
    });
    await makeProject({
      id: 'svc-p7', clientId: client.id, service: 'meta_ads', status: 'Complete',
      serviceContext: JSON.stringify({ bestChannel: 'Local Services Ads' }),
    });
    // Search as well, which is a different summary and should arrive separately.
    await makeProject({
      id: 'svc-p8', clientId: client.id, service: 'seo', status: 'Live',
      serviceContext: JSON.stringify({ topTen: '14' }),
    });
    // Not launched yet: nothing to report, so nothing reported.
    await makeProject({ id: 'svc-p9', clientId: client.id, service: 'llm_chatbot', status: 'In Progress' });

    // A summary only follows a launch we actually sent, so these three have to
    // have been announced first. That rule is what makes importing existing
    // clients safe, and it is tested on its own further down.
    for (const id of ['svc-p6', 'svc-p7', 'svc-p8']) {
      await launch.announce(await db.find('projects', id));
    }
    const launches = sent.length;
    check('the three live projects announced themselves first', launches === 3, `sent ${launches}`);

    const firstOfMonth = new Date(2026, 9, 1, 9, 0, 0);
    const result = await digest.runSweep({ now: firstOfMonth });

    check('two summaries went out, not three', sent.length - launches === 2, `sent ${sent.length - launches}`);
    const templates = sent.slice(launches).map((s) => s.template).sort();
    check('one about the ads', templates.includes('update_ads_performance'), templates.join(', '));
    check('one about search', templates.includes('update_seo_ranking'), templates.join(', '));
    check('nothing about the chatbot that is not live yet', !templates.includes('update_chatbot_performance'));
    check('the sweep reports what it sent', result.sent === 2, JSON.stringify(result));

    const ads = sent.find((s) => s.template === 'update_ads_performance');
    check('the ads summary merges both projects’ figures',
      ads.message.html.includes('£1,180') && ads.message.html.includes('Local Services Ads'));
    check('it is addressed to the client', ads.to === 'omar@example.com');
    check('and filed under the client and the month', ads.entityId === 'svc-c3:2026-10', ads.entityId);

    // The cron runs daily. The ninth must not resend the first's work.
    const ninth = new Date(2026, 9, 9, 9, 0, 0);
    await digest.runSweep({ now: ninth });
    check('running again the same month sends nothing', sent.length - launches === 2, `sent ${sent.length - launches}`);

    // Next month is a new story.
    const nextMonth = new Date(2026, 10, 2, 9, 0, 0);
    await digest.runSweep({ now: nextMonth });
    check('the following month sends them again', sent.length - launches === 4, `sent ${sent.length - launches}`);

    restore();
  }

  section('The sweep knows when it is too late to be useful');
  {
    const { sent, restore } = captureSends();
    const lateInMonth = new Date(2026, 11, 24, 9, 0, 0);
    const result = await digest.runSweep({ now: lateInMonth });
    check('a sweep on the 24th sends nothing', sent.length === 0, `sent ${sent.length}`);
    check('and says why', String(result.skipped).includes('too late'), JSON.stringify(result));

    const forced = await digest.runSweep({ now: lateInMonth, force: true });
    check('an admin forcing it is obeyed', forced.sent > 0, JSON.stringify(forced));
    restore();
  }

  section('The period label reads like a person wrote it');
  {
    check('October sweep reports on September',
      digest.periodLabel(new Date(2026, 9, 1)).startsWith('September'), digest.periodLabel(new Date(2026, 9, 1)));
    check('January sweep reports on last December',
      digest.periodLabel(new Date(2026, 0, 3)) === 'December 2025', digest.periodLabel(new Date(2026, 0, 3)));
    check('the dedupe key is year and month', digest.periodKey(new Date(2026, 9, 9)) === '2026-10');
  }

  // --- the context blob ----------------------------------------------------

  section('A malformed context blob costs detail, not the email');
  {
    const { sent, restore } = captureSends();
    const client = await makeClient('svc-c4', 'Priya Nair', 'priya@example.com');
    const project = await makeProject({
      id: 'svc-p10', clientId: client.id, service: 'dashboard', status: 'In Progress',
      serviceContext: '{ this is not json',
    });

    await launch.onStatusChange(project, 'In Progress', 'Complete');
    check('the email still went', sent.length === 1, `sent ${sent.length}`);
    check('and it greets them by name', sent[0]?.message?.html?.includes('Priya'));
    check('a broken blob parses as empty', Object.keys(launch.parseContext('{ nope')).length === 0);
    check('an array is not a context either', Object.keys(launch.parseContext('[1,2]')).length === 0);
    restore();
  }

  // --- the two guards a migration depends on -------------------------------

  section('Importing existing clients does not mail the people being imported');
  {
    const { sent, restore } = captureSends();

    // What a migration actually looks like: established clients arrive with
    // their projects already live, because they have been live for a year.
    for (const i of [1, 2, 3]) {
      await makeClient(`mig-c${i}`, `Migrated ${i}`, `mig${i}@example.com`);
      await makeProject({
        id: `mig-p${i}`, clientId: `mig-c${i}`, service: 'seo', status: 'Complete',
      });
    }

    const result = await digest.runSweep({ now: new Date(2026, 9, 2, 9, 0, 0) });
    check('the monthly sweep mails none of them', sent.length === 0, `sent ${sent.length}`);
    check('because none of them was ever told it went live', result.sent === 0, JSON.stringify(result));

    // Once a launch HAS gone out, the follow-up is wanted.
    await launch.announce(await db.find('projects', 'mig-p1'));
    check('announcing one of them sends its launch email', sent.length === 1, `sent ${sent.length}`);

    await digest.runSweep({ now: new Date(2026, 9, 3, 9, 0, 0) });
    check('and then only that one gets a summary', sent.length === 2, `sent ${sent.length}`);
    check('the other two are still silent',
      !sent.some((s) => String(s.entityId).startsWith('mig-c2') || String(s.entityId).startsWith('mig-c3')));

    restore();
  }

  section('The pause switch holds automated mail, and only that');
  {
    const { sent, restore } = captureSends();
    process.env.MAIL_AUTOMATION_PAUSED = 'true';

    const client = await makeClient('pause-c1', 'Paused Client', 'paused@example.com');
    const project = await makeProject({
      id: 'pause-p1', clientId: client.id, service: 'website_redesign', status: 'In Progress',
    });

    await launch.onStatusChange(project, 'In Progress', 'Complete');
    check('a project going live sends nothing while paused', sent.length === 0, `sent ${sent.length}`);

    const swept = await digest.runSweep({ now: new Date(2026, 9, 2, 9, 0, 0) });
    check('the monthly sweep sends nothing while paused', sent.length === 0, `sent ${sent.length}`);
    check('and says it was held', String(swept.skipped).includes('paused'), JSON.stringify(swept));

    const forced = await digest.runSweep({ now: new Date(2026, 9, 2, 9, 0, 0), force: true });
    check('forcing the sweep does not override the pause', forced.sent === 0, JSON.stringify(forced));

    delete process.env.MAIL_AUTOMATION_PAUSED;
    await launch.onStatusChange(project, 'In Progress', 'Complete');
    check('clearing the pause lets it send again', sent.length === 1, `sent ${sent.length}`);

    restore();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
