/**
 * Service emails: the ones that say "this is live, and here is what it does for you".
 *
 * Everything else in this app writes to someone about a thing that went wrong,
 * is due, or needs a decision. These do the opposite -- they are the only
 * messages a client gets that are purely good news, and they are often the
 * first thing a new client reads from us after signing.
 *
 * Three rules shape every line of copy in this file.
 *
 * 1. The reader is a business owner, usually past thirty, who bought an
 *    outcome and not a technology. "Headless architecture" means nothing to
 *    them; "pages appear almost instantly, even on a weak mobile signal" is
 *    the same fact in the only form that is worth sending. So no acronym
 *    survives unless it is also the name of the thing they are paying for
 *    (SEO, CRM, WCAG), and every one of those gets explained the first time it
 *    appears.
 *
 * 2. The reader should finish the email knowing whether they have to do
 *    anything. Nearly always the answer is no, and saying so plainly is worth
 *    more than another bullet about features. Every message here ends with
 *    that answer before it ends with a button.
 *
 * 3. Nothing is promised that a report cannot later show. Search work does not
 *    move for two to three months and this file says so; a new ad account
 *    spends its first fortnight learning and this file says that too. An email
 *    that oversells is a complaint arriving six weeks late.
 *
 * The design is not re-invented here. Every block comes from emailTemplates.js
 * -- same masthead, tokens, panels, buttons and footer as the ticket and
 * billing mail -- so a client who has had one of ours already recognises this
 * one before reading a word of it.
 */

const t = require('./emailTemplates');
const appUrl = require('./appUrl');

// --- where a message can send someone ---------------------------------------
//
// Only routes that exist in the app. A button to a 404 is worse than no button,
// and every one of these is checked against the portal's own route table.

function baseUrl() {
  return appUrl.baseUrl();
}

function portalLink(path = '') {
  const base = baseUrl();
  return base ? `${base}/portal${path}` : null;
}

const links = {
  home: () => portalLink(''),
  projects: () => portalLink('/projects'),
  progress: () => portalLink('/progress'),
  tickets: () => portalLink('/tickets'),
  reports: () => portalLink('/reports'),
  messages: () => portalLink('/messages'),
  billing: () => portalLink('/billing'),
};

/** "Hi David." / "Hi there." -- never "Dear valued customer". */
function greet(clientName) {
  const name = String(clientName || '').trim().split(/\s+/)[0];
  return name ? `Hi ${name}.` : 'Hi there.';
}

/**
 * The one shape every message in this file is built from.
 *
 * Writing twenty-two of these by hand guarantees twenty-two slightly different
 * emails; routing them all through one function guarantees the opposite. The
 * order of the blocks is fixed on purpose -- what happened, what it gives you,
 * the one thing worth knowing, whether you need to act -- because that is the
 * order the questions arrive in the reader's head.
 *
 * Boxes are rationed. `fact()` exists precisely so that plain information does
 * not need a border, and three stacked panels teach the eye to skip all of
 * them, so a message gets the bullet panel plus at most one callout.
 */
function serviceEmail({
  eyebrow,
  title,
  preheader,
  hero = 'check-badge',
  line = null,
  intro,
  second = null,
  facts = [],
  detail = null,
  getsTitle = 'What this gives you',
  gets = [],
  note = null,
  closing = 'Nothing is needed from you. We will keep you posted as things move.',
  cta = null,
  secondaryCta = null,
  reason,
  textLines = [],
}) {
  const blocks = [
    t.paragraph(intro),
    second ? t.paragraph(second) : '',
    gets.length ? t.panel({ tone: 'info', title: getsTitle, html: t.bulletList(gets) }) : '',
    detail ? t.detailPanel(detail) : '',
    ...facts.filter(Boolean).map((f) => t.fact(f.label, f.value)),
    note ? t.callout(note) : '',
    closing ? t.paragraph(closing, { muted: true, size: 13 }) : '',
  ].filter(Boolean);

  return {
    html: t.renderEmail({
      preheader,
      eyebrow,
      hero,
      title,
      actor: line ? { line } : null,
      blocks,
      cta,
      secondaryCta,
      reason,
    }),
    text: t.renderText(textLines),
  };
}

/** The plain-text twin, assembled the same way for every message. */
function serviceText({ title, intro, getsTitle, gets = [], facts = [], note = null, closing, cta }) {
  return [
    title,
    '',
    intro,
    '',
    gets.length ? `${getsTitle}:` : null,
    ...gets.map((g) => `- ${g}`),
    gets.length ? '' : null,
    ...facts.filter(Boolean).map((f) => `${f.label}: ${f.value}`),
    facts.length ? '' : null,
    note ? `${note.title}: ${note.body}` : null,
    note ? '' : null,
    closing || null,
    cta && cta.url ? '' : null,
    cta && cta.url ? `${cta.label}: ${cta.url}` : null,
  ];
}

/**
 * Both halves of a message from one description.
 *
 * The HTML and the plain-text part drifting apart is the usual way a template
 * set rots: someone edits the markup, nobody opens the text twin for a year,
 * and the fallback a corporate mail client actually shows is describing last
 * year's product. Here they are generated from the same object, so they cannot
 * disagree.
 */
function build(spec) {
  const { subject, ...rest } = spec;
  return {
    subject,
    ...serviceEmail({ ...rest, textLines: serviceText(rest) }),
  };
}


// --- website -----------------------------------------------------------------

/**
 * Launch day. The one fear every owner has is that the links customers already
 * hold will break, so that is answered in the first two sentences and nothing
 * else competes with it.
 */
function websiteRedesignLive({ clientName, domain = null, siteUrl = null } = {}) {
  const site = siteUrl || (domain ? `https://${String(domain).replace(/^https?:\/\//, '')}` : null);
  return build({
    subject: 'Your new website is live',
    eyebrow: 'Website redesign',
    title: 'Your new website is live',
    preheader: 'Live now, and every link people already had still works.',
    line: domain ? `Now serving ${domain}` : null,
    intro: `${greet(clientName)} Your new website went live today.`,
    second: 'Every old page still answers at the same address, so saved links, printed cards and anything Google knows about you all still work.',
    getsTitle: 'What changed for your customers',
    gets: [
      'It reads properly on a phone, where most of your visitors are',
      'Pages open in about a second instead of five',
      'Every page has one clear way to get in touch',
    ],
    facts: [site ? { label: 'Your site', value: site } : null],
    closing: 'Have a look around. Anything that reads wrong, tell us and we will change it.',
    cta: site ? { label: 'View your new site', url: site } : (links.projects() ? { label: 'Open your project', url: links.projects() } : null),
    reason: 'Sent because your website redesign went live.',
  });
}

/**
 * The hardest one to write, because what was bought is invisible: nothing on
 * screen changed. So it does not describe the architecture at all, only the
 * three things the owner will notice over the next year.
 */
function headlessLive({ clientName, siteUrl = null } = {}) {
  return build({
    subject: 'Your site now runs on its new foundation',
    eyebrow: 'Headless architecture',
    title: 'Your site now runs on its new foundation',
    preheader: 'Same site, rebuilt underneath. Faster now, easier to add to later.',
    intro: `${greet(clientName)} We have finished rebuilding the part of your website nobody sees.`,
    second: 'It looks exactly as it did yesterday. What changed is how it is delivered.',
    getsTitle: 'What you will notice',
    gets: [
      'Pages arrive almost instantly, even on a weak mobile signal',
      'Wording and price changes go live in seconds, not days',
      'Booking, payments or a shop can be added without starting again',
    ],
    closing: 'Nothing is needed from you. Everything we build next sits on top of this.',
    cta: siteUrl ? { label: 'View your site', url: siteUrl } : (links.projects() ? { label: 'Open your project', url: links.projects() } : null),
    reason: 'Sent because the rebuild of your site foundation finished.',
  });
}

/** One page, one job. The email is as focused as the page it announces. */
function landingPageLive({ clientName, pageName = null, pageUrl = null, campaign = null } = {}) {
  return build({
    subject: pageName ? `Your "${pageName}" landing page is live` : 'Your new landing page is live',
    eyebrow: 'Landing page',
    title: 'Your new landing page is live',
    preheader: 'One offer, one action, and every enquiry counted.',
    line: campaign ? `Built for ${campaign}` : null,
    intro: `${greet(clientName)} Your new landing page is live and ready for traffic.`,
    second: 'It is deliberately narrower than your website: one offer, one thing to do, and no menu to wander off into.',
    getsTitle: 'How it is built',
    gets: [
      'The wording matches the advert that sends people here',
      'Every visit, call and form is counted and traced',
      'We can test a second version and keep the winner',
    ],
    facts: [pageUrl ? { label: 'The page', value: pageUrl } : null],
    closing: 'Nothing is needed from you. The numbers are worth reading after a few hundred visits.',
    cta: pageUrl ? { label: 'View the page', url: pageUrl } : (links.projects() ? { label: 'Open your project', url: links.projects() } : null),
    reason: 'Sent because a landing page was published for your account.',
  });
}

/**
 * A care plan is a promise about things that will not happen, which is hard to
 * make feel like value. Specifics do it: not "we monitor your site" but "we
 * hear about it before you do".
 */
function maintenanceLive({ clientName, plan = null, backupTime = 'every night' } = {}) {
  return build({
    subject: 'Your website care plan is live',
    eyebrow: 'Maintenance & security',
    title: 'Your website care plan is live',
    preheader: 'Updates, backups and monitoring are ours from today.',
    line: plan ? `${plan} plan` : null,
    intro: `${greet(clientName)} From today, keeping your website safe and up to date is our job rather than yours.`,
    second: 'Most sites that fail are not attacked. They simply go a year without an update and break on an ordinary Tuesday.',
    getsTitle: 'What we do, so you do not have to',
    gets: [
      'Updates and security patches applied and tested for you',
      `A full backup taken ${backupTime}, kept away from the site`,
      'Monitoring round the clock, so we hear about trouble before you do',
    ],
    closing: 'If anything ever goes wrong, raise a ticket or just reply to this email.',
    cta: links.tickets() ? { label: 'Open your support area', url: links.tickets() } : null,
    reason: 'Sent because your website care plan started.',
  });
}


// --- AI ----------------------------------------------------------------------

/**
 * The fear here is not that the assistant will be unhelpful, it is that it will
 * invent something and embarrass the business. So its limits lead, rather than
 * being buried as a disclaimer at the bottom.
 */
function knowledgeChatbotLive({ clientName, siteUrl = null, sources = null } = {}) {
  return build({
    subject: 'Your website assistant is answering questions',
    eyebrow: 'Knowledge chatbot',
    title: 'Your website assistant is answering questions',
    preheader: 'It answers from your own pages, and fetches a person when it should.',
    intro: `${greet(clientName)} The assistant on your website is live and answering visitors.`,
    second: 'It is held to your own material. If the answer is not there, it says so and offers a person rather than guessing.',
    getsTitle: 'How it behaves',
    gets: [
      'Answers from your pages, prices and policies, not guesswork',
      'Replies in seconds, at two in the morning included',
      'Shows you every question asked, including the ones it could not answer',
    ],
    facts: [sources ? { label: 'Taught from', value: sources } : null],
    closing: 'Nothing is needed from you. We review the unanswered questions with you each month.',
    cta: siteUrl ? { label: 'Try it on your site', url: siteUrl } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because your website assistant went live.',
  });
}

/** The upgrade email. It has to justify a change the client cannot see. */
function llmChatbotLive({ clientName, siteUrl = null } = {}) {
  return build({
    subject: 'Your assistant can now hold a real conversation',
    eyebrow: 'LLM chatbot',
    title: 'Your assistant can now hold a real conversation',
    preheader: 'It understands ordinary phrasing, and remembers the thread.',
    intro: `${greet(clientName)} Your assistant has been upgraded.`,
    second: 'The old kind matched keywords, so customers had to phrase things its way. This one reads a question the way a person would.',
    getsTitle: 'What it can do now',
    gets: [
      'Understands a question however it is phrased',
      'Remembers the thread, so "how much is that one?" makes sense',
      'Stays inside what we told it, and admits when it does not know',
    ],
    closing: 'Nothing is needed from you. It is already live on your site.',
    cta: siteUrl ? { label: 'Try it on your site', url: siteUrl } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because your chat assistant was upgraded.',
  });
}

/**
 * The one service that replaces work a human was doing, which makes the tone
 * delicate. Written as cover, not replacement: the hours nobody was at the desk
 * anyway. The callout survives the trim because "what it will not do" is the
 * question this email exists to answer.
 */
function csrAutomationLive({ clientName, hours = 'around the clock' } = {}) {
  return build({
    subject: 'Your front desk now answers after hours',
    eyebrow: 'Automation & CSR',
    title: 'Your front desk now answers after hours',
    preheader: 'Enquiries arriving at ten at night are answered and waiting for you.',
    intro: `${greet(clientName)} The enquiries that used to arrive while nobody was at a desk are now being answered.`,
    second: 'Most people who write outside your hours do not come back. They go to whoever answered.',
    getsTitle: 'What it handles',
    gets: [
      `Routine questions answered ${hours}`,
      'Bookings, quotes and callbacks taken and confirmed on the spot',
      'Everything written into your system, not left in a chat window',
    ],
    note: {
      tone: 'info',
      title: 'What it will not do',
      body: 'It does not negotiate, promise dates, or handle a complaint. Those go to your team with the whole conversation attached.',
    },
    closing: 'Each morning you will find the overnight enquiries already logged and sorted.',
    cta: links.messages() ? { label: 'See your enquiries', url: links.messages() } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because automated customer response went live for your account.',
  });
}

/** Reassurance, sold as a feature. The client sets the rules; we say so. */
function humanHandoffLive({ clientName } = {}) {
  return build({
    subject: 'A real person is one step away',
    eyebrow: 'Human handoff',
    title: 'A real person is one step away',
    preheader: 'Your assistant knows when to stop and fetch somebody.',
    intro: `${greet(clientName)} Your assistant can now hand a conversation to your team, and it knows when it should.`,
    second: 'This is the piece that makes automation safe to leave running. Nobody gets stuck talking to software.',
    getsTitle: 'When it steps aside',
    gets: [
      'The moment somebody asks for a person, or sounds frustrated',
      'When the question is about money, a deadline, or a problem',
      'Out of hours it takes a message and queues it for morning',
    ],
    closing: 'Which topics must always reach a person is your choice. Tell us and we will change it.',
    cta: links.messages() ? { label: 'See handed-over chats', url: links.messages() } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because human handoff was switched on for your assistant.',
  });
}


// --- growth ------------------------------------------------------------------

/**
 * The service most likely to end in a disappointed client, because it is the
 * only one where the gap between starting and seeing anything is measured in
 * months. The timeline keeps its box through the trim: an expectation set here
 * costs nothing, and the same expectation corrected in week six costs the
 * relationship.
 */
function seoLive({ clientName, area = null, firstReport = 'at the end of next month' } = {}) {
  return build({
    subject: 'Your search work has started',
    eyebrow: 'SEO',
    title: 'Your search work has started',
    preheader: 'Underway now, with an honest word about how long it takes.',
    line: area ? `Focused on ${area}` : null,
    intro: `${greet(clientName)} We have started the work that gets you found when somebody searches for what you do.`,
    second: 'SEO means earning a place in the ordinary Google results, the ones nobody pays for.',
    getsTitle: 'What we are doing',
    gets: [
      'Fixing the faults that stop Google reading some of your pages',
      'Rewriting pages around the words customers actually type',
      'Making your business listing match everywhere it appears',
    ],
    note: {
      tone: 'warn',
      title: 'The honest timeline',
      body: 'Expect first movement eight to twelve weeks in, and the real gains after six months. Anyone promising page one in a fortnight is guessing.',
    },
    closing: `Nothing is needed from you. Your first report arrives ${firstReport}.`,
    cta: links.reports() ? { label: 'Open your reports', url: links.reports() } : (links.progress() ? { label: 'See progress', url: links.progress() } : null),
    reason: 'Sent because search optimisation work started on your account.',
  });
}

/**
 * Paid search, where the client is now spending daily and will check tomorrow.
 * Two things must be said before anything else: the budget cannot run away, and
 * the first fortnight looks worse than the result.
 */
function googleAdsLive({ clientName, budget = null, area = null, lsa = false } = {}) {
  return build({
    subject: 'Your Google Ads are live',
    eyebrow: 'Google Ads' + (lsa ? ' + LSA' : ''),
    title: 'Your Google Ads are live',
    preheader: 'Running now, budget capped, every call traced to its ad.',
    line: area ? `Showing across ${area}` : null,
    intro: `${greet(clientName)} Your adverts are live and showing to people searching for what you sell.`,
    second: lsa
      ? 'That includes Local Services Ads, the ones above everything else with the green Google Guaranteed tick, where you pay per enquiry rather than per click.'
      : 'They sit at the top of the results page, above the ordinary listings.',
    getsTitle: 'How it is set up',
    gets: [
      'Shown only in your area, only for searches worth paying for',
      'Every call and form traced back to the advert that caused it',
      'The budget is capped, so a busy week cannot overspend',
    ],
    facts: [
      budget ? { label: 'Monthly budget', value: budget } : null,
      area ? { label: 'Area covered', value: area } : null,
    ],
    note: {
      tone: 'warn',
      title: 'The first two weeks will look expensive',
      body: 'Google spends the opening fortnight learning who responds to you, and the cost per enquiry is always highest then. Judge it on week four.',
    },
    closing: 'Nothing is needed from you. We watch it daily.',
    cta: links.reports() ? { label: 'See your ad results', url: links.reports() } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because your Google Ads campaigns went live.',
  });
}

/** The trap here is vanity numbers, so the email names what it is judged on. */
function metaAdsLive({ clientName, budget = null, area = null } = {}) {
  return build({
    subject: 'Your Facebook and Instagram ads are live',
    eyebrow: 'Meta ads',
    title: 'Your Facebook and Instagram ads are live',
    preheader: 'Running now, and measured in enquiries rather than likes.',
    line: area ? `Showing across ${area}` : null,
    intro: `${greet(clientName)} Your adverts are now running on Facebook and Instagram.`,
    second: 'Nobody on Facebook is searching for you, so the job is putting the right offer in front of the right people at the right moment.',
    getsTitle: 'How it is set up',
    gets: [
      'Shown to people near you who match your existing customers',
      'Several versions running against each other, so the better one wins',
      'Measured in enquiries and bookings, not likes and follows',
    ],
    facts: [
      budget ? { label: 'Monthly budget', value: budget } : null,
      area ? { label: 'Area covered', value: area } : null,
    ],
    closing: 'Nothing is needed from you. The first fortnight is mostly learning; the numbers settle after that.',
    cta: links.reports() ? { label: 'See your ad results', url: links.reports() } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because your Facebook and Instagram campaigns went live.',
  });
}

/** Content. The promise that matters is that nothing goes out unapproved. */
function socialReelsLive({ clientName, cadence = null, channels = null } = {}) {
  return build({
    subject: 'Your social calendar is running',
    eyebrow: 'Social & reels',
    title: 'Your social calendar is running',
    preheader: 'Posts planned and scheduled ahead. You approve everything first.',
    line: cadence ? `Posting ${cadence}` : null,
    intro: `${greet(clientName)} Your social media now runs to a plan rather than to whoever remembers on a Friday.`,
    second: 'Everything is written and scheduled ahead, which is the only way it keeps happening during a busy month.',
    getsTitle: 'What you get',
    gets: [
      'A fixed schedule, with posts prepared well before they are due',
      'Short vertical video, because that is what the apps now show',
      'Written in your voice, and nothing published until you approve it',
    ],
    facts: [
      channels ? { label: 'Channels', value: channels } : null,
      cadence ? { label: 'How often', value: cadence } : null,
    ],
    closing: 'The first batch comes to you for approval shortly.',
    cta: links.progress() ? { label: 'See what is planned', url: links.progress() } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because your social content schedule started.',
  });
}

/** Deliverability is the real product here, explained without the jargon. */
function emailMarketingLive({ clientName, listSize = null } = {}) {
  return build({
    subject: 'Your email marketing is switched on',
    eyebrow: 'Email marketing',
    title: 'Your email marketing is switched on',
    preheader: 'Your welcome sequence runs itself, and your mail reaches inboxes.',
    intro: `${greet(clientName)} Your email marketing is set up and the automatic messages have started going out.`,
    second: 'The people on your list already know you, which makes them the cheapest customers you will ever reach again.',
    getsTitle: 'What is running',
    gets: [
      'A welcome sequence that greets every new enquiry by itself',
      'Your sending set up properly, so mail lands in inboxes not spam',
      'Plain numbers afterwards: who opened, who clicked, who replied',
    ],
    facts: [listSize ? { label: 'People on your list', value: listSize } : null],
    closing: 'Nothing is needed from you. We will bring you campaign ideas rather than wait to be asked.',
    cta: links.reports() ? { label: 'See your email results', url: links.reports() } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because your email marketing was switched on.',
  });
}

/** Plumbing, sold as the end of re-typing. That is the benefit people feel. */
function crmIntegrationLive({ clientName, crmName = null, sources = null } = {}) {
  return build({
    subject: 'Your enquiries now land in one place',
    eyebrow: 'CRM integration',
    title: 'Your enquiries now land in one place',
    preheader: 'Calls, forms and chats arrive in your system automatically.',
    line: crmName ? `Connected to ${crmName}` : null,
    intro: `${greet(clientName)} Every enquiry now goes straight into ${crmName || 'your system'} by itself.`,
    second: 'Until today a lead arriving by phone, by form and by chat ended up in three places, and somebody had to copy them across.',
    getsTitle: 'What changed',
    gets: [
      'Calls, forms and chats all arrive as records, automatically',
      'Nobody re-types anything, so nothing is mistyped or forgotten',
      'Each record says where the lead came from',
    ],
    facts: [
      crmName ? { label: 'Your system', value: crmName } : null,
      sources ? { label: 'Feeding into it', value: sources } : null,
    ],
    closing: 'Worth watching for a week. Tell us if anything lands in the wrong place.',
    cta: links.home() ? { label: 'Open your portal', url: links.home() } : null,
    reason: 'Sent because your CRM connection went live.',
  });
}


// --- data --------------------------------------------------------------------

/** The antidote to the monthly spreadsheet. Short, because the thing is simple. */
function dashboardLive({ clientName, dashboardUrl = null } = {}) {
  return build({
    subject: 'Your dashboard is ready',
    eyebrow: 'Dashboard',
    title: 'Your dashboard is ready',
    preheader: 'One screen with the numbers that matter, updating on its own.',
    intro: `${greet(clientName)} Your dashboard is ready. It is the quickest answer to "how are we doing?" you will have.`,
    getsTitle: 'What is on it',
    gets: [
      'Enquiries, calls and bookings, against last month',
      'Where they came from, so you can see what is earning its keep',
      'Readable on your phone, which is where you will check it',
    ],
    closing: 'If a number you care about is missing, tell us and we will add it.',
    cta: dashboardUrl ? { label: 'Open your dashboard', url: dashboardUrl } : (links.home() ? { label: 'Open your dashboard', url: links.home() } : null),
    reason: 'Sent because your dashboard was set up.',
  });
}

/**
 * Nobody buys tracking because they want it. They buy it because without it
 * every other report is a guess, and the email says exactly that.
 */
function analyticsLive({ clientName, tracked = null } = {}) {
  return build({
    subject: 'Your tracking is in place',
    eyebrow: 'Analytics',
    title: 'Your tracking is in place',
    preheader: 'Calls, forms and bookings now counted properly and traced to source.',
    intro: `${greet(clientName)} Your website is now measuring the things that matter.`,
    second: 'Most sites count visits, which tells you almost nothing. Yours counts enquiries, and records what caused each one.',
    getsTitle: 'What is being measured',
    gets: [
      'Calls, forms and bookings, each counted once and counted right',
      'The page, advert or search that led to each one',
      'Cookie consent handled properly, so it is lawful as well as accurate',
    ],
    facts: [tracked ? { label: 'Now tracking', value: tracked } : null],
    closing: 'Every report we send you from here on rests on this. Give it a few weeks to gather.',
    cta: links.reports() ? { label: 'Open your reports', url: links.reports() } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because analytics tracking was set up on your site.',
  });
}

/** Sets the shape of every monthly report they will get from now on. */
function monthlyReportingLive({ clientName, firstReport = 'at the start of next month' } = {}) {
  return build({
    subject: 'Your monthly reporting has started',
    eyebrow: 'Monthly reporting',
    title: 'Your monthly reporting has started',
    preheader: 'A short, plain-English summary each month. No charts to decode.',
    intro: `${greet(clientName)} From this month you will get a written summary of how everything is going.`,
    second: 'It is deliberately short and deliberately plain. A report that needs explaining has failed.',
    getsTitle: 'What each one tells you',
    gets: [
      'What happened last month, and what it means',
      'What we did about it, and what it cost',
      'What is planned for the month ahead',
    ],
    facts: [{ label: 'First report', value: `Arrives ${firstReport}` }],
    closing: 'Reply to any report with a question and you will get a straight answer.',
    cta: links.reports() ? { label: 'Open your reports', url: links.reports() } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because monthly reporting was set up for your account.',
  });
}


// --- accessibility -----------------------------------------------------------

/**
 * The temptation is to lead with the law, which tells people they have been
 * negligent. The decent version leads with the customers it lets back in, and
 * mentions the legal position once, briefly, at the end.
 */
function accessibilityFixesLive({ clientName, standard = 'WCAG 2.2 AA', fixed = null } = {}) {
  return build({
    subject: 'Your accessibility improvements are live',
    eyebrow: 'Accessibility improvements',
    title: 'Your accessibility improvements are live',
    preheader: 'Your site now works for people it was quietly turning away.',
    line: standard ? `Built to ${standard}` : null,
    intro: `${greet(clientName)} The accessibility work on your website is finished and live.`,
    second: 'About one person in five finds an ordinary website hard to use. They rarely complain. They just leave.',
    getsTitle: 'What is different now',
    gets: [
      'Text stays readable when somebody enlarges it',
      'The whole site works with a keyboard, without a mouse',
      'Colour and contrast raised, which helps everyone reading outdoors',
    ],
    facts: [
      fixed ? { label: 'Issues resolved', value: String(fixed) } : null,
      standard ? { label: 'Standard applied', value: standard } : null,
    ],
    closing: `This also puts you on the right side of ${standard}, the benchmark accessibility claims are judged against. Happy to send the evidence if your solicitor wants it.`,
    cta: links.reports() ? { label: 'See the full report', url: links.reports() } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because accessibility improvements were published on your site.',
  });
}

/**
 * The one with numbers in it, so it keeps the only detail panel in the set. The
 * callout survives the trim too: a first score is nearly always poor, and
 * without that sentence the panel reads as a scolding.
 */
function accessibilityAuditLive({
  clientName,
  standard = 'WCAG 2.2 AA',
  score = null,
  pagesTested = null,
  issuesFound = null,
  criticalIssues = null,
  reportUrl = null,
} = {}) {
  const fields = [
    standard ? { label: 'Standard', value: standard } : null,
    pagesTested ? { label: 'Pages tested', value: String(pagesTested) } : null,
    issuesFound !== null && issuesFound !== undefined ? { label: 'Issues found', value: String(issuesFound) } : null,
    score !== null && score !== undefined ? { label: 'Score', value: `${score}%` } : null,
  ].filter(Boolean);

  return build({
    subject: 'Your accessibility review is finished',
    eyebrow: 'Accessibility testing',
    title: 'Your accessibility review is finished',
    preheader: 'Checked by a person as well as a tool, with a plain list of what to fix.',
    intro: `${greet(clientName)} We have finished checking your website against the accessibility standard.`,
    second: 'A tool alone catches about a third of what matters, so a person went through it too.',
    detail: fields.length
      ? {
        tone: 'info',
        title: 'What the review found',
        fields,
        note: criticalIssues
          ? `${criticalIssues} of these are serious enough to stop somebody completing an enquiry. We start there.`
          : 'The full list is ordered worst first, so the work goes where it counts.',
      }
      : null,
    getsTitle: 'What it covered',
    gets: [
      `Every page checked against ${standard}`,
      'Findings in plain English, worst first, each with what to do',
      'Written evidence of what was checked and when',
    ],
    note: {
      tone: 'info',
      title: 'A low score is a starting point, not a verdict',
      body: 'Nearly every site scores poorly first time, including ones built last year. The number exists to measure the improvement against.',
    },
    closing: 'We will come to you with a plan for the fixes. Nothing is needed before then.',
    cta: reportUrl
      ? { label: 'Read the full review', url: reportUrl }
      : (links.reports() ? { label: 'Read the full review', url: links.reports() } : null),
    reason: 'Sent because your accessibility review was completed.',
  });
}


// --- support -----------------------------------------------------------------

/** What to do when something is wrong. Said once, clearly, with no conditions. */
function techSupportLive({ clientName, ownerName = null, responseHours = null, coverage = null } = {}) {
  return build({
    subject: 'Your support line is open',
    eyebrow: 'Technical support',
    title: 'Your support line is open',
    preheader: 'One place to raise anything, and a named person on it.',
    line: ownerName ? `${ownerName} looks after your account` : null,
    intro: `${greet(clientName)} Your support is live: one place to raise anything, and one person who answers for it.`,
    getsTitle: 'How it works',
    gets: [
      'Raise anything in your portal, or just reply to any email from us',
      ownerName ? `${ownerName} owns your account and sees everything you raise` : 'A named person owns your account and sees everything you raise',
      'You can check the status yourself without chasing anyone',
    ],
    facts: [
      ownerName ? { label: 'Your contact', value: ownerName } : null,
      responseHours ? { label: 'Reply within', value: responseHours } : null,
      coverage ? { label: 'Covered hours', value: coverage } : null,
    ],
    closing: 'Keep this email. The button below is the fastest way in.',
    cta: links.tickets() ? { label: 'Open your support area', url: links.tickets() } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because technical support was activated on your account.',
  });
}

/**
 * The quiet recurring one. An assistant confidently quoting last year's prices
 * does real damage, so this exists mostly to prove it is being maintained.
 */
function aiContextUpdateLive({ clientName, updatedAt = null, changes = null, corrected = null } = {}) {
  return build({
    subject: 'Your assistant has been brought up to date',
    eyebrow: 'AI & context updates',
    title: 'Your assistant has been brought up to date',
    preheader: 'New prices, hours and services loaded in. Mistakes corrected.',
    line: updatedAt ? `Updated ${updatedAt}` : null,
    intro: `${greet(clientName)} Your assistant has had its monthly refresh, so what it tells customers matches what is true today.`,
    getsTitle: 'What was refreshed',
    gets: [
      'Current prices, opening hours and the services you offer now',
      'Questions it answered poorly last month, corrected and re-tested',
      'Anything out of date removed rather than left to be found',
    ],
    facts: [
      changes ? { label: 'Items updated', value: String(changes) } : null,
      corrected ? { label: 'Answers corrected', value: String(corrected) } : null,
    ],
    closing: 'If something about your business has changed and we missed it, just reply.',
    cta: links.home() ? { label: 'Open your portal', url: links.home() } : null,
    reason: 'Sent because your assistant received a scheduled content update.',
  });
}

/** Integrations rot silently. This says why somebody is paid to watch them. */
function apiMaintenanceLive({ clientName, integrations = null } = {}) {
  return build({
    subject: 'Your connections are being looked after',
    eyebrow: 'API maintenance',
    title: 'Your connections are being looked after',
    preheader: 'The links between your tools are watched and kept working.',
    intro: `${greet(clientName)} The connections between your website and the systems it feeds are now watched and maintained.`,
    second: 'These links break quietly. Businesses usually find out a fortnight later, when somebody notices the enquiries stopped.',
    getsTitle: 'What we watch',
    gets: [
      'Every connection checked continuously, not when somebody remembers',
      'Faults fixed before they break the chain your enquiries travel along',
      'Kept current as the companies behind them change how they work',
    ],
    facts: [integrations ? { label: 'Connections covered', value: integrations } : null],
    closing: 'If we ever need to change something on your side, you will hear it from us first.',
    cta: links.home() ? { label: 'Open your portal', url: links.home() } : null,
    reason: 'Sent because integration maintenance started on your account.',
  });
}


// --- the four steps of an engagement ----------------------------------------

/**
 * Audit, plan, build, optimise -- the rhythm the website promises, made real in
 * the inbox. Clients judge an agency largely on whether the sequence they were
 * sold is the sequence they experience.
 */
function auditReady({ clientName, scope = null, findings = null, quickWins = null, reportUrl = null } = {}) {
  return build({
    subject: 'Your audit is ready',
    eyebrow: 'Step 1 of 4 - Audit',
    title: 'Your audit is ready',
    preheader: 'What we found, including the awkward parts. Nothing is being sold.',
    line: scope ? `Covering ${scope}` : null,
    intro: `${greet(clientName)} We have finished going through your website, your advertising and your tracking.`,
    second: 'It says what is working, what is not, and where money is leaking. There is nothing to buy in it.',
    getsTitle: 'What it covers',
    gets: [
      'Your website: what it does well, and where visitors give up',
      'Your advertising: what each pound is currently buying',
      'Your tracking: which of your numbers can actually be trusted',
    ],
    facts: [
      findings ? { label: 'Findings', value: String(findings) } : null,
      quickWins ? { label: 'Quick wins', value: String(quickWins) } : null,
    ],
    closing: 'Read the quick wins first: some can be fixed in an afternoon and pay for themselves this month.',
    cta: reportUrl
      ? { label: 'Read your audit', url: reportUrl }
      : (links.reports() ? { label: 'Read your audit', url: links.reports() } : null),
    reason: 'Sent because your audit was completed.',
  });
}

/** Step two. What clients most want to see here is a date and a number. */
function planReady({ clientName, horizon = null, items = null, startDate = null, planUrl = null } = {}) {
  return build({
    subject: 'Your plan is ready',
    eyebrow: 'Step 2 of 4 - Plan',
    title: 'Your plan is ready',
    preheader: 'What we will do, in what order, and what each piece should return.',
    line: horizon ? `Covering ${horizon}` : null,
    intro: `${greet(clientName)} Your plan is ready. It turns the audit into work with an order, a date and an expected result.`,
    second: 'It is ordered by what will move the needle fastest, not by what is easiest for us to build.',
    getsTitle: 'What is in it',
    gets: [
      'Every piece of work, in order, with the reason for that order',
      'What each one should return, so it can be judged afterwards',
      'What it costs, how long it takes, and what we need from you',
    ],
    facts: [
      items ? { label: 'Items in the plan', value: String(items) } : null,
      horizon ? { label: 'Covering', value: horizon } : null,
      startDate ? { label: 'Proposed start', value: startDate } : null,
    ],
    closing: 'Nothing starts until you say yes. Change the order or cut a line: easier now than later.',
    cta: planUrl
      ? { label: 'Review your plan', url: planUrl }
      : (links.projects() ? { label: 'Review your plan', url: links.projects() } : null),
    reason: 'Sent because your roadmap was prepared for review.',
  });
}

/** Step three. The anxious phase, so it answers "when will I see something?". */
function buildStarted({ clientName, projectName = null, startedOn = null, firstMilestone = null, ownerName = null } = {}) {
  return build({
    subject: projectName ? `We have started building ${projectName}` : 'We have started building',
    eyebrow: 'Step 3 of 4 - Build',
    title: 'We have started building',
    preheader: 'Work is underway. Here is who is on it and when you will see something.',
    line: ownerName ? `${ownerName} is leading this` : null,
    intro: `${greet(clientName)} Work has started on ${projectName || 'your project'}, and you can watch it happen rather than wait.`,
    second: 'Our builds run in weeks, not quarters, and you see each piece as it is finished.',
    getsTitle: 'What happens from here',
    gets: [
      'Progress visible in your portal at any hour, without asking',
      'Each piece comes to you as it is done, not all at the end',
      'Anything that could change the date or cost, you hear the same day',
    ],
    facts: [
      startedOn ? { label: 'Started', value: startedOn } : null,
      firstMilestone ? { label: 'First thing you will see', value: firstMilestone } : null,
      ownerName ? { label: 'Leading it', value: ownerName } : null,
    ],
    closing: 'If we need a decision from you, we will ask in good time rather than at the last minute.',
    cta: links.progress() ? { label: 'Follow the build', url: links.progress() } : (links.projects() ? { label: 'Open your project', url: links.projects() } : null),
    reason: 'Sent because work started on your project.',
  });
}

/**
 * Step four, and the only one that recurs. It carries the progress bar, because
 * after launch the question stops being "is it done" and becomes "is it still
 * getting better".
 */
function optimizeDigest({
  clientName,
  period = 'this week',
  progress = null,
  done = [],
  next = [],
  highlight = null,
} = {}) {
  const intro = `${greet(clientName)} A short note on where things stand ${period}.`;
  const closing = 'Reply with a question any time and you will get a straight answer.';
  const cta = links.progress()
    ? { label: 'See the full picture', url: links.progress() }
    : (links.home() ? { label: 'Open your portal', url: links.home() } : null);

  // Built by hand rather than through build(): this is the only message in the
  // file with a progress bar and two lists, and bending the shared shape far
  // enough to hold them would make it worse for the other thirty.
  const blocks = [
    t.paragraph(intro),
    progress !== null && progress !== undefined
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 22px;"><tr><td align="center">${t.progressBar(progress)}</td></tr></table>`
      : '',
    highlight ? t.paragraph(highlight) : '',
    done.length ? t.panel({ tone: 'success', title: 'Done this period', html: t.bulletList(done) }) : '',
    next.length ? t.panel({ tone: 'info', title: 'On next', html: t.bulletList(next) }) : '',
    t.paragraph(closing, { muted: true, size: 13 }),
  ].filter(Boolean);

  return {
    subject: `Your progress ${period}`,
    html: t.renderEmail({
      preheader: `What moved ${period}, and what we are on next.`,
      eyebrow: 'Step 4 of 4 - Optimise',
      title: `Your progress ${period}`,
      blocks,
      cta,
      reason: 'Sent because you receive a regular progress summary.',
    }),
    text: t.renderText([
      `Your progress ${period}`,
      '',
      intro,
      progress !== null && progress !== undefined ? `Overall progress: ${progress}%` : null,
      highlight ? `\n${highlight}` : null,
      done.length ? '\nDone this period:' : null,
      ...done.map((d) => `- ${d}`),
      next.length ? '\nOn next:' : null,
      ...next.map((n) => `- ${n}`),
      '',
      closing,
      cta ? `\n${cta.label}: ${cta.url}` : null,
    ]),
  };
}


// --- recurring performance updates ------------------------------------------
//
// The launch emails above are sent once. These arrive every month for years, so
// they are the shortest in the file. One rule for all four: lead with the number
// that answers "was it worth it", and never hide a bad month. A client who finds
// out from their own bank statement has already left.

/** Figures with a label, dropped if the caller has no value for them. */
function metricFields(pairs) {
  return pairs
    .filter((p) => p && p.value !== null && p.value !== undefined && p.value !== '')
    .map((p) => ({ label: p.label, value: String(p.value) }));
}

function adsPerformanceUpdate({
  clientName,
  period = 'last month',
  spend = null,
  leads = null,
  costPerLead = null,
  change = null,
  bestChannel = null,
  note = null,
} = {}) {
  const fields = metricFields([
    { label: 'Spent', value: spend },
    { label: 'Enquiries', value: leads },
    { label: 'Cost each', value: costPerLead },
    { label: 'vs. previous', value: change },
  ]);

  return build({
    subject: `Your ads ${period}`,
    eyebrow: 'Ads update',
    title: `How your ads did ${period}`,
    preheader: `What you spent ${period}, and what it brought in.`,
    hero: null,
    line: bestChannel ? `Best performer: ${bestChannel}` : null,
    intro: `${greet(clientName)} Here is how your advertising did ${period}.`,
    second: note || 'The only figure worth arguing about is the cost per enquiry.',
    detail: fields.length
      ? {
        tone: 'info',
        title: `Your numbers, ${period}`,
        fields,
        note: bestChannel ? `${bestChannel} produced the most for the money.` : null,
      }
      : null,
    getsTitle: 'What we are changing',
    gets: [
      'Moving budget towards whatever is producing enquiries most cheaply',
      'Turning off searches that spend without returning',
      'Testing fresh wording against the current best performer',
    ],
    closing: 'Nothing is needed from you. To change the budget, just reply with the figure.',
    cta: links.reports() ? { label: 'See the full report', url: links.reports() } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because you receive a regular advertising summary.',
  });
}

function seoRankingUpdate({
  clientName,
  period = 'last month',
  topTen = null,
  movedUp = null,
  traffic = null,
  change = null,
  topKeyword = null,
} = {}) {
  const fields = metricFields([
    { label: 'In the top 10', value: topTen },
    { label: 'Moved up', value: movedUp },
    { label: 'Visits from search', value: traffic },
    { label: 'vs. previous', value: change },
  ]);

  return build({
    subject: `Your search results ${period}`,
    eyebrow: 'SEO update',
    title: `How you ranked ${period}`,
    preheader: `Where you sit in search ${period}, and what moved.`,
    hero: null,
    line: topKeyword ? `Best performing search: ${topKeyword}` : null,
    intro: `${greet(clientName)} Here is where you stand in search ${period}.`,
    second: 'Search moves in months, so a flat month inside a rising quarter is normal.',
    detail: fields.length
      ? {
        tone: 'info',
        title: `Your positions, ${period}`,
        fields,
        note: topKeyword ? `"${topKeyword}" is bringing you the most traffic.` : null,
      }
      : null,
    getsTitle: 'What we are working on next',
    gets: [
      'Pushing the searches sitting just outside the top ten',
      'Writing for the questions no page of yours answers yet',
      'Clearing the technical faults holding good pages back',
    ],
    closing: 'Tell us any search term you want chased and we will add it.',
    cta: links.reports() ? { label: 'See the full report', url: links.reports() } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because you receive a regular search summary.',
  });
}

function chatbotPerformanceUpdate({
  clientName,
  period = 'last month',
  conversations = null,
  answered = null,
  handoffs = null,
  leads = null,
  topQuestion = null,
} = {}) {
  const fields = metricFields([
    { label: 'Conversations', value: conversations },
    { label: 'Answered outright', value: answered },
    { label: 'Passed to a person', value: handoffs },
    { label: 'Became enquiries', value: leads },
  ]);

  return build({
    subject: `Your assistant ${period}`,
    eyebrow: 'Assistant update',
    title: `What your assistant handled ${period}`,
    preheader: 'How many it answered, how many it passed on, what people kept asking.',
    hero: null,
    line: topQuestion ? `Most asked: ${topQuestion}` : null,
    intro: `${greet(clientName)} Here is what your website assistant dealt with ${period}.`,
    second: 'The questions it could not answer are the useful half: a free list of what your website does not tell people.',
    detail: fields.length
      ? {
        tone: 'info',
        title: `Your numbers, ${period}`,
        fields,
        note: topQuestion ? `It was asked most often about ${topQuestion}.` : null,
      }
      : null,
    getsTitle: 'What we are doing with it',
    gets: [
      'Teaching it the answers it fumbled, and testing the fix holds',
      'Telling you which questions deserve a page of their own',
      'Checking handovers reached the right person at the right moment',
    ],
    closing: 'If an answer it gave reads wrong to you, send it over and we will correct it.',
    cta: links.reports() ? { label: 'See the full report', url: links.reports() } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because you receive a regular assistant summary.',
  });
}

function accessibilityScoreUpdate({
  clientName,
  period = 'this month',
  standard = 'WCAG 2.2 AA',
  score = null,
  previousScore = null,
  fixed = null,
  remaining = null,
} = {}) {
  const fields = metricFields([
    { label: 'Score now', value: score !== null && score !== undefined ? `${score}%` : null },
    { label: 'Was', value: previousScore !== null && previousScore !== undefined ? `${previousScore}%` : null },
    { label: 'Fixed', value: fixed },
    { label: 'Still open', value: remaining },
  ]);

  return build({
    subject: `Your accessibility score ${period}`,
    eyebrow: 'Accessibility update',
    title: `Your accessibility score ${period}`,
    preheader: 'Where your site stands against the standard, and what we fixed.',
    hero: null,
    line: standard ? `Measured against ${standard}` : null,
    intro: `${greet(clientName)} Here is where your site stands on accessibility ${period}.`,
    second: 'We re-check after every significant change, because a page added in a hurry is how a good score slips.',
    detail: fields.length
      ? {
        tone: 'info',
        title: `Measured against ${standard}`,
        fields,
        note: remaining
          ? `The ${remaining} still open are ordered worst first, and we work down that list.`
          : 'Nothing significant is outstanding.',
      }
      : null,
    getsTitle: 'What this protects',
    gets: [
      'Customers with poor sight, a tremor, or a phone in bright sun',
      'Your position if anyone ever raises an accessibility complaint',
      'Your search ranking, which rewards much of the same work',
    ],
    closing: 'Send us the evidence request if your insurer or solicitor ever asks for it.',
    cta: links.reports() ? { label: 'See the full report', url: links.reports() } : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    reason: 'Sent because you receive a regular accessibility summary.',
  });
}


// --- the first email of all --------------------------------------------------

/**
 * The welcome, sent once, listing everything the client actually bought.
 *
 * The commonest complaint about an agency is not bad work, it is not knowing
 * what you are paying for. A client who can see the list, with a name and a
 * date against it, asks very different questions six weeks later.
 */
function servicesWelcome({
  clientName,
  services = [],
  ownerName = null,
  startDate = null,
  signInUrl = null,
} = {}) {
  const names = services.map((s) => (typeof s === 'string' ? s : s && s.name)).filter(Boolean);
  const lines = services
    .map((s) => {
      if (typeof s === 'string') return s;
      if (!s || !s.name) return null;
      return s.summary ? `${s.name} - ${s.summary}` : s.name;
    })
    .filter(Boolean);

  return build({
    subject: 'Welcome - here is everything you are getting',
    eyebrow: 'Welcome',
    title: 'Everything you are getting',
    preheader: 'Your services, your contact, and where to see all of it.',
    line: ownerName ? `${ownerName} looks after your account` : null,
    intro: `${greet(clientName)} Welcome aboard. Here is the plain list of what you have signed up for.`,
    second: 'It all runs from one portal, where you can see what is happening and who is doing it.',
    getsTitle: names.length ? `Your services (${names.length})` : 'Your services',
    gets: lines,
    facts: [
      ownerName ? { label: 'Your contact', value: ownerName } : null,
      startDate ? { label: 'Starting', value: startDate } : null,
    ],
    note: {
      tone: 'success',
      title: 'What happens next',
      body: 'We start with the audit: a straight look at your website, advertising and tracking. You get the findings in writing, we agree a plan, and only then does anything get built.',
    },
    closing: 'As each service goes live you will get a short email saying so.',
    cta: signInUrl
      ? { label: 'Sign in to your portal', url: signInUrl }
      : (links.home() ? { label: 'Open your portal', url: links.home() } : null),
    secondaryCta: links.tickets() ? { label: 'Ask us anything', url: links.tickets() } : null,
    reason: 'Sent because your account was set up.',
  });
}


// --- what a trigger asks for -------------------------------------------------

/**
 * The service keys a project can carry, mapped to the launch email each one
 * sends.
 *
 * This is the whole contract between the project record and this file:
 * `projects.service` holds one of these keys, and when that project goes live
 * utils/serviceLaunch.js looks the client up and sends the matching message.
 * A key with no entry here simply sends nothing, which is the right failure --
 * a typo in an admin form should not put a wrong email in a client's inbox.
 *
 * The keys are the same strings as the preview registry below, so an admin
 * choosing "which email does this project send?" is choosing from the list they
 * can already read on the Mail page.
 */
const LAUNCH_BY_SERVICE = {
  website_redesign: { key: 'service_website_redesign_live', build: websiteRedesignLive },
  headless: { key: 'service_headless_live', build: headlessLive },
  landing_page: { key: 'service_landing_page_live', build: landingPageLive },
  maintenance: { key: 'service_maintenance_live', build: maintenanceLive },
  knowledge_chatbot: { key: 'service_knowledge_chatbot_live', build: knowledgeChatbotLive },
  llm_chatbot: { key: 'service_llm_chatbot_live', build: llmChatbotLive },
  csr_automation: { key: 'service_csr_automation_live', build: csrAutomationLive },
  human_handoff: { key: 'service_human_handoff_live', build: humanHandoffLive },
  seo: { key: 'service_seo_live', build: seoLive },
  google_ads: { key: 'service_google_ads_live', build: googleAdsLive },
  meta_ads: { key: 'service_meta_ads_live', build: metaAdsLive },
  social_reels: { key: 'service_social_reels_live', build: socialReelsLive },
  email_marketing: { key: 'service_email_marketing_live', build: emailMarketingLive },
  crm_integration: { key: 'service_crm_integration_live', build: crmIntegrationLive },
  dashboard: { key: 'service_dashboard_live', build: dashboardLive },
  analytics: { key: 'service_analytics_live', build: analyticsLive },
  monthly_reporting: { key: 'service_monthly_reporting_live', build: monthlyReportingLive },
  accessibility_fixes: { key: 'service_accessibility_fixes_live', build: accessibilityFixesLive },
  accessibility_audit: { key: 'service_accessibility_audit_live', build: accessibilityAuditLive },
  tech_support: { key: 'service_tech_support_live', build: techSupportLive },
  ai_context_update: { key: 'service_ai_context_update_live', build: aiContextUpdateLive },
  api_maintenance: { key: 'service_api_maintenance_live', build: apiMaintenanceLive },
};

/**
 * Which services get a recurring summary, and which builder writes it.
 *
 * Only four of the twenty-two have a monthly story worth telling unprompted.
 * The rest would be sending "nothing changed" twelve times a year, which is how
 * a client learns to ignore everything we send.
 */
const UPDATE_BY_SERVICE = {
  google_ads: { key: 'update_ads_performance', build: adsPerformanceUpdate },
  meta_ads: { key: 'update_ads_performance', build: adsPerformanceUpdate },
  seo: { key: 'update_seo_ranking', build: seoRankingUpdate },
  knowledge_chatbot: { key: 'update_chatbot_performance', build: chatbotPerformanceUpdate },
  llm_chatbot: { key: 'update_chatbot_performance', build: chatbotPerformanceUpdate },
  accessibility_fixes: { key: 'update_accessibility_score', build: accessibilityScoreUpdate },
  accessibility_audit: { key: 'update_accessibility_score', build: accessibilityScoreUpdate },
};

/** Every service key an admin may put on a project, for validation and forms. */
const SERVICE_KEYS = Object.keys(LAUNCH_BY_SERVICE);

/** The launch message for one service, or null if the key is not one of ours. */
function launchFor(serviceKey, context = {}) {
  const entry = LAUNCH_BY_SERVICE[serviceKey];
  return entry ? { template: entry.key, message: entry.build(context) } : null;
}

/** The recurring message for one service, or null if that service has none. */
function updateFor(serviceKey, context = {}) {
  const entry = UPDATE_BY_SERVICE[serviceKey];
  return entry ? { template: entry.key, message: entry.build(context) } : null;
}


// --- preview registry --------------------------------------------------------
//
// Every entry shows up on the Mail page with a rendered preview, which is how
// these get proof-read: by someone reading them as an inbox shows them, not as
// source. The sample is an ordinary small business rather than "Acme Corp",
// because copy that reads fine beside placeholder nonsense often reads badly
// beside a real name.

const SAMPLE = {
  clientName: 'David Shaw',
  domain: 'brightpath-retail.com',
  siteUrl: 'https://brightpath-retail.com',
  owner: 'Ryan Coleman',
};

const SERVICE_TEMPLATES = {
  onboarding_services_welcome: {
    audience: 'client',
    group: 'Welcome & onboarding',
    label: 'Welcome - everything you are getting',
    description: 'The first email a new client gets: every service they bought, their contact, and what happens next.',
    render: () => servicesWelcome({
      clientName: SAMPLE.clientName,
      ownerName: SAMPLE.owner,
      startDate: 'Monday 13 October',
      services: [
        { name: 'Website redesign', summary: 'a new site built around enquiries' },
        { name: 'Maintenance & security', summary: 'updates, backups and monitoring' },
        { name: 'SEO', summary: 'being found in ordinary Google results' },
        { name: 'Google Ads + LSA', summary: 'paid search across your area' },
        { name: 'Analytics', summary: 'every call and form counted properly' },
        { name: 'Monthly reporting', summary: 'a plain summary each month' },
      ],
    }),
  },

  service_website_redesign_live: {
    audience: 'client',
    group: 'Service launches - Website',
    label: 'Website redesign is live',
    description: 'Launch day. Says the new site is up and that old links still work.',
    render: () => websiteRedesignLive({ clientName: SAMPLE.clientName, domain: SAMPLE.domain }),
  },
  service_headless_live: {
    audience: 'client',
    group: 'Service launches - Website',
    label: 'Headless architecture is live',
    description: 'The invisible rebuild, explained as the three things the client will notice.',
    render: () => headlessLive({ clientName: SAMPLE.clientName, siteUrl: SAMPLE.siteUrl }),
  },
  service_landing_page_live: {
    audience: 'client',
    group: 'Service launches - Website',
    label: 'Landing page is live',
    description: 'A single-offer page published, and what it is counting.',
    render: () => landingPageLive({
      clientName: SAMPLE.clientName,
      pageName: 'Autumn service offer',
      pageUrl: `${SAMPLE.siteUrl}/autumn-service`,
      campaign: 'the October Google Ads campaign',
    }),
  },
  service_maintenance_live: {
    audience: 'client',
    group: 'Service launches - Website',
    label: 'Maintenance & security started',
    description: 'The care plan: updates, backups, monitoring, and how to reach us.',
    render: () => maintenanceLive({ clientName: SAMPLE.clientName, plan: 'Care' }),
  },

  service_knowledge_chatbot_live: {
    audience: 'client',
    group: 'Service launches - AI',
    label: 'Knowledge chatbot is live',
    description: 'The website assistant, with its limits stated as a feature rather than a disclaimer.',
    render: () => knowledgeChatbotLive({
      clientName: SAMPLE.clientName,
      siteUrl: SAMPLE.siteUrl,
      sources: 'your service pages, price list and FAQs',
    }),
  },
  service_llm_chatbot_live: {
    audience: 'client',
    group: 'Service launches - AI',
    label: 'LLM chatbot is live',
    description: 'The upgrade email: it now understands ordinary phrasing and remembers the thread.',
    render: () => llmChatbotLive({ clientName: SAMPLE.clientName, siteUrl: SAMPLE.siteUrl }),
  },
  service_csr_automation_live: {
    audience: 'client',
    group: 'Service launches - AI',
    label: 'Automation & CSR is live',
    description: 'After-hours cover, written as cover rather than replacement, with what it will not do.',
    render: () => csrAutomationLive({ clientName: SAMPLE.clientName }),
  },
  service_human_handoff_live: {
    audience: 'client',
    group: 'Service launches - AI',
    label: 'Human handoff is live',
    description: 'When the assistant steps aside for a person, and who sets those rules.',
    render: () => humanHandoffLive({ clientName: SAMPLE.clientName }),
  },

  service_seo_live: {
    audience: 'client',
    group: 'Service launches - Growth',
    label: 'SEO work started',
    description: 'Search work underway, with the honest eight-to-twelve-week timeline in its own box.',
    render: () => seoLive({ clientName: SAMPLE.clientName, area: 'Greater Manchester' }),
  },
  service_google_ads_live: {
    audience: 'client',
    group: 'Service launches - Growth',
    label: 'Google Ads + LSA are live',
    description: 'Paid search live, budget capped, and a warning that the first fortnight looks expensive.',
    render: () => googleAdsLive({
      clientName: SAMPLE.clientName, budget: '£1,200 a month', area: 'Greater Manchester', lsa: true,
    }),
  },
  service_meta_ads_live: {
    audience: 'client',
    group: 'Service launches - Growth',
    label: 'Meta ads are live',
    description: 'Facebook and Instagram live, and why likes are not the measure.',
    render: () => metaAdsLive({
      clientName: SAMPLE.clientName, budget: '£800 a month', area: 'Greater Manchester',
    }),
  },
  service_social_reels_live: {
    audience: 'client',
    group: 'Service launches - Growth',
    label: 'Social & reels started',
    description: 'The content calendar is running, and nothing publishes without approval.',
    render: () => socialReelsLive({
      clientName: SAMPLE.clientName, cadence: 'three times a week', channels: 'Instagram, Facebook, TikTok',
    }),
  },
  service_email_marketing_live: {
    audience: 'client',
    group: 'Service launches - Growth',
    label: 'Email marketing is live',
    description: 'Welcome sequence running, with deliverability explained in plain words.',
    render: () => emailMarketingLive({ clientName: SAMPLE.clientName, listSize: '2,480' }),
  },
  service_crm_integration_live: {
    audience: 'client',
    group: 'Service launches - Growth',
    label: 'CRM integration is live',
    description: 'Enquiries land in one system automatically. The end of re-typing.',
    render: () => crmIntegrationLive({
      clientName: SAMPLE.clientName, crmName: 'HubSpot', sources: 'phone calls, website forms and live chat',
    }),
  },

  service_dashboard_live: {
    audience: 'client',
    group: 'Service launches - Data',
    label: 'Dashboard is ready',
    description: 'One screen with the numbers that matter, updating on its own.',
    render: () => dashboardLive({ clientName: SAMPLE.clientName }),
  },
  service_analytics_live: {
    audience: 'client',
    group: 'Service launches - Data',
    label: 'Analytics is live',
    description: 'Tracking in place, and why every later report depends on it.',
    render: () => analyticsLive({
      clientName: SAMPLE.clientName, tracked: 'phone calls, contact forms and online bookings',
    }),
  },
  service_monthly_reporting_live: {
    audience: 'client',
    group: 'Service launches - Data',
    label: 'Monthly reporting started',
    description: 'Sets the shape of every monthly summary the client will get from now on.',
    render: () => monthlyReportingLive({ clientName: SAMPLE.clientName }),
  },

  service_accessibility_fixes_live: {
    audience: 'client',
    group: 'Service launches - Accessibility',
    label: 'Accessibility improvements are live',
    description: 'The fixes shipped, led by the customers they let back in rather than by the law.',
    render: () => accessibilityFixesLive({ clientName: SAMPLE.clientName, fixed: 38 }),
  },
  service_accessibility_audit_live: {
    audience: 'client',
    group: 'Service launches - Accessibility',
    label: 'Accessibility review finished',
    description: 'The WCAG review, with the score panel and why a low first score is not a scolding.',
    render: () => accessibilityAuditLive({
      clientName: SAMPLE.clientName, score: 72, pagesTested: 24, issuesFound: 46, criticalIssues: 7,
    }),
  },

  service_tech_support_live: {
    audience: 'client',
    group: 'Service launches - Support',
    label: 'Technical support is open',
    description: 'One way in, one named person, one reply time. Said once and clearly.',
    render: () => techSupportLive({
      clientName: SAMPLE.clientName,
      ownerName: SAMPLE.owner,
      responseHours: '4 working hours',
      coverage: 'Monday to Friday, 9am to 6pm',
    }),
  },
  service_ai_context_update_live: {
    audience: 'client',
    group: 'Service launches - Support',
    label: 'AI context updated',
    description: 'The monthly refresh that stops the assistant quoting last year.',
    render: () => aiContextUpdateLive({
      clientName: SAMPLE.clientName, updatedAt: 'this week', changes: 14, corrected: 6,
    }),
  },
  service_api_maintenance_live: {
    audience: 'client',
    group: 'Service launches - Support',
    label: 'API maintenance started',
    description: 'The connections between tools are watched, so enquiries never stop arriving unnoticed.',
    render: () => apiMaintenanceLive({
      clientName: SAMPLE.clientName, integrations: 'HubSpot, Stripe, Google Ads and your booking system',
    }),
  },

  engagement_audit_ready: {
    audience: 'client',
    group: 'Engagement steps',
    label: 'Step 1 - Audit ready',
    description: 'The findings, unsoftened, with the quick wins pulled to the front.',
    render: () => auditReady({
      clientName: SAMPLE.clientName,
      scope: 'your website, advertising and tracking',
      findings: 31,
      quickWins: 6,
    }),
  },
  engagement_plan_ready: {
    audience: 'client',
    group: 'Engagement steps',
    label: 'Step 2 - Plan ready',
    description: 'The roadmap, with an expected return and a date against every line.',
    render: () => planReady({
      clientName: SAMPLE.clientName, horizon: 'the next two quarters', items: 12, startDate: 'Monday 13 October',
    }),
  },
  engagement_build_started: {
    audience: 'client',
    group: 'Engagement steps',
    label: 'Step 3 - Build started',
    description: 'Work underway, who is leading it, and when the client sees the first piece.',
    render: () => buildStarted({
      clientName: SAMPLE.clientName,
      projectName: 'the new website',
      startedOn: 'Monday 13 October',
      firstMilestone: 'Homepage design, within two weeks',
      ownerName: SAMPLE.owner,
    }),
  },
  engagement_optimize_digest: {
    audience: 'client',
    group: 'Engagement steps',
    label: 'Step 4 - Progress digest',
    description: 'The recurring one: progress bar, what was done, what is next.',
    render: () => optimizeDigest({
      clientName: SAMPLE.clientName,
      period: 'this week',
      progress: 60,
      highlight: 'Enquiries from search were up about a fifth on last week, mostly from the two service pages we rewrote.',
      done: [
        'Rewrote the two service pages losing the most visitors',
        'Cut four search terms that were spending without returning',
        'Fixed the contact form failing silently on older iPhones',
      ],
      next: [
        'Rebuild the booking page around a single action',
        'Test a second version of the best-performing advert',
      ],
    }),
  },

  update_ads_performance: {
    audience: 'client',
    group: 'Monthly updates',
    label: 'Ads update (recurring)',
    description: 'Monthly advertising summary: spend, enquiries, cost each, and what we are changing.',
    render: () => adsPerformanceUpdate({
      clientName: SAMPLE.clientName,
      period: 'last month',
      spend: '£1,180',
      leads: '47',
      costPerLead: '£25',
      change: 'down 18%',
      bestChannel: 'Local Services Ads',
    }),
  },
  update_seo_ranking: {
    audience: 'client',
    group: 'Monthly updates',
    label: 'SEO update (recurring)',
    description: 'Monthly search summary: positions, movement, traffic, and what is next.',
    render: () => seoRankingUpdate({
      clientName: SAMPLE.clientName,
      period: 'last month',
      topTen: '14',
      movedUp: '23',
      traffic: '3,140',
      change: 'up 12%',
      topKeyword: 'garden rooms manchester',
    }),
  },
  update_chatbot_performance: {
    audience: 'client',
    group: 'Monthly updates',
    label: 'Assistant update (recurring)',
    description: 'Monthly assistant summary, including the questions it could not answer.',
    render: () => chatbotPerformanceUpdate({
      clientName: SAMPLE.clientName,
      period: 'last month',
      conversations: '612',
      answered: '528',
      handoffs: '84',
      leads: '39',
      topQuestion: 'installation lead times',
    }),
  },
  update_accessibility_score: {
    audience: 'client',
    group: 'Monthly updates',
    label: 'Accessibility update (recurring)',
    description: 'Monthly accessibility score against the standard, and what it protects.',
    render: () => accessibilityScoreUpdate({
      clientName: SAMPLE.clientName,
      period: 'this month',
      score: 94,
      previousScore: 72,
      fixed: '38',
      remaining: '8',
    }),
  },
};

module.exports = {
  // website
  websiteRedesignLive,
  headlessLive,
  landingPageLive,
  maintenanceLive,
  // AI
  knowledgeChatbotLive,
  llmChatbotLive,
  csrAutomationLive,
  humanHandoffLive,
  // growth
  seoLive,
  googleAdsLive,
  metaAdsLive,
  socialReelsLive,
  emailMarketingLive,
  crmIntegrationLive,
  // data
  dashboardLive,
  analyticsLive,
  monthlyReportingLive,
  // accessibility
  accessibilityFixesLive,
  accessibilityAuditLive,
  // support
  techSupportLive,
  aiContextUpdateLive,
  apiMaintenanceLive,
  // engagement
  auditReady,
  planReady,
  buildStarted,
  optimizeDigest,
  // recurring
  adsPerformanceUpdate,
  seoRankingUpdate,
  chatbotPerformanceUpdate,
  accessibilityScoreUpdate,
  // onboarding
  servicesWelcome,
  // what the triggers use
  SERVICE_KEYS,
  LAUNCH_BY_SERVICE,
  UPDATE_BY_SERVICE,
  launchFor,
  updateFor,
  // previews
  SERVICE_TEMPLATES,
};
