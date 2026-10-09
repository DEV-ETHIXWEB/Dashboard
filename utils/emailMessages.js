'use strict';

/**
 * Every email this app can send, in one place.
 *
 * A template is a pure function: context in, `{ subject, html, text }` out. No
 * database reads, no network. That keeps them trivially previewable -- the
 * admin Mail page renders each one from the sample context declared next to it,
 * so a template can never quietly rot without someone noticing.
 */

const t = require('./emailTemplates');
const appUrl = require('./appUrl');
// Every price, period and discount that appears in an email comes from here.
// A figure typed into a template is a second price list, and the one nobody
// remembers to change.
const plansConfig = require('../lib/plans');

// The service announcements -- "this is live, here is what it does for you" --
// live in their own file. There are thirty-one of them and they share a shape
// of their own, which would have buried the twenty-four operational templates
// here under copy. They register into the same list, so the Mail page and
// `renderMessage()` cannot tell the two files apart.
const service = require('./serviceEmails');

function baseUrl() {
  return appUrl.baseUrl();
}

function ticketLink(ticketId) {
  const base = baseUrl();
  return base ? `${base}/portal/tickets?ticket=${encodeURIComponent(ticketId)}` : null;
}

function progressLink() {
  const base = baseUrl();
  return base ? `${base}/portal/progress` : null;
}

function loginLink() {
  const base = baseUrl();
  return base ? `${base}/login` : null;
}

/** Stage keys are stored; humans want the label. */
const STAGE_LABELS = {
  triage: 'Triage',
  in_progress: 'In progress',
  waiting_on_client: 'Waiting on client',
  review: 'Review',
  done: 'Done',
};

function stageLabel(stage) {
  if (!stage) return null;
  return STAGE_LABELS[stage] || String(stage);
}

const ROLE_LABELS = {
  admin: 'Administrator',
  project_manager: 'Project Manager',
  sales: 'Sales',
  employee: 'Team Member',
  client: 'Client',
};

/** How a person is introduced in the sign-off, from their role. */
function roleLabel(role) {
  return ROLE_LABELS[role] || 'Team Member';
}

/**
 * The sign-off card: who caused this message. Callers may pass a full user
 * row as `actor`, or just `actorName` -- the older shape still works, it
 * simply produces a card without the role and address.
 */
function actorCard(actor, actorName, line) {
  const name = (actor && actor.name) || actorName || 'Dashboard';
  return {
    name,
    line,
    role: actor && actor.role ? roleLabel(actor.role) : null,
    company: (actor && actor.company) || null,
    email: (actor && actor.email) || null,
  };
}

function ticketMeta(ticket, { clientName, assigneeName } = {}) {
  return [
    { label: 'Ticket', value: ticket.id },
    { label: 'Category', value: ticket.category || 'General' },
    { label: 'Priority', value: ticket.priority || 'Normal' },
    { label: 'Client', value: clientName || null },
    { label: 'Owner', value: assigneeName || 'Unassigned' },
    { label: 'First response due', value: t.formatWhen(ticket.responseDueAt) },
  ];
}

function metaTextLines(meta) {
  return meta
    .filter((m) => m.value !== null && m.value !== undefined && m.value !== '')
    .map((m) => `${m.label}: ${m.value}`);
}

// --- templates -------------------------------------------------------------

/** Sent to every admin and the assigned owner the moment a ticket is raised. */
function newTicketForStaff({ ticket, clientName, assigneeName, clickupUrl }) {
  const meta = ticketMeta(ticket, { clientName, assigneeName });
  const link = ticketLink(ticket.id);

  const blocks = [
    t.paragraph(
      `New ${String(ticket.priority || 'Normal').toLowerCase()} priority ticket from ${clientName || 'a client'}. The response clock is running.`,
    ),
    t.taskCard({
      status: ticket.status || 'Open',
      title: ticket.subject,
      breadcrumb: `Support tickets / ${ticket.category || 'General'}`,
      meta,
      url: link,
    }),
    ticket.description ? t.comment({ author: clientName || 'Client', at: ticket.createdAt, body: ticket.description }) : '',
    clickupUrl ? t.callout({ tone: 'info', title: 'Also in ClickUp', body: clickupUrl }) : '',
  ].filter(Boolean);

  return {
    subject: `[${ticket.priority || 'Normal'}] New ticket ${ticket.id}: ${ticket.subject}`,
    html: t.renderEmail({
      preheader: `${clientName || 'A client'} raised "${ticket.subject}"`,
      eyebrow: 'New ticket',
      hero: 'badge-ticket-new',
      title: `${clientName || 'A client'} raised a ticket`,
      actor: {
        name: clientName || 'Client',
        line: `${clientName || 'A client'} opened ${ticket.id}`,
        role: 'Client',
        company: ticket.clientCompany || null,
      },
      blocks,
      cta: link ? { label: 'Open ticket', url: link } : null,
      secondaryCta: clickupUrl ? { label: 'View in ClickUp', url: clickupUrl } : null,
      reason: 'Sent to everyone on the support rota.',
    }),
    text: t.renderText([
      `New ${ticket.priority || 'Normal'} ticket: ${ticket.subject}`,
      '',
      ...metaTextLines(meta),
      '',
      ticket.description ? `Details:\n${ticket.description}` : null,
      '',
      link ? `Open ticket: ${link}` : null,
      clickupUrl ? `ClickUp task: ${clickupUrl}` : null,
    ]),
  };
}

/** The client's own receipt: proof it landed, and what happens next. */
function ticketReceiptForClient({ ticket, clientName, assigneeName }) {
  const meta = ticketMeta(ticket, { assigneeName });
  const link = ticketLink(ticket.id);

  return {
    subject: `We got your request: ${ticket.subject} (${ticket.id})`,
    html: t.renderEmail({
      preheader: `Ticket ${ticket.id} is open and assigned.`,
      eyebrow: 'Request received',
      hero: 'badge-ticket',
      title: 'We got your request',
      blocks: [
        t.paragraph(
          `Thanks ${clientName || 'there'}. Your request is logged as ${ticket.id}. You can follow it from your portal, including the task board and the team's notes.`,
        ),
        t.taskCard({
          status: ticket.status || 'Open',
          title: ticket.subject,
          breadcrumb: `Your tickets / ${ticket.category || 'General'}`,
          meta,
          progress: ticket.progress ?? 0,
          url: link,
        }),
        t.paragraph('What happens next:', { muted: true, size: 13 }),
        t.bulletList([
          `A first reply is due by ${t.formatWhen(ticket.responseDueAt) || 'the agreed response window'}.`,
          'The portal updates as the work moves.',
          'Reply on the ticket any time. The team sees it.',
        ]),
      ],
      cta: link ? { label: 'Track this ticket', url: link } : null,
      secondaryCta: progressLink() ? { label: 'See all work progress', url: progressLink() } : null,
      reason: 'Sent because you raised this request in your portal.',
    }),
    text: t.renderText([
      `Your request is logged as ${ticket.id}.`,
      '',
      ...metaTextLines(meta),
      '',
      link ? `Track this ticket: ${link}` : null,
    ]),
  };
}

/** Someone now owns this ticket -- the ClickUp "assigned to you" moment. */
function ticketAssigned({ ticket, assigneeName, clientName, actorName, actor = null }) {
  const meta = ticketMeta(ticket, { clientName, assigneeName });
  const link = ticketLink(ticket.id);
  const who = (actor && actor.name) || actorName || 'A manager';

  return {
    subject: `Assigned to you: ${ticket.subject} (${ticket.id})`,
    html: t.renderEmail({
      preheader: `${who} assigned you ${ticket.id}`,
      eyebrow: 'Assignment',
      hero: 'badge-assign',
      title: `${who} assigned you a ticket`,
      actor: actorCard(actor, actorName, `${who} assigned this to you`),
      blocks: [
        t.taskCard({
          status: ticket.status || 'Open',
          title: ticket.subject,
          breadcrumb: `Support tickets / ${ticket.category || 'General'}`,
          meta,
          progress: ticket.progress ?? null,
          url: link,
        }),
        t.paragraph('Post your first note on the ticket to stop the response clock.', { muted: true, size: 13 }),
      ],
      cta: link ? { label: 'Open ticket', url: link } : null,
      reason: 'Sent because this ticket was assigned to you.',
    }),
    text: t.renderText([
      `${who} assigned you ticket ${ticket.id}: ${ticket.subject}`,
      '',
      ...metaTextLines(meta),
      '',
      link ? `Open ticket: ${link}` : null,
    ]),
  };
}

/** Status moved. Goes to the client, in their language rather than ours. */
function ticketStatusChanged({ ticket, fromStatus, toStatus, clientName, assigneeName }) {
  const link = ticketLink(ticket.id);
  const done = ['Resolved', 'Closed'].includes(toStatus);

  return {
    subject: done
      ? `Resolved: ${ticket.subject} (${ticket.id})`
      : `${ticket.id} is now ${toStatus}: ${ticket.subject}`,
    html: t.renderEmail({
      preheader: `${fromStatus || 'Open'} to ${toStatus}`,
      eyebrow: 'Status update',
      // The one message here whose badge depends on the news. A ticket reaching
      // "resolved" has earned the tick; a move to "in progress" has not, and
      // using the same mark for both is how a tick stops meaning anything.
      hero: done ? 'badge-status' : 'badge-ticket',
      title: done ? 'Your request is resolved' : `Your request moved to ${toStatus}`,
      blocks: [
        t.paragraph(
          done
            ? `Hi ${clientName || 'there'}. The team finished ${ticket.id}. If something still looks wrong, reply on the ticket and it reopens.`
            : `Hi ${clientName || 'there'}. ${ticket.id} moved from ${fromStatus || 'Open'} to ${toStatus}.`,
        ),
        t.ruleAccent(),
        t.taskCard({
          status: toStatus,
          title: ticket.subject,
          breadcrumb: `Your tickets / ${ticket.category || 'General'}`,
          meta: [
            { label: 'Ticket', value: ticket.id },
            { label: 'Previous status', value: fromStatus || 'Open' },
            { label: 'Owner', value: assigneeName || 'Your account team' },
            { label: 'Stage', value: stageLabel(ticket.stage) },
          ],
          progress: done ? 100 : ticket.progress ?? null,
          url: link,
        }),
      ],
      cta: link ? { label: done ? 'Review the work' : 'Track this ticket', url: link } : null,
      reason: 'Sent because you raised this request.',
    }),
    text: t.renderText([
      `${ticket.id} "${ticket.subject}" is now ${toStatus}.`,
      fromStatus ? `Previous status: ${fromStatus}` : null,
      assigneeName ? `Owner: ${assigneeName}` : null,
      '',
      link ? `Open ticket: ${link}` : null,
    ]),
  };
}

/** A note was posted on a ticket -- the ClickUp "new comment" email. */
function ticketComment({ ticket, authorName, body, progress, stage, forClient = true }) {
  const link = ticketLink(ticket.id);
  const movedTracker = progress !== null && progress !== undefined;

  return {
    subject: `New update on ${ticket.id}: ${ticket.subject}`,
    html: t.renderEmail({
      preheader: `${authorName} commented on ${ticket.id}`,
      eyebrow: 'New comment',
      hero: 'badge-comment',
      title: `${authorName} posted an update`,
      actor: { name: authorName, line: `${authorName} commented on ${ticket.id}` },
      blocks: [
        body ? t.comment({ author: authorName, at: Date.now(), body }) : '',
        t.taskCard({
          status: ticket.status || 'Open',
          title: ticket.subject,
          breadcrumb: forClient ? `Your tickets / ${ticket.category || 'General'}` : `Support tickets / ${ticket.category || 'General'}`,
          meta: [
            { label: 'Ticket', value: ticket.id },
            { label: 'Stage', value: stageLabel(stage ?? ticket.stage) },
          ],
          progress: movedTracker ? progress : ticket.progress ?? null,
          url: link,
        }),
      ].filter(Boolean),
      cta: link ? { label: 'Reply on the ticket', url: link } : null,
      reason: forClient
        ? 'Sent because you raised this request.'
        : 'Sent because you are working on this ticket.',
    }),
    text: t.renderText([
      `${authorName} posted an update on ${ticket.id} "${ticket.subject}":`,
      '',
      body || '(no message)',
      '',
      movedTracker ? `Progress: ${progress}%` : null,
      stageLabel(stage ?? ticket.stage) ? `Stage: ${stageLabel(stage ?? ticket.stage)}` : null,
      '',
      link ? `Reply on the ticket: ${link}` : null,
    ]),
  };
}

/** Someone is being asked to take over, or to help. */
function ticketRequest({ ticket, kind, fromName, toName, note }) {
  const handover = kind === 'handover';
  const link = ticketLink(ticket.id);

  return {
    subject: handover
      ? `${fromName} asked you to take over ${ticket.id}`
      : `${fromName} asked for your help on ${ticket.id}`,
    html: t.renderEmail({
      preheader: `${fromName} sent you a ${handover ? 'handover' : 'collaboration'} request`,
      eyebrow: handover ? 'Handover request' : 'Collaboration request',
      hero: 'badge-handover',
      title: handover
        ? `${fromName} wants to hand this ticket to you`
        : `${fromName} wants your help on this ticket`,
      actor: { name: fromName, line: `${fromName} to ${toName}` },
      blocks: [
        note ? t.comment({ author: fromName, at: Date.now(), body: note }) : '',
        t.taskCard({
          status: ticket.status || 'Open',
          title: ticket.subject,
          breadcrumb: `Support tickets / ${ticket.category || 'General'}`,
          meta: [
            { label: 'Ticket', value: ticket.id },
            { label: 'Priority', value: ticket.priority || 'Normal' },
            { label: 'Stage', value: stageLabel(ticket.stage) },
            { label: 'First response due', value: t.formatWhen(ticket.responseDueAt) },
          ],
          url: link,
        }),
        t.paragraph('Accept or decline from the ticket timeline. Nothing changes until you answer.', { muted: true, size: 13 }),
      ].filter(Boolean),
      cta: link ? { label: 'Answer the request', url: link } : null,
      reason: 'Sent because a teammate asked you about a ticket.',
    }),
    text: t.renderText([
      handover
        ? `${fromName} asked you to take over ${ticket.id} "${ticket.subject}".`
        : `${fromName} asked for your help on ${ticket.id} "${ticket.subject}".`,
      note ? `\nNote: ${note}` : null,
      '',
      link ? `Answer the request: ${link}` : null,
    ]),
  };
}

/** The first-response clock is about to run out. Goes to owner plus admins. */
function slaWarning({ ticket, assigneeName, clientName, minutesLeft }) {
  const link = ticketLink(ticket.id);
  const overdue = minutesLeft <= 0;

  return {
    subject: overdue
      ? `Overdue first response: ${ticket.id}`
      : `First response due in ${minutesLeft} min: ${ticket.id}`,
    html: t.renderEmail({
      preheader: overdue ? `${ticket.id} is past its first-response deadline` : `${minutesLeft} minutes left on ${ticket.id}`,
      eyebrow: overdue ? 'Overdue' : 'Due soon',
      hero: 'badge-clock',
      title: overdue ? 'This ticket has no first response yet' : 'A first response is due soon',
      blocks: [
        t.callout({
          tone: overdue ? 'danger' : 'warn',
          title: overdue ? 'Past due' : 'Due soon',
          body: overdue
            ? `${ticket.id} passed its first-response deadline of ${t.formatWhen(ticket.responseDueAt)}.`
            : `${ticket.id} needs a first response by ${t.formatWhen(ticket.responseDueAt)}.`,
        }),
        t.taskCard({
          status: ticket.status || 'Open',
          title: ticket.subject,
          breadcrumb: `Support tickets / ${ticket.category || 'General'}`,
          meta: ticketMeta(ticket, { clientName, assigneeName }),
          url: link,
        }),
      ],
      cta: link ? { label: 'Respond now', url: link } : null,
      reason: 'Sent because you own this ticket or administer this workspace.',
    }),
    text: t.renderText([
      overdue
        ? `${ticket.id} is past its first-response deadline (${t.formatWhen(ticket.responseDueAt)}).`
        : `${ticket.id} needs a first response by ${t.formatWhen(ticket.responseDueAt)}.`,
      '',
      link ? `Respond now: ${link}` : null,
    ]),
  };
}

/**
 * Credentials for a login an admin just issued. The password is shown once,
 * here, because the admin cannot retrieve it afterwards either.
 */
function credentialsIssued({ user, temporaryPassword, expiresAt, sections, invitedBy, isReset = false, signInUrl = null }) {
  const link = loginLink();
  const roleWord = user.role === 'client' ? 'client portal' : 'team dashboard';
  // A one-tap link when there is one: the reader is on a phone, and the point
  // is that the first sign-in costs no typing. The password below still works
  // for every sign-in after it.
  const oneTap = t.safeUrl(signInUrl);

  return {
    subject: isReset
      ? `Your ${t.brand().name} password was reset`
      : `Your ${t.brand().name} ${roleWord} login`,
    html: t.renderEmail({
      preheader: isReset ? 'A new password for your account' : 'Your password, or a one-tap link',
      eyebrow: isReset ? 'Password reset' : 'Welcome',
      hero: 'badge-credentials',
      title: isReset ? 'Your password has been reset' : `Your ${roleWord} login`,
      actor: invitedBy ? { name: invitedBy, line: `${invitedBy} set this up for you` } : null,
      blocks: [
        t.paragraph(
          isReset
            ? `Hi ${user.name}. Your old password has stopped working. Here is the new one.`
            : `Hi ${user.name}. Two ways in, whichever suits.`,
        ),
        // The two routes sit side by side as equals, so the message reads
        // across the card instead of scrolling past one to reach the other.
        // Below 720px they stack, password first.
        t.columns([
          t.panel({
            title: 'With your password',
            // Only the password gets the black block. The email address is not
            // a secret and nobody mistypes their own, so making both look like
            // something to copy just adds weight.
            html: [
              t.fact('Email', user.email),
              t.codeValue('Password', temporaryPassword, { hint: 'Tap to select' }),
            ].join(''),
          }),
          oneTap
            ? t.panel({
              title: 'Or one tap',
              html: [
                t.button({ label: 'Sign in with link', url: oneTap, margin: '2px 0 10px' }),
                t.paragraph('No password to type. Works once, for 24 hours.', { muted: true, size: 13 }),
              ].join(''),
            })
            : null,
        ]),
        expiresAt ? t.fact('Access until', t.formatWhen(expiresAt)) : '',
      ].filter(Boolean),
      cta: null,
      reason: 'Sent because an administrator created or reset this account.',
    }),
    text: t.renderText([
      isReset ? 'Your password has been reset.' : 'Your login is ready.',
      '',
      `Email: ${user.email}`,
      `Password: ${temporaryPassword}`,
      link ? `Sign in: ${link}` : null,
      '',
      oneTap ? 'Or use this link instead. Works once, for 24 hours:' : null,
      oneTap || null,
      expiresAt ? `\nAccess until ${t.formatWhen(expiresAt)}.` : null,
    ]),
  };
}

/**
 * The six-digit code that finishes a sign-in.
 *
 * Short, no marketing, one number, because the reader is mid-login and staring
 * at a code box.
 */
function loginCode({ user, code, expiresAt, ipAddress }) {
  const minutes = Math.max(1, Math.round((Number(expiresAt) - Date.now()) / 60000));

  return {
    subject: `${code} is your ${t.brand().name} sign-in code`,
    html: t.renderEmail({
      preheader: `Your code expires in ${minutes} minutes.`,
      eyebrow: 'Verification',
      hero: 'badge-key',
      title: 'Finish signing in',
      blocks: [
        t.paragraph(`Hi ${user.name}. Enter this code to finish signing in. It expires in ${minutes} minutes.`),
        t.callout({ tone: 'info', title: 'Your code', mono: true, body: code }),
        t.paragraph(
          ipAddress
            ? `Requested from ${ipAddress}. If that was not you, do not enter the code. Change your password and tell an administrator.`
            : 'If you did not try to sign in, ignore this email and tell an administrator.',
          { muted: true, size: 13 },
        ),
      ],
      reason: 'Sent because someone asked to sign in to your account.',
    }),
    text: t.renderText([
      `Your ${t.brand().name} sign-in code is ${code}.`,
      `It expires in ${minutes} minutes.`,
      '',
      ipAddress ? `Requested from ${ipAddress}.` : null,
      'If this was not you, do not enter the code.',
    ]),
  };
}

/** A new administrator joined -- announced to every existing administrator. */
function adminRosterChanged({ actorName, targetName, targetEmail, change, adminCount }) {
  const base = baseUrl();
  const added = change === 'added';

  return {
    subject: added
      ? `${targetName} is now an administrator`
      : `${targetName} is no longer an administrator`,
    html: t.renderEmail({
      preheader: `${actorName} ${added ? 'promoted' : 'removed'} ${targetName}`,
      eyebrow: 'Administration',
      hero: 'badge-admin',
      title: added ? 'A new administrator was added' : 'An administrator was removed',
      actor: { name: actorName, line: `${actorName} made this change` },
      blocks: [
        t.taskCard({
          status: added ? 'Open' : 'Closed',
          title: `${targetName} (${targetEmail})`,
          breadcrumb: 'Workspace / Administrators',
          meta: [
            { label: 'Change', value: added ? 'Granted admin access' : 'Admin access revoked' },
            { label: 'Made by', value: actorName },
            { label: 'Administrators now', value: String(adminCount) },
            { label: 'When', value: t.formatWhen(Date.now()) },
          ],
        }),
        t.paragraph(
          'Every administrator has the same powers: issuing logins, managing tickets, and changing this roster. Review the list if this was not expected.',
          { muted: true, size: 13 },
        ),
      ],
      cta: base ? { label: 'Review the team', url: `${base}/portal/team` } : null,
      reason: 'You are receiving this because you are an administrator of this workspace.',
    }),
    text: t.renderText([
      added
        ? `${actorName} granted admin access to ${targetName} (${targetEmail}).`
        : `${actorName} revoked admin access from ${targetName} (${targetEmail}).`,
      `Administrators now: ${adminCount}`,
      '',
      base ? `Review the team: ${base}/portal/team` : null,
    ]),
  };
}

/** Periodic "here is where your work stands" mail for a client. */
function progressDigest({ clientName, tickets = [], projects = [], period = 'this week' }) {
  const link = progressLink();
  const open = tickets.filter((x) => !['Resolved', 'Closed'].includes(x.status));
  const closed = tickets.filter((x) => ['Resolved', 'Closed'].includes(x.status));

  const cards = open.slice(0, 5).map((ticket) =>
    t.taskCard({
      status: ticket.status || 'Open',
      title: ticket.subject,
      breadcrumb: `Your tickets / ${ticket.category || 'General'}`,
      meta: [
        { label: 'Ticket', value: ticket.id },
        { label: 'Stage', value: stageLabel(ticket.stage) },
      ],
      progress: ticket.progress ?? 0,
      url: ticketLink(ticket.id),
    }));

  return {
    subject: `Your ${period} progress summary`,
    html: t.renderEmail({
      preheader: `${open.length} in flight, ${closed.length} finished ${period}`,
      eyebrow: 'Progress summary',
      hero: 'badge-optimise',
      title: `Where your work stands ${period}`,
      blocks: [
        t.paragraph(`Hi ${clientName || 'there'}. Here is where your work stands.`),
        t.callout({
          tone: 'info',
          title: 'At a glance',
          body: `${open.length} request${open.length === 1 ? '' : 's'} in flight\n${closed.length} finished ${period}\n${projects.length} active project${projects.length === 1 ? '' : 's'}`,
        }),
        ...cards,
        open.length > 5 ? t.paragraph(`And ${open.length - 5} more in your portal.`, { muted: true, size: 13 }) : '',
        t.divider(),
        projects.length > 0
          ? [t.paragraph('Active projects', { muted: true, size: 13 }), t.bulletList(projects.map((p) => `${p.name}: ${p.status}`))].join('\n')
          : '',
      ].filter(Boolean),
      cta: link ? { label: 'Open the progress board', url: link } : null,
      reason: 'Sent because you have a client portal account.',
    }),
    text: t.renderText([
      `Progress summary ${period}`,
      '',
      `${open.length} in flight, ${closed.length} finished, ${projects.length} active projects.`,
      '',
      ...open.slice(0, 8).map((x) => `- [${x.status}] ${x.id} ${x.subject} (${x.progress ?? 0}%)`),
      '',
      link ? `Open the progress board: ${link}` : null,
    ]),
  };
}

function billingLink() {
  const base = baseUrl();
  return base ? `${base}/portal/billing` : null;
}

function plansLink() {
  const base = baseUrl();
  return base ? `${base}/portal/billing/plans` : null;
}

/** A plain calendar date. Renewals and period ends are days, not moments. */
function planDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function ticketsLink() {
  const base = baseUrl();
  return base ? `${base}/portal/tickets` : null;
}

/**
 * Where somebody changes what we send them.
 *
 * Required on commercial mail, and the honest version of it is a page they can
 * actually act on rather than a dead anchor. Defaults to their own profile;
 * MAIL_PREFERENCES_URL repoints it without a deploy if that moves.
 */
function preferencesLink() {
  const override = String(process.env.MAIL_PREFERENCES_URL || '').trim();
  if (override) return override;
  const base = baseUrl();
  return base ? `${base}/portal/profile` : null;
}

function legalLinks() {
  const base = baseUrl();
  if (!base) return [];
  return [
    { label: 'Terms of Service', url: `${base}/terms` },
    { label: 'Privacy Policy', url: `${base}/privacy` },
  ];
}

/**
 * Which badge stands for each plan.
 *
 * From the set the rest of the app's email already uses, so the plan cards
 * look like they come from the same place as every other message rather than
 * from a stock icon pack. The glyph says what the plan *is* before a word is
 * read: a team, a pair of hands, a website.
 */
const PLAN_ICON = {
  unlimited: 'badge-people',
  managed: 'badge-support',
  basic: 'badge-website',
};

/**
 * One plan, as a card.
 *
 * The price is the biggest thing on it, because it is what somebody skimming
 * on a phone is actually looking for. Under it, three or four two-word lines
 * rather than a sentence -- a pricing card has room for keywords, and a
 * paragraph in a card is a paragraph nobody finishes.
 *
 * Built as a table with a solid `bgcolor` so Outlook, which drops the border
 * radius and the gradient, is still left with a coloured box and a readable
 * price. The featured plan is distinguished by weight and a tint rather than
 * by being the only one with a border, so it survives a client that strips
 * backgrounds.
 */
function planCard(plan, { featured = false } = {}) {
  const tint = featured ? t.TOKENS.brandSoft : t.TOKENS.panel;
  const edge = featured ? t.TOKENS.brand : t.TOKENS.border;
  const priceColor = featured ? t.TOKENS.brandDeep : t.TOKENS.text;

  const badge = plan.badge
    ? `<div style="font-family:${t.TOKENS.font};font-size:10px;font-weight:700;letter-spacing:.09em;`
      + `text-transform:uppercase;color:${featured ? t.TOKENS.brand : t.TOKENS.muted};padding:0 0 8px;">`
      + `${t.escapeHtml(plan.badge)}</div>`
    : `<div style="font-size:10px;line-height:18px;padding:0 0 8px;">&nbsp;</div>`;

  // The marker in its own cell, not inline before the text.
  //
  // Inline, a line long enough to wrap -- "Priority support with a guaranteed
  // response time" -- puts its second line hard against the left edge, under
  // the bullet, and the list stops looking like a list. A separate narrow cell
  // gives the text column its own left edge, so every wrapped line lands under
  // the first word instead.
  const lines = plan.highlights.map((h) => [
    '<tr>',
    `<td valign="top" width="10" style="width:10px;padding:0 6px 5px 0;font-family:${t.TOKENS.font};`
      + `font-size:13px;line-height:1.5;color:${t.TOKENS.brand};">&bull;</td>`,
    `<td valign="top" style="padding:0 0 5px;font-family:${t.TOKENS.font};font-size:13px;`
      + `line-height:1.5;color:${t.TOKENS.soft};">${t.escapeHtml(h.label)}</td>`,
    '</tr>',
  ].join('')).join('');

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${tint}" `
      + `style="background:${tint};border:1px solid ${edge};border-radius:12px;">`,
    '<tr><td align="center" style="padding:18px 14px 16px;">',
    // The glyph. Decorative, so the alt is empty -- a client that blocks
    // images loses a picture, not a word of meaning.
    `<div style="padding:0 0 10px;">${t.iconTile({ size: 40, icon: PLAN_ICON[plan.key] || 'badge-website' })}</div>`,
    badge,
    `<div style="font-family:${t.TOKENS.font};font-size:15px;font-weight:600;color:${t.TOKENS.text};">${t.escapeHtml(plan.name)}</div>`,
    `<div style="font-family:${t.TOKENS.font};font-size:34px;line-height:1.1;font-weight:700;letter-spacing:-.02em;`
      + `color:${priceColor};padding:6px 0 0;">${t.escapeHtml(plansConfig.formatUsd(plan.monthlyUsd))}</div>`,
    `<div style="font-family:${t.TOKENS.font};font-size:11px;letter-spacing:.06em;text-transform:uppercase;`
      + `color:${t.TOKENS.muted};padding:2px 0 12px;">per month USD</div>`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;text-align:left;">${lines}</table>`,
    '</td></tr></table>',
  ].join('');
}

/**
 * The three cards side by side, stacking to one column on a phone.
 *
 * The gap is a spacer column, not padding on the cells.
 *
 * Padding on a `<td>` is added to its declared width in email HTML -- there is
 * no box-sizing to rely on -- so three cells at 33% plus 10px of padding each
 * came to more than the table could hold, and the row pushed past the right
 * edge of the message. The third card lost its prices. Narrow cells with real
 * spacer columns between them add up to exactly 100% and cannot do that.
 *
 * The spacers carry `ew-col` too, so on a phone they collapse into the same
 * stacked flow as the cards and leave a gap between them rather than becoming
 * a stray cell beside a block.
 */
function planCards(catalogue) {
  const cells = [];
  catalogue.plans.forEach((plan, i) => {
    if (i > 0) {
      cells.push('<td class="ew-col" width="2%" style="width:2%;font-size:0;line-height:0;">&nbsp;</td>');
    }
    cells.push(
      `<td class="ew-col" width="32%" valign="top" style="width:32%;">`
      + `${planCard(plan, { featured: plan.key === 'unlimited' })}</td>`,
    );
  });
  return [
    // Fixed layout so the declared widths are honoured rather than being
    // renegotiated by the widest price in the row.
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
      + 'style="table-layout:fixed;width:100%;margin:0 0 18px;">',
    `<tr>${cells.join('')}</tr>`,
    '</table>',
  ].join('');
}

/**
 * One number, said once, as big as it deserves.
 *
 * Replaces a sentence like "You picked Unlimited (12 months), $278.40 USD" in
 * the two emails that confirm something. The figure is the message; the words
 * around it were doing nothing a label could not.
 */
function statBand({ label, value, sub = null }) {
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${t.TOKENS.panel}" `
      + `style="background:${t.TOKENS.panel};border:1px solid ${t.TOKENS.border};border-radius:12px;margin:0 0 18px;">`,
    '<tr><td align="center" style="padding:20px 18px;">',
    `<div style="font-family:${t.TOKENS.font};font-size:11px;font-weight:600;letter-spacing:.08em;`
      + `text-transform:uppercase;color:${t.TOKENS.muted};padding-bottom:6px;">${t.escapeHtml(label)}</div>`,
    `<div style="font-family:${t.TOKENS.font};font-size:30px;line-height:1.15;font-weight:700;letter-spacing:-.02em;`
      + `color:${t.TOKENS.text};">${t.escapeHtml(value)}</div>`,
    sub
      ? `<div style="font-family:${t.TOKENS.font};font-size:13px;color:${t.TOKENS.soft};padding-top:6px;">${t.escapeHtml(sub)}</div>`
      : '',
    '</td></tr></table>',
  ].join('');
}

/**
 * The sign-off, on two lines.
 *
 * The name and the company stacked rather than "Yash, Ethixweb" on one line --
 * it reads as somebody signing a letter instead of as a byline, which is the
 * difference between a message from a person and a message from a system.
 */
function signOff() {
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0;">`,
    `<tr><td style="font-family:${t.TOKENS.font};font-size:14px;line-height:1.5;color:${t.TOKENS.text};">`,
    'Yash',
    `<div style="color:${t.TOKENS.muted};">${t.escapeHtml(t.brand().name)}</div>`,
    '</td></tr></table>',
  ].join('');
}

/** The small uppercase label above a grid. */
function gridHeading(text) {
  return `<div style="font-family:${t.TOKENS.font};font-size:11px;font-weight:600;letter-spacing:.08em;`
    + `text-transform:uppercase;color:${t.TOKENS.muted};padding:0 0 10px;">${t.escapeHtml(text)}</div>`;
}

/** A compact grid of what a plan covers: two columns of short labels. */
function perkGrid(perks, { columns: cols = 2 } = {}) {
  if (!perks.length) return '';
  const rows = [];
  for (let i = 0; i < perks.length; i += cols) {
    // Each cell holds its own two-column table, for the same hanging indent
    // the plan cards use: a wrapped perk lines up under its own first word
    // rather than under the bullet.
    const cells = perks.slice(i, i + cols).map((p) => (
      `<td class="ew-col" width="${Math.round(100 / cols)}%" valign="top" `
      + `style="width:${Math.round(100 / cols)}%;padding:0 10px 8px 0;">`
      + '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
      + `<td valign="top" width="10" style="width:10px;padding:0 6px 0 0;font-family:${t.TOKENS.font};`
      + `font-size:13px;line-height:1.5;color:${t.TOKENS.brand};">&bull;</td>`
      + `<td valign="top" style="font-family:${t.TOKENS.font};font-size:13px;line-height:1.5;`
      + `color:${t.TOKENS.soft};">${t.escapeHtml(p)}</td>`
      + '</tr></table></td>'
    ));
    while (cells.length < cols) cells.push('<td class="ew-col">&nbsp;</td>');
    rows.push(`<tr>${cells.join('')}</tr>`);
  }
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
    + `style="margin:0 0 18px;">${rows.join('')}</table>`;
}

/**
 * The first thing a new client reads, and the one that asks them to pick.
 *
 * Sent once: immediately when an account is created, or on the first sign-in
 * of a client who predates this feature. Every price in it is read from
 * lib/plans.js rather than typed, so the figures here, the plans modal and the
 * amount an admin asks for cannot drift apart.
 *
 * `existingFreeClient` adds the one line that explains why a site which has
 * been running at no charge now needs a plan. It is stated plainly and once,
 * with no deadline and no threat -- the sales playbook is explicit that
 * hosting is linked to a plan calmly and never as a threat.
 */
function welcomeWithPlans({ firstName, existingFreeClient = false }) {
  const base = baseUrl();
  const catalogue = plansConfig.describeAll();
  const byKey = (key) => catalogue.plans.find((p) => p.key === key);

  const unlimited = byKey('unlimited');
  const managed = byKey('managed');
  const basic = byKey('basic');

  const yearly = plansConfig.PERIODS.find((p) => p.months === 12);
  const yearlyPct = Math.round(yearly.discount * 100);
  const unlimitedYearly = unlimited.prices.find((p) => p.months === 12);

  const usd = (n) => `${plansConfig.formatUsd(n)}`;

  return {
    subject: 'Your Ethixweb dashboard is ready, here are your plan options',
    html: t.renderEmail({
      preheader: 'Pick the plan that fits how much you want us to handle.',
      eyebrow: 'Your dashboard is ready',
      title: 'Your Ethixweb dashboard is ready',
      // Three cards carry the plans. What used to be three long sentences is
      // now a price, a glyph and four keywords each -- the comparison somebody
      // actually makes, made visually instead of described.
      blocks: [
        t.paragraph(
          `Hi ${firstName || 'there'}, your dashboard is ready. See your website, raise a request, `
          + 'track it to done.',
          { align: 'justify' },
        ),
        existingFreeClient
          ? t.paragraph(
            'Your site has been on our servers at no charge. To stay live and supported, it now '
            + 'needs a plan.',
            { align: 'justify' },
          )
          : '',
        planCards(catalogue),
        t.paragraph(
          `12 months saves ${yearlyPct}%. The ${unlimited.name} plan works out at `
          + `${usd(unlimitedYearly.perMonth)} a month.`,
          { align: 'justify', muted: true, size: 13 },
        ),
        // The sign-off sits with the body, above the buttons. renderEmail puts
        // the call to action last, and a name printed under a button reads as
        // a caption on it rather than as somebody signing the message.
        t.paragraph('Questions? Just reply to this email.', { align: 'justify' }),
        signOff(),
      ].filter(Boolean),
      cta: plansLink() ? { label: 'Choose your plan', url: plansLink() } : null,
      secondaryCta: base ? { label: 'Log in to your dashboard', url: base } : null,
      reason: 'Sent once, because your Ethixweb dashboard was set up.',
      links: [
        ...legalLinks(),
        preferencesLink() ? { label: 'Email preferences', url: preferencesLink() } : null,
      ].filter(Boolean),
    }),
    // The plain-text twin keeps the same shape: a price, then keywords. A
    // client whose mail reader strips HTML gets the comparison, not an essay.
    text: t.renderText([
      `Hi ${firstName || 'there'}, your dashboard is ready.`,
      'See your website, raise a request, track it to done.',
      '',
      existingFreeClient
        ? 'Your site has been on our servers at no charge. To stay live and supported, it now needs a plan.'
        : null,
      existingFreeClient ? '' : null,
      ...catalogue.plans.flatMap((plan) => [
        `${plan.name} - ${usd(plan.monthlyUsd)}/month USD${plan.badge ? ` (${plan.badge})` : ''}`,
        ...plan.highlights.map((h) => `  - ${h.label}`),
        '',
      ]),
      `12 months saves ${yearlyPct}%. The ${unlimited.name} plan works out at ${usd(unlimitedYearly.perMonth)} a month.`,
      '',
      plansLink() ? `Choose your plan: ${plansLink()}` : null,
      base ? `Log in: ${base}` : null,
      '',
      'Questions? Just reply to this email.',
      '',
      'Yash',
      t.brand().name,
      '',
      ...legalLinks().map((l) => `${l.label}: ${l.url}`),
    ]),
  };
}

/**
 * Seven days before a multi-month plan comes up for renewal.
 *
 * Sent only for the 3, 6 and 12 month periods, because those are the ones paid
 * upfront: a client who handed over $278.40 in January should not be surprised
 * by the same request in December. A monthly plan is its own reminder.
 *
 * No urgency and no countdown. It says the date, the amount, and the two
 * things they might want to do about it -- including cancelling, in the same
 * voice and the same size as everything else. A renewal notice that hides the
 * way out is the thing that turns an ordinary churn into a complaint.
 */
function renewalReminder({ clientName, planName, periodLabel, amountUsd, renewsAt }) {
  const amount = money(amountUsd, 'usd');
  const renews = planDate(renewsAt);
  const base = baseUrl();

  return {
    subject: `Your ${planName} plan renews on ${renews}`,
    html: t.renderEmail({
      preheader: `${amount} USD for another ${periodLabel}. Nothing to do if you are happy.`,
      eyebrow: 'Renewal coming up',
      hero: 'badge-clock',
      title: `Your ${planName} plan renews on ${renews}`,
      blocks: [
        // One number, said once. The four-cell panel this replaces was mostly
        // repeating the title.
        // "Renews in 7 days" was written into the label, not worked out. The
        // sweep fires any time inside the week before a renewal, so it was
        // only true on the day it happened to run first -- and it went stale
        // again every day the message sat unread. The date in the title is the
        // fact; this is the amount.
        statBand({
          label: 'Renewal amount',
          value: `${amount} USD`,
          sub: `${planName} plan, ${periodLabel}`,
        }),
        t.paragraph('Happy as you are? Nothing to do. We will send payment details nearer the date.', { align: 'justify' }),
        // Akash asked how long somebody has to change their mind. The answer
        // is "right up to the day", and not saying so invites the question.
        t.paragraph(
          `Want a different plan, or to stop? You can do either from your Billing page any time `
          + `before ${renews}.`,
          { align: 'justify', muted: true, size: 13 },
        ),
        signOff(),
      ],
      cta: billingLink() ? { label: 'Open Billing', url: billingLink() } : null,
      secondaryCta: plansLink() ? { label: 'Change your plan', url: plansLink() } : null,
      reason: 'Sent seven days before a multi-month plan renews.',
      links: [
        ...legalLinks(),
        preferencesLink() ? { label: 'Email preferences', url: preferencesLink() } : null,
      ].filter(Boolean),
    }),
    text: t.renderText([
      `Hi ${clientName || 'there'},`,
      '',
      `Your ${planName} plan renews on ${renews}.`,
      `${amount} USD for ${periodLabel}.`,
      '',
      'Happy as you are? Nothing to do. We will send payment details nearer the date.',
      `Want a different plan, or to stop? You can do either from your Billing page any time before ${renews}.`,
      '',
      'Yash',
      t.brand().name,
      '',
      billingLink() ? `Billing: ${billingLink()}` : null,
      base ? `Log in: ${base}` : null,
      ...legalLinks().map((l) => `${l.label}: ${l.url}`),
    ]),
  };
}

/**
 * The plan is paid for and running.
 *
 * The sales playbook's confirmation message, as an email rather than something
 * typed by hand after every sale. It answers the four questions a client has
 * once they have parted with money: what did I buy, what did it cost, when
 * does it happen again, and how do I use it. Then it says how to leave, in the
 * same voice and the same size as everything else -- a cancellation route
 * buried in small print is the thing that turns an ordinary churn into a
 * complaint.
 *
 * Every figure is passed in from the subscription row, which is the same row
 * the Billing page renders, so this email and that screen cannot disagree.
 */
function planConfirmed({ clientName, planName, periodLabel, amountUsd, renewsAt, creditUsd, fromPlanName, perks = [] }) {
  const amount = money(amountUsd, 'usd');
  // A date, with no time on it. `formatWhen` adds "2:05 PM", which on a
  // renewal reads as the minute a card will be charged -- a detail nobody
  // asked for and that invites a worried reply.
  const renews = planDate(renewsAt);
  const base = baseUrl();

  return {
    subject: `You're on the ${planName} plan, and your site is covered`,
    html: t.renderEmail({
      preheader: `${planName}, ${periodLabel}, ${amount} USD. Renews ${renews || 'at the end of your period'}.`,
      eyebrow: 'Plan confirmed',
      // The badge carries "this is good news" so the sentence that used to say
      // it can go.
      hero: 'badge-payment',
      // 'You're on Unlimited' reads as an adjective with no noun -- Akash asked
      // what Unlimited was. The word 'plan' is what makes it a thing.
      title: `You're on the ${planName} plan`,
      blocks: [
        // The amount is the message. It used to be the fourth cell of a panel
        // under two sentences explaining that a payment had been confirmed.
        statBand({
          label: 'Paid',
          value: `${amount} USD`,
          sub: renews ? `${planName} plan, ${periodLabel}, renews ${renews}` : `${planName} plan, ${periodLabel}`,
        }),
        creditUsd > 0 && fromPlanName
          ? t.paragraph(
            `After ${money(creditUsd, 'usd')} credited from your ${fromPlanName} plan.`,
            { muted: true, size: 13 },
          )
          : '',
        // Two short columns of keywords instead of a ten-line bulleted essay.
        // `t.fact` renders nothing when its value is empty, so the heading is
        // its own line rather than a fact with no fact in it.
        perks.length ? gridHeading('What it covers') : '',
        perks.length ? perkGrid(perks.slice(0, 8)) : '',
        t.paragraph('Need something doing? Raise a request and it goes straight to the team.', { align: 'justify' }),
        t.paragraph('Change or cancel any time from Billing. Hosting runs to the end of your period.', { align: 'justify', muted: true, size: 13 }),
        signOff(),
      ].filter(Boolean),
      cta: base ? { label: 'Open your dashboard', url: base } : null,
      secondaryCta: ticketsLink() ? { label: 'Raise a request', url: ticketsLink() } : null,
      reason: 'Sent because your payment was confirmed and your plan started.',
      links: [
        billingLink() ? { label: 'Billing', url: billingLink() } : null,
        plansLink() ? { label: 'Change your plan', url: plansLink() } : null,
        ...legalLinks(),
      ].filter(Boolean),
    }),
    text: t.renderText([
      `You're on the ${planName} plan.`,
      '',
      `Paid: ${amount} USD`,
      `Period: ${periodLabel}`,
      renews ? `Renews: ${renews}` : null,
      creditUsd > 0 && fromPlanName
        ? `After ${money(creditUsd, 'usd')} credited from your ${fromPlanName} plan.`
        : null,
      '',
      perks.length ? 'What it covers:' : null,
      ...perks.slice(0, 8).map((p) => `  - ${p}`),
      '',
      'Need something doing? Raise a request and it goes straight to the team.',
      ticketsLink() ? `Raise a request: ${ticketsLink()}` : null,
      '',
      'Change or cancel any time from Billing. Hosting runs to the end of your period.',
      billingLink() ? `Billing: ${billingLink()}` : null,
      '',
      'Yash',
      t.brand().name,
      '',
      base ? `Log in: ${base}` : null,
      ...legalLinks().map((l) => `${l.label}: ${l.url}`),
    ]),
  };
}

/** Money exactly as Stripe reports it, in the currency Stripe reported it in. */
function money(amount, currency) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: String(currency || 'usd').toUpperCase(),
      maximumFractionDigits: 2,
    }).format(Number(amount || 0));
  } catch {
    return `${Number(amount || 0).toFixed(2)} ${String(currency || '').toUpperCase()}`;
  }
}

function cardLine(payment) {
  if (!payment?.cardBrand && !payment?.cardLast4) return null;
  const label = payment.cardBrand
    ? payment.cardBrand.charAt(0).toUpperCase() + payment.cardBrand.slice(1)
    : 'Card';
  return payment.cardLast4 ? `${label} ending ${payment.cardLast4}` : label;
}

/**
 * The receipt.
 *
 * Sent once per Stripe invoice, the first time it is seen as paid. Every
 * figure comes from the Stripe object, so the number in this email and the
 * number on the Stripe dashboard are the same number.
 */
function paymentReceived({ clientName, payment }) {
  const link = payment?.invoiceUrl || payment?.receiptUrl || billingLink();
  const amount = money(payment?.amount, payment?.currency);
  const card = cardLine(payment);

  return {
    subject: `Payment received - ${amount}`,
    html: t.renderEmail({
      preheader: `${amount} received. Nothing further is needed.`,
      eyebrow: 'Payment received',
      hero: 'badge-payment',
      title: `Thank you - ${amount} received`,
      blocks: [
        t.paragraph(`Hi ${clientName || 'there'}. Your payment went through, and there is nothing else for you to do.`),
        t.detailPanel({
          tone: 'success',
          title: 'Receipt',
          fields: [
            { label: 'Amount', value: amount },
            { label: 'Paid', value: t.formatWhen(payment?.paidAt) || 'Just now' },
            payment?.invoiceNumber ? { label: 'Invoice', value: payment.invoiceNumber } : null,
            card ? { label: 'Card', value: card } : null,
          ].filter(Boolean),
          note: payment?.description || null,
        }),
        payment?.periodStart && payment?.periodEnd
          ? t.fact('Covers', `${t.formatWhen(payment.periodStart)} to ${t.formatWhen(payment.periodEnd)}`)
          : '',
        t.paragraph('Every payment on your account is listed in your portal, with a receipt you can download.', { muted: true, size: 13 }),
      ].filter(Boolean),
      cta: link ? { label: payment?.invoiceUrl ? 'View your invoice' : 'Open billing', url: link } : null,
      secondaryCta: payment?.invoiceUrl && billingLink() ? { label: 'See all payments', url: billingLink() } : null,
      reason: 'Sent because a payment was received on your account.',
    }),
    text: t.renderText([
      `Payment received: ${amount}`,
      '',
      `Paid: ${t.formatWhen(payment?.paidAt) || 'just now'}`,
      payment?.invoiceNumber ? `Invoice: ${payment.invoiceNumber}` : null,
      card ? `Card: ${card}` : null,
      payment?.description ? `For: ${payment.description}` : null,
      '',
      link ? `Receipt: ${link}` : null,
    ]),
  };
}

/**
 * The one email in this file that asks for something.
 *
 * It says plainly what happened, what it does and does not affect, and the one
 * action that fixes it. No threats, no countdown: a declined card is usually a
 * bank being careful, not a customer refusing to pay.
 */
function paymentFailed({ clientName, payment }) {
  const link = payment?.invoiceUrl || billingLink();
  const amount = money(payment?.amount, payment?.currency);
  const card = cardLine(payment);

  return {
    subject: `We could not take your payment of ${amount}`,
    html: t.renderEmail({
      preheader: 'Your card was declined. Updating it takes about a minute.',
      eyebrow: 'Action needed',
      hero: 'badge-payment-failed',
      title: 'We could not take your last payment',
      blocks: [
        t.paragraph(`Hi ${clientName || 'there'}. Your bank declined the payment below, so your plan is on hold. Nothing has been deleted and your work is untouched.`),
        t.detailPanel({
          tone: 'danger',
          title: 'The payment that failed',
          fields: [
            { label: 'Amount', value: amount },
            { label: 'Tried', value: t.formatWhen(payment?.paidAt) || 'Just now' },
            card ? { label: 'Card', value: card } : null,
          ].filter(Boolean),
          note: payment?.failureMessage || 'The card was declined. Your bank can say why.',
        }),
        t.bulletList([
          'Updating your card in the portal retries the payment straight away.',
          'A different card works too - there is nothing tied to the old one.',
          'If you think this is a mistake, reply to this email and a person will look.',
        ]),
      ],
      cta: link ? { label: 'Update your card', url: link } : null,
      reason: 'Sent because a payment on your account did not go through.',
    }),
    text: t.renderText([
      `Payment failed: ${amount}`,
      '',
      payment?.failureMessage || 'The card was declined.',
      card ? `Card: ${card}` : null,
      '',
      'Your plan is on hold until a payment goes through. Nothing has been deleted.',
      link ? `Update your card: ${link}` : null,
    ]),
  };
}

/**
 * The periodic "here is what you paid us" summary.
 *
 * Reads the same mirrored Stripe rows the portal draws, so the email and the
 * screen can never disagree.
 */
function paymentSummary({ clientName, payments = [], total, currency = 'usd', period = 'this month' }) {
  const link = billingLink();
  const paid = payments.filter((p) => p.status === 'paid');
  const failed = payments.filter((p) => p.status === 'failed');

  return {
    subject: `What you paid ${period}`,
    html: t.renderEmail({
      preheader: `${money(total, currency)} across ${paid.length} payment${paid.length === 1 ? '' : 's'}.`,
      eyebrow: 'Payment summary',
      hero: 'badge-receipt',
      title: `${money(total, currency)} ${period}`,
      blocks: [
        t.paragraph(`Hi ${clientName || 'there'}. Here is every payment on your account ${period}, straight from our payment provider.`),
        paid.length > 0
          ? t.bulletList(paid.map((p) => `${money(p.amount, p.currency)} - ${p.description || 'Payment'} (${t.formatWhen(p.paidAt) || 'paid'})`))
          : t.paragraph('No payments were taken in this period.', { muted: true }),
        failed.length > 0
          ? t.callout({
            tone: 'danger',
            title: 'Needs your attention',
            body: `${failed.length} payment${failed.length === 1 ? '' : 's'} did not go through. Updating your card retries them.`,
          })
          : '',
      ].filter(Boolean),
      cta: link ? { label: 'See every payment', url: link } : null,
      reason: 'Sent because you have a client portal account.',
    }),
    text: t.renderText([
      `Payments ${period}: ${money(total, currency)}`,
      '',
      ...paid.map((p) => `- ${money(p.amount, p.currency)} ${p.description || 'Payment'}`),
      failed.length > 0 ? `${failed.length} failed payment(s) need a card update.` : null,
      '',
      link ? `See every payment: ${link}` : null,
    ]),
  };
}

function approvalsLink() {
  const base = baseUrl();
  return base ? `${base}/portal/approvals` : null;
}

/**
 * "Somebody wants to do something you should look at."
 *
 * Sent to every approver the moment an untrusted admin proposes a sensitive
 * change. It says who, what, and nothing else -- the decision belongs on the
 * page, where the full payload and the audit trail are, not in an inbox.
 */
function approvalRequested({ requesterName, summary, actionLabel, requestedAt }) {
  const link = approvalsLink();
  return {
    subject: `Approval needed: ${summary}`,
    html: t.renderEmail({
      preheader: `${requesterName} is waiting on a second signature.`,
      eyebrow: 'Approval needed',
      hero: 'badge-approval',
      title: `${requesterName} needs a second signature`,
      blocks: [
        t.paragraph('An administrator has proposed a change that does not take effect until someone else signs it off. Nothing has happened yet.'),
        t.detailPanel({
          tone: 'warn',
          title: 'The proposal',
          fields: [
            { label: 'Requested by', value: requesterName },
            { label: 'Kind', value: actionLabel },
            { label: 'Raised', value: t.formatWhen(requestedAt) || 'Just now' },
          ],
          note: summary,
        }),
        t.paragraph('If this was not expected, turn it down and ask them about it. A request nobody answers expires by itself after 48 hours.', { muted: true, size: 13 }),
      ],
      cta: link ? { label: 'Review this request', url: link } : null,
      reason: 'Sent because you can approve changes in this workspace.',
    }),
    text: t.renderText([
      `Approval needed: ${summary}`,
      '',
      `Requested by: ${requesterName}`,
      `Kind: ${actionLabel}`,
      '',
      'Nothing has changed yet. It expires by itself after 48 hours.',
      link ? `Review it: ${link}` : null,
    ]),
  };
}

/** The answer, to whoever asked. */
function approvalDecided({ approverName, summary, decision, note }) {
  const approved = decision === 'approved';
  const link = approvalsLink();

  return {
    subject: approved ? `Approved: ${summary}` : `Turned down: ${summary}`,
    html: t.renderEmail({
      preheader: `${approverName} ${approved ? 'approved' : 'turned down'} your request.`,
      eyebrow: approved ? 'Approved' : 'Turned down',
      hero: 'badge-decided',
      title: approved ? 'Your change went through' : 'Your change was turned down',
      blocks: [
        t.paragraph(
          approved
            ? `${approverName} signed this off, and the change has been applied.`
            : `${approverName} turned this down, so nothing was changed.`,
        ),
        t.detailPanel({
          tone: approved ? 'success' : 'danger',
          title: 'What you asked for',
          fields: [{ label: 'Decided by', value: approverName }],
          note: summary,
        }),
        note ? t.callout({ tone: 'info', title: 'They added', body: note }) : '',
      ].filter(Boolean),
      cta: link ? { label: 'Open approvals', url: link } : null,
      reason: 'Sent because you raised this request.',
    }),
    text: t.renderText([
      approved ? `Approved: ${summary}` : `Turned down: ${summary}`,
      '',
      `Decided by: ${approverName}`,
      note ? `Note: ${note}` : null,
      '',
      link ? `Open approvals: ${link}` : null,
    ]),
  };
}

function domainsLink() {
  const base = baseUrl();
  return base ? `${base}/portal/domains` : null;
}

/**
 * "Your website address is about to lapse."
 *
 * The one email in this app with a deadline the client cannot renegotiate. It
 * leads with the date, says plainly what happens if nothing is done, and -- the
 * part that decides whether it works -- tells them whether it will renew by
 * itself, because that single fact is the difference between "act today" and
 * "no action needed".
 *
 * Once the date has passed the tone changes rather than escalating: most
 * registrars hold a lapsed name for a grace period, so the message is "this can
 * still be saved", not "too late".
 */
function domainExpiring({ domain, clientName, daysLeft, window }) {
  const link = domainsLink();
  const expired = daysLeft < 0;
  const urgent = daysLeft <= 3;
  const autoRenew = domain.autoRenew === true || domain.autoRenew === 'true';

  const subject = expired
    ? `${domain.domainName} expired ${window}`
    : daysLeft === 0
      ? `${domain.domainName} expires today`
      : `${domain.domainName} expires ${window}`;

  const opening = expired
    ? `Hi ${clientName || 'there'}. ${domain.domainName} passed its renewal date ${window}. Most registrars hold a name for a short grace period, so this can usually still be put right -- but not indefinitely.`
    : autoRenew
      ? `Hi ${clientName || 'there'}. ${domain.domainName} is due for renewal ${window}. It is set to renew automatically, so this is a heads-up rather than something to action.`
      : `Hi ${clientName || 'there'}. ${domain.domainName} is due for renewal ${window}, and it is not set to renew automatically.`;

  const consequence = expired
    ? 'While it is lapsed, anything on that address -- your website, and email sent to it -- will not work.'
    : 'If it lapses, your website and any email on that address stop working, and the name can be registered by somebody else.';

  return {
    subject,
    html: t.renderEmail({
      preheader: expired
        ? `${domain.domainName} has lapsed. It can usually still be recovered.`
        : `${domain.domainName} needs renewing ${window}.`,
      eyebrow: expired ? 'Needs attention' : urgent ? 'Renewal due' : 'Coming up',
      hero: 'badge-domain',
      title: subject,
      blocks: [
        t.paragraph(opening),
        t.detailPanel({
          tone: expired ? 'danger' : urgent ? 'warn' : 'info',
          title: 'The address',
          fields: [
            { label: 'Domain', value: domain.domainName },
            { label: expired ? 'Expired' : 'Renews', value: domain.expiresAt || 'Not recorded' },
            { label: 'Renews itself', value: autoRenew ? 'Yes' : 'No' },
            domain.registrar ? { label: 'Registered with', value: domain.registrar } : null,
          ].filter(Boolean),
          note: consequence,
        }),
        autoRenew && !expired
          ? t.paragraph('Nothing is needed from you. We will confirm once it has renewed.', { muted: true, size: 13 })
          : t.bulletList([
            'Reply to this email and we will renew it for you.',
            'Already renewed it yourself? Tell us and we will update our records.',
            'Not using this address any more? Say so and we will stop reminding you.',
          ]),
      ],
      cta: link ? { label: 'See your website addresses', url: link } : null,
      reason: 'Sent because we look after this address for you.',
    }),
    text: t.renderText([
      subject,
      '',
      opening,
      '',
      `Domain: ${domain.domainName}`,
      `${expired ? 'Expired' : 'Renews'}: ${domain.expiresAt || 'not recorded'}`,
      `Renews itself: ${autoRenew ? 'yes' : 'no'}`,
      domain.registrar ? `Registered with: ${domain.registrar}` : null,
      '',
      consequence,
      '',
      autoRenew && !expired ? 'Nothing is needed from you.' : 'Reply to this email and we will renew it for you.',
      link ? `Your website addresses: ${link}` : null,
    ]),
  };
}

/** Deliverability check an admin can fire at their own inbox. */
function testEmail({ requestedBy }) {
  const base = baseUrl();
  return {
    subject: `${t.brand().name} email test`,
    html: t.renderEmail({
      preheader: 'If you can read this, outbound email works.',
      eyebrow: 'Test message',
      hero: 'badge-send',
      title: 'Outbound email is working',
      actor: requestedBy ? { name: requestedBy, line: `${requestedBy} sent this test` } : null,
      blocks: [
        t.paragraph('This is what notifications from this dashboard look like.'),
        t.taskCard({
          status: 'In Progress',
          title: 'Sample ticket: homepage button not linking correctly',
          breadcrumb: 'Support tickets / Website',
          meta: [
            { label: 'Ticket', value: 'ticket-1042' },
            { label: 'Priority', value: 'High' },
            { label: 'Owner', value: 'Ryan Coleman' },
            { label: 'First response due', value: t.formatWhen(Date.now() + 4 * 3600 * 1000) },
          ],
          progress: 30,
        }),
        t.comment({
          author: 'Ryan Coleman',
          at: Date.now(),
          body: 'Reproduced on mobile Safari. Fixing the anchor target now, should be live within the hour.',
        }),
      ],
      cta: base ? { label: 'Open dashboard', url: base } : null,
      reason: 'You are receiving this because an administrator sent a test from the Mail page.',
    }),
    text: t.renderText([
      'Outbound email is working.',
      '',
      'This is a test message from the dashboard Mail page.',
      base ? `\nOpen dashboard: ${base}` : null,
    ]),
  };
}

/**
 * The five messages the credential and password-policy features send.
 *
 * The rule they all follow, and the reason this block exists at all: **none of
 * them ever carries a password.** The older credentialsIssued() above does,
 * because an admin handing over a login in person needs something to read out.
 * These do not: a scheduled delivery lands in an inbox hours after anyone
 * decided to send it, and a secret sitting unread in a mailbox is a secret with
 * no owner watching it. What travels instead is a single-use link that sets a
 * password the sender never learns.
 */

/**
 * A new account, told how to choose its own first password.
 *
 * The email address is stated plainly because it is the user id and not a
 * secret -- and because people genuinely forget which address a workspace
 * knows them by. The link is the only sensitive thing here, and it dies the
 * moment it is used.
 */
function accountActivation({ user, activationUrl, expiresAt, sections = null, invitedBy = null, kind = 'activation' }) {
  const url = t.safeUrl(activationUrl);
  const isReset = kind === 'reset';
  const brandName = t.brand().name;
  const roleWord = user.role === 'client' ? 'client portal' : 'team dashboard';

  return {
    subject: isReset
      ? `Set a new password for your ${brandName} account`
      : `Set up your ${brandName} ${roleWord} account`,
    html: t.renderEmail({
      preheader: isReset
        ? 'One link, one use, and you choose the password.'
        : `Choose a password and your ${roleWord} is ready.`,
      eyebrow: isReset ? 'Password setup' : 'Welcome',
      hero: 'badge-activate',
      title: isReset ? 'Choose a new password' : `Set up your ${roleWord}`,
      actor: invitedBy ? { name: invitedBy, line: `${invitedBy} set this up for you` } : null,
      blocks: [
        t.paragraph(
          isReset
            ? `Hi ${user.name}. Use the button below to choose a new password. Nobody here can see what you pick.`
            : `Hi ${user.name}. Your account is ready. The one thing left is a password, and you choose it yourself -- we never set one for you.`,
        ),
        t.panel({
          title: 'Your sign-in address',
          html: t.fact('Email', user.email),
        }),
        expiresAt
          ? t.callout({
            tone: 'warn',
            title: 'This link works once',
            body: `It stops working on ${t.formatWhen(expiresAt)}, or as soon as you have used it. Ask for another if you miss it.`,
          })
          : '',
        Array.isArray(sections) && sections.length > 0
          ? t.panel({ title: 'What you will find inside', html: t.bulletList(sections) })
          : '',
        t.paragraph(
          'If you were not expecting this, ignore it. The link is useless until somebody opens it, and it expires on its own.',
          { muted: true, size: 13 },
        ),
      ].filter(Boolean),
      cta: url ? { label: isReset ? 'Choose a new password' : 'Set my password', url } : null,
      reason: 'Sent because an administrator set up or reset this account.',
    }),
    text: t.renderText([
      isReset ? 'Choose a new password.' : 'Your account is ready -- choose a password.',
      '',
      `Email: ${user.email}`,
      url ? `Set your password: ${url}` : null,
      '',
      expiresAt ? `The link works once and expires on ${t.formatWhen(expiresAt)}.` : null,
      'We never send passwords by email. If you were not expecting this, ignore it.',
    ]),
  };
}

/** The nudge before a password ages out, while doing something about it is still optional. */
function passwordExpiring({ user, daysLeft, expiresAt, resetUrl = null }) {
  const url = t.safeUrl(resetUrl) || loginLink();
  const when = daysLeft <= 0
    ? 'today'
    : daysLeft === 1
      ? 'tomorrow'
      : `in ${daysLeft} days`;

  return {
    subject: `Your ${t.brand().name} password expires ${when}`,
    html: t.renderEmail({
      preheader: `Change it now and you will not be interrupted later.`,
      eyebrow: 'Security',
      hero: 'badge-clock',
      title: `Your password expires ${when}`,
      blocks: [
        t.paragraph(
          `Hi ${user.name}. Passwords here are replaced every month. Yours is due ${when}, and changing it now takes about thirty seconds.`,
        ),
        expiresAt ? t.fact('Expires', t.formatWhen(expiresAt)) : '',
        t.paragraph(
          'Leave it and nothing dramatic happens -- you will simply be asked to set a new one the next time you sign in.',
          { muted: true, size: 13 },
        ),
      ].filter(Boolean),
      cta: url ? { label: 'Change my password', url } : null,
      reason: 'Sent because this workspace replaces passwords monthly.',
    }),
    text: t.renderText([
      `Your ${t.brand().name} password expires ${when}.`,
      expiresAt ? `Expires ${t.formatWhen(expiresAt)}.` : null,
      '',
      url ? `Change it: ${url}` : null,
      'If you do nothing you will be asked to set a new one at your next sign-in.',
    ]),
  };
}

/**
 * The reset link itself.
 *
 * Sent both by the monthly sweep, when a password has actually aged out, and
 * by the forgot-password form. The wording covers both without the reader
 * having to know which, because from their side it is the same job.
 */
function passwordReset({ user, resetUrl, expiresAt, ipAddress = null, required = false }) {
  const url = t.safeUrl(resetUrl);
  const minutes = expiresAt ? Math.max(1, Math.round((Number(expiresAt) - Date.now()) / 60000)) : null;

  return {
    subject: required
      ? `Time to reset your ${t.brand().name} password`
      : `Reset your ${t.brand().name} password`,
    html: t.renderEmail({
      preheader: 'One link, good once, and it expires shortly.',
      eyebrow: 'Password reset',
      hero: 'badge-lock',
      title: required ? 'Your password needs replacing' : 'Reset your password',
      blocks: [
        t.paragraph(
          required
            ? `Hi ${user.name}. Your password has reached the end of its month. Set a new one and you are back in.`
            : `Hi ${user.name}. Somebody asked to reset the password on this account. If that was you, the button below is how.`,
        ),
        minutes
          ? t.callout({
            tone: 'warn',
            title: 'Works once',
            body: `This link expires in ${minutes} minutes and stops working the moment it is used.`,
          })
          : '',
        t.paragraph(
          ipAddress
            ? `Requested from ${ipAddress}. If that was not you, do not open the link -- nothing has changed yet, and telling an administrator is the right next step.`
            : 'If you did not ask for this, ignore it. Nothing changes until the link is opened.',
          { muted: true, size: 13 },
        ),
      ].filter(Boolean),
      cta: url ? { label: 'Set a new password', url } : null,
      reason: 'Sent because a password reset was requested for this account.',
    }),
    text: t.renderText([
      required ? 'Your password has expired and needs replacing.' : 'Reset your password.',
      '',
      url ? `Set a new password: ${url}` : null,
      minutes ? `The link works once and expires in ${minutes} minutes.` : null,
      '',
      ipAddress ? `Requested from ${ipAddress}.` : null,
      'If this was not you, do not open the link.',
    ]),
  };
}

/**
 * Confirmation that a password actually changed.
 *
 * The one email in this set that exists purely so a takeover cannot be silent.
 * It carries no link to click, on purpose: a "was this you?" message with a
 * button in it teaches people to click buttons in messages about their
 * password, which is the exact habit the attacker needs.
 */
function passwordChanged({ user, at = Date.now(), ipAddress = null, via = 'self' }) {
  const how = {
    self: 'from your profile page',
    reset: 'using a password reset link',
    admin: 'by an administrator',
  }[via] || 'on your account';

  return {
    subject: `Your ${t.brand().name} password was changed`,
    html: t.renderEmail({
      preheader: 'If this was you, there is nothing to do.',
      eyebrow: 'Security',
      hero: 'badge-lock-done',
      title: 'Your password was changed',
      blocks: [
        t.paragraph(`Hi ${user.name}. The password on your account was changed ${how}.`),
        t.panel({
          title: 'What happened',
          html: [
            t.fact('When', t.formatWhen(at)),
            ipAddress ? t.fact('From', ipAddress) : '',
            t.fact('Other sessions', 'Signed out everywhere else'),
          ].filter(Boolean).join(''),
        }),
        t.paragraph(
          'If this was not you, tell an administrator now. Do not use any link in this message to do it -- go to the dashboard the way you normally would.',
          { muted: true, size: 13 },
        ),
      ],
      cta: null,
      reason: 'Sent because the password on this account changed.',
    }),
    text: t.renderText([
      `Your ${t.brand().name} password was changed ${how}.`,
      `When: ${t.formatWhen(at)}`,
      ipAddress ? `From: ${ipAddress}` : null,
      'Every other session was signed out.',
      '',
      'If this was not you, tell an administrator -- reach the dashboard the way you normally would, not through this email.',
    ]),
  };
}

/**
 * A scheduled hand-over that did not go out, addressed to the administrators.
 *
 * Worth its own message because the failure is invisible from every other
 * angle: the person who was supposed to receive a login simply never hears
 * anything, and nobody finds out until they ask why they cannot sign in.
 */
function credentialDeliveryFailed({ user, error, scheduledAt = null, attempts = 1 }) {
  const base = baseUrl();

  return {
    subject: `Could not deliver ${user.name}'s login`,
    html: t.renderEmail({
      preheader: 'A scheduled credential delivery failed and is waiting to be retried.',
      eyebrow: 'Delivery failed',
      hero: 'badge-alert',
      title: 'A login could not be delivered',
      blocks: [
        t.paragraph(
          `The scheduled activation email for ${user.name} did not go out. They have not been told anything, and their account is untouched.`,
        ),
        t.panel({
          title: 'Details',
          html: [
            t.fact('Account', `${user.name} (${user.email})`),
            scheduledAt ? t.fact('Was due', t.formatWhen(scheduledAt)) : '',
            t.fact('Attempts', String(attempts)),
            t.fact('Reason', String(error || 'Unknown error')),
          ].filter(Boolean).join(''),
        }),
        t.paragraph(
          'Fix the cause and retry it from Client Access. Nothing is sent automatically until you do.',
          { muted: true, size: 13 },
        ),
      ],
      cta: base ? { label: 'Open Client Access', url: `${base}/portal/client-access` } : null,
      reason: 'Sent to administrators because a scheduled credential delivery failed.',
    }),
    text: t.renderText([
      `The scheduled login email for ${user.name} (${user.email}) failed.`,
      scheduledAt ? `Was due: ${t.formatWhen(scheduledAt)}` : null,
      `Attempts: ${attempts}`,
      `Reason: ${error || 'Unknown error'}`,
      '',
      base ? `Retry it: ${base}/portal/client-access` : null,
    ]),
  };
}

// --- preview registry ------------------------------------------------------
// The admin Mail page renders these without touching the database.

const SAMPLE_TICKET = {
  id: 'ticket-1042',
  subject: 'Homepage CTA button not linking correctly',
  category: 'Website',
  status: 'In Progress',
  priority: 'High',
  progress: 30,
  stage: 'in_progress',
  description: 'The "Book Now" button on mobile leads to a 404 page. Customers cannot book at all from phones.',
  createdAt: new Date().toISOString(),
  responseDueAt: Date.now() + 4 * 60 * 60 * 1000,
};

const SAMPLE_USER = {
  id: 'u-sample',
  name: 'David Shaw',
  email: 'david.shaw@brightpath-retail.com',
  role: 'client',
};

const SAMPLE_PAYMENT = {
  amount: 249,
  currency: 'usd',
  status: 'paid',
  description: 'Website care plan - monthly',
  paidAt: new Date().toISOString(),
  periodStart: new Date(Date.now() - 30 * 86400000).toISOString(),
  periodEnd: new Date(Date.now() + 86400000).toISOString(),
  invoiceNumber: 'EW-1042',
  cardBrand: 'visa',
  cardLast4: '4242',
  invoiceUrl: 'https://invoice.stripe.com/i/example',
};

const TEMPLATES = {
  new_ticket_staff: {
    audience: 'team',
    group: 'Tickets',
    label: 'New ticket (team)',
    description: 'Sent to every admin and the assigned owner when a ticket is raised.',
    render: () => newTicketForStaff({
      ticket: SAMPLE_TICKET,
      clientName: 'David Shaw',
      assigneeName: 'Ryan Coleman',
      clickupUrl: 'https://app.clickup.com/t/abc123',
    }),
  },
  ticket_receipt_client: {
    audience: 'client',
    group: 'Tickets',
    label: 'Ticket receipt (client)',
    description: "The client's confirmation that their request landed and has an owner.",
    render: () => ticketReceiptForClient({ ticket: SAMPLE_TICKET, clientName: 'David Shaw', assigneeName: 'Ryan Coleman' }),
  },
  ticket_assigned: {
    audience: 'team',
    group: 'Tickets',
    label: 'Ticket assigned',
    description: 'Sent to a team member when a ticket becomes theirs.',
    render: () => ticketAssigned({
      ticket: SAMPLE_TICKET, assigneeName: 'Ryan Coleman', clientName: 'David Shaw', actorName: 'Admin User',
    }),
  },
  ticket_status: {
    audience: 'client',
    group: 'Tickets',
    label: 'Status changed',
    description: 'Sent to the client when a ticket moves status.',
    render: () => ticketStatusChanged({
      ticket: SAMPLE_TICKET, fromStatus: 'Open', toStatus: 'Resolved', clientName: 'David Shaw', assigneeName: 'Ryan Coleman',
    }),
  },
  ticket_comment: {
    audience: 'both',
    group: 'Tickets',
    label: 'New comment',
    description: 'Sent when a note is posted on a ticket.',
    render: () => ticketComment({
      ticket: SAMPLE_TICKET,
      authorName: 'Ryan Coleman',
      body: 'Reproduced on mobile Safari. Fixing the anchor target now, should be live within the hour.',
      progress: 60,
      stage: 'review',
    }),
  },
  ticket_request: {
    audience: 'team',
    group: 'Tickets',
    label: 'Handover request',
    description: 'Sent when a teammate is asked to take over or help.',
    render: () => ticketRequest({
      ticket: SAMPLE_TICKET, kind: 'handover', fromName: 'Ryan Coleman', toName: 'Jordan Brooks',
      note: 'I am on leave from Friday. Can you carry this to done?',
    }),
  },
  sla_warning: {
    audience: 'team',
    group: 'Tickets',
    label: 'Response due',
    description: 'Sent to the owner and admins as the first-response clock runs out.',
    render: () => slaWarning({
      ticket: SAMPLE_TICKET, assigneeName: 'Ryan Coleman', clientName: 'David Shaw', minutesLeft: 30,
    }),
  },
  login_code: {
    audience: 'both',
    group: 'Accounts & access',
    label: 'Sign-in code',
    description: 'The one-time code sent to anyone signing in without an admin role.',
    render: () => loginCode({
      user: { name: 'David Shaw', email: 'client@brightpath-retail.com' },
      code: '481902',
      expiresAt: Date.now() + 5 * 60 * 1000,
      ipAddress: '203.0.113.24',
    }),
  },
  credentials: {
    audience: 'both',
    group: 'Accounts & access',
    label: 'Login issued',
    description: 'Sent to a person when an admin creates their account or resets the password.',
    render: () => credentialsIssued({
      user: { name: 'David Shaw', email: 'client@brightpath-retail.com', role: 'client' },
      temporaryPassword: 'Kp7nQx2mVt9d',
      expiresAt: Date.now() + 30 * 86400000,
      sections: ['Projects', 'Tickets', 'Work progress', 'Billing'],
      invitedBy: 'Admin User',
      // A stand-in token: the preview has to show the link option, which only
      // exists on a real send for a client account.
      signInUrl: `${baseUrl() || 'https://dashboard.example.com'}/api/auth/magic-link/verify?token=example-token`,
    }),
  },
  admin_roster: {
    audience: 'team',
    group: 'Accounts & access',
    label: 'Admin roster change',
    description: 'Sent to every administrator when the admin list changes.',
    render: () => adminRosterChanged({
      actorName: 'Admin User', targetName: 'Priya Nair', targetEmail: 'priya@ethixweb.local', change: 'added', adminCount: 3,
    }),
  },
  progress_digest: {
    audience: 'client',
    group: 'Reports & summaries',
    label: 'Progress summary',
    description: 'Periodic client-facing summary of tickets and projects.',
    render: () => progressDigest({
      clientName: 'David Shaw',
      tickets: [SAMPLE_TICKET, { ...SAMPLE_TICKET, id: 'ticket-1039', subject: 'Add fall promo landing page', status: 'Resolved', progress: 100, stage: 'done' }],
      projects: [{ name: 'BrightPath Website Redesign', status: 'In Progress' }],
    }),
  },
  welcome_with_plans: {
    audience: 'client',
    group: 'Welcome & onboarding',
    label: 'Welcome and plan options',
    description: 'Sent once when a client account is created, or on the first sign-in of a client who predates plans.',
    render: () => welcomeWithPlans({ firstName: 'David', existingFreeClient: true }),
  },
  renewal_reminder: {
    audience: 'client',
    group: 'Billing',
    label: 'Renewal reminder',
    description: 'Sent seven days before a 3, 6 or 12 month plan renews.',
    render: () => renewalReminder({
      clientName: 'David Shaw',
      planName: 'Unlimited',
      periodLabel: '12 months',
      amountUsd: 278.40,
      renewsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    }),
  },
  plan_confirmed: {
    audience: 'client',
    group: 'Billing',
    label: 'Plan confirmed',
    description: 'Sent once when a payment is confirmed and the plan starts.',
    render: () => planConfirmed({
      clientName: 'David Shaw',
      planName: 'Unlimited',
      periodLabel: '12 months',
      amountUsd: 278.40,
      renewsAt: new Date(Date.now() + 365 * 86400000).toISOString(),
      creditUsd: 0,
      fromPlanName: null,
      perks: require('../lib/plans').entitlementsFor('unlimited').map((e) => e.short),
    }),
  },
  payment_received: {
    audience: 'client',
    group: 'Billing',
    label: 'Payment received',
    description: 'The receipt a client gets the first time Stripe reports an invoice paid.',
    render: () => paymentReceived({ clientName: 'David Shaw', payment: SAMPLE_PAYMENT }),
  },
  payment_failed: {
    audience: 'client',
    group: 'Billing',
    label: 'Payment failed',
    description: 'Sent when Stripe reports a declined card, with the one action that fixes it.',
    render: () => paymentFailed({
      clientName: 'David Shaw',
      payment: {
        ...SAMPLE_PAYMENT,
        status: 'failed',
        failureMessage: 'Your card was declined by the issuing bank.',
      },
    }),
  },
  payment_summary: {
    audience: 'client',
    group: 'Billing',
    label: 'Payment summary',
    description: 'Periodic client-facing summary of what they paid, read from Stripe.',
    render: () => paymentSummary({
      clientName: 'David Shaw',
      total: 498,
      currency: 'usd',
      payments: [
        SAMPLE_PAYMENT,
        {
          ...SAMPLE_PAYMENT,
          invoiceNumber: 'EW-1041',
          paidAt: new Date(Date.now() - 30 * 86400000).toISOString(),
        },
      ],
    }),
  },
  approval_requested: {
    audience: 'team',
    group: 'Internal approvals',
    label: 'Approval needed',
    description: 'Sent to every approver when an untrusted admin proposes a sensitive change.',
    render: () => approvalRequested({
      requesterName: 'Priya Nair',
      summary: 'Delete the account for Jordan Brooks',
      actionLabel: 'Delete an account',
      requestedAt: new Date().toISOString(),
    }),
  },
  approval_decided: {
    audience: 'team',
    group: 'Internal approvals',
    label: 'Approval decided',
    description: 'The answer, sent to whoever raised the request.',
    render: () => approvalDecided({
      approverName: 'Admin User',
      summary: 'Delete the account for Jordan Brooks',
      decision: 'approved',
      note: 'Confirmed with the team first.',
    }),
  },
  domain_expiring: {
    audience: 'client',
    group: 'Domains',
    label: 'Domain expiring',
    description: 'Automatic renewal reminders, from a month out to a week after the date.',
    render: () => domainExpiring({
      domain: {
        domainName: 'brightpath-retail.com',
        expiresAt: 'Sep 14, 2026',
        registrar: 'Registered with Ethixweb',
        autoRenew: false,
        sslStatus: 'Valid',
      },
      clientName: 'David Shaw',
      daysLeft: 7,
      window: 'in 7 days',
    }),
  },
  account_activation: {
    audience: 'both',
    group: 'Accounts & access',
    label: 'Account activation',
    description: 'A scheduled hand-over: the link that lets a new account choose its own password.',
    render: () => accountActivation({
      user: SAMPLE_USER,
      activationUrl: 'https://dashboard.example.com/set-password#token=sample',
      expiresAt: Date.now() + 72 * 60 * 60 * 1000,
      sections: ['Work progress', 'Tickets', 'Billing'],
      invitedBy: 'Admin User',
    }),
  },
  password_expiring: {
    audience: 'both',
    group: 'Accounts & access',
    label: 'Password expiring',
    description: 'The heads-up a few days before a password reaches the end of its month.',
    render: () => passwordExpiring({
      user: SAMPLE_USER,
      daysLeft: 3,
      expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
      resetUrl: 'https://dashboard.example.com/set-password#token=sample',
    }),
  },
  password_reset: {
    audience: 'both',
    group: 'Accounts & access',
    label: 'Password reset',
    description: 'The single-use link that sets a new password. Never carries a password itself.',
    render: () => passwordReset({
      user: SAMPLE_USER,
      resetUrl: 'https://dashboard.example.com/set-password#token=sample',
      expiresAt: Date.now() + 60 * 60 * 1000,
      ipAddress: '203.0.113.9',
    }),
  },
  password_changed: {
    audience: 'both',
    group: 'Accounts & access',
    label: 'Password changed',
    description: 'Confirmation that a password moved, so a takeover cannot happen quietly.',
    render: () => passwordChanged({
      user: SAMPLE_USER,
      at: Date.now(),
      ipAddress: '203.0.113.9',
      via: 'reset',
    }),
  },
  credential_delivery_failed: {
    audience: 'team',
    group: 'Accounts & access',
    label: 'Credential delivery failed',
    description: 'Sent to administrators when a scheduled login email could not be delivered.',
    render: () => credentialDeliveryFailed({
      user: SAMPLE_USER,
      error: 'The mail server rejected our username or password.',
      scheduledAt: Date.now() - 30 * 60 * 1000,
      attempts: 2,
    }),
  },
  // Welcome, the twenty-two service launches, the four engagement steps and the
  // four recurring summaries. Spread rather than re-declared so that adding one
  // means touching serviceEmails.js and nothing else.
  ...service.SERVICE_TEMPLATES,

  test: {
    audience: 'team',
    group: 'Diagnostics',
    label: 'Test message',
    description: 'Deliverability check sent from the Mail page.',
    render: () => testEmail({ requestedBy: 'Admin User' }),
  },
};

/** One template rendered for a real send -- no preview-only brand overrides. */
function renderMessage(key) {
  const entry = TEMPLATES[key];
  return entry ? entry.render() : null;
}

/**
 * The order the groups are shown in on the Mail page.
 *
 * Client-facing first and internal last, because that is the order an admin
 * cares about them: the messages a paying customer reads are the ones worth
 * proof-reading, and the ones this app sends itself are the ones you only look
 * at when something is wrong.
 *
 * A group named here that holds nothing is simply not drawn. A group a template
 * names that is NOT here is appended at the end rather than dropped -- see
 * `listGroups` -- because a template vanishing from this page is exactly the
 * failure this list is replacing.
 */
const GROUP_ORDER = [
  'Welcome & onboarding',
  'Service launches - Website',
  'Service launches - AI',
  'Service launches - Growth',
  'Service launches - Data',
  'Service launches - Accessibility',
  'Service launches - Support',
  'Engagement steps',
  'Monthly updates',
  'Tickets',
  'Billing',
  'Domains',
  'Reports & summaries',
  'Accounts & access',
  'Internal approvals',
  'Diagnostics',
];

/** Where a template with no group of its own ends up. */
const UNGROUPED = 'Other';

/** Who reads it: the paying client, our own team, or both depending on context. */
const AUDIENCES = ['client', 'team', 'both'];

function listTemplates() {
  return Object.entries(TEMPLATES).map(([key, v]) => ({
    key,
    label: v.label,
    description: v.description,
    // Defaulted rather than required. A template added without these still
    // appears on the page, in Other, which is visible enough to get fixed --
    // the alternative, silently not being drawn, is what went wrong before.
    audience: AUDIENCES.includes(v.audience) ? v.audience : 'team',
    group: v.group || UNGROUPED,
  }));
}

/**
 * The groups, in display order, each with its templates.
 *
 * Built from the templates themselves rather than from a list the page keeps
 * of its own. That is the whole point of this function: the Mail page used to
 * hold its own hard-coded set of groups and keys, and every template added
 * since simply stopped appearing -- forty-one of fifty-four of them, in the
 * end, including every payment, approval, domain and password message. The
 * page now draws what the server says exists, so a template cannot be added
 * without showing up somewhere.
 */
function listGroups() {
  const templates = listTemplates();
  const byGroup = new Map();
  for (const template of templates) {
    if (!byGroup.has(template.group)) byGroup.set(template.group, []);
    byGroup.get(template.group).push(template);
  }

  const ordered = GROUP_ORDER.filter((heading) => byGroup.has(heading));
  const extras = [...byGroup.keys()].filter((heading) => !GROUP_ORDER.includes(heading)).sort();

  return [...ordered, ...extras].map((heading) => ({
    heading,
    templates: byGroup.get(heading),
    // What the group as a whole is for, so the page can filter on it without
    // opening every template in it.
    audiences: [...new Set(byGroup.get(heading).map((t) => t.audience))],
  }));
}

/**
 * Render a template for the Mail page.
 *
 * The logo is pinned to a same-origin path here: a preview is looked at in a
 * browser that is already talking to this server, so it always resolves, even
 * on a laptop with no public URL. Real sends keep the absolute URL, or the
 * inline attachment when there is no public address to link to.
 */
function renderPreview(key) {
  const entry = TEMPLATES[key];
  if (!entry) return null;
  const rendered = t.withBrandOverride(
    // A same-origin path: a `cid:` reference only resolves inside a mail client.
    { logoUrl: '/ethixweb.png' },
    () => entry.render(),
  );
  return { key, label: entry.label, ...rendered };
}

module.exports = {
  roleLabel,
  newTicketForStaff,
  ticketReceiptForClient,
  ticketAssigned,
  ticketStatusChanged,
  ticketComment,
  ticketRequest,
  slaWarning,
  loginCode,
  credentialsIssued,
  accountActivation,
  passwordExpiring,
  passwordReset,
  passwordChanged,
  credentialDeliveryFailed,
  adminRosterChanged,
  progressDigest,
  welcomeWithPlans,
  planConfirmed,
  renewalReminder,
  paymentReceived,
  paymentFailed,
  paymentSummary,
  approvalRequested,
  approvalDecided,
  domainExpiring,
  testEmail,

  // Service announcements, re-exported so callers have one place to require
  // from. `service` keeps them grouped for anything that wants the whole set.
  service,
  servicesWelcome: service.servicesWelcome,
  websiteRedesignLive: service.websiteRedesignLive,
  headlessLive: service.headlessLive,
  landingPageLive: service.landingPageLive,
  maintenanceLive: service.maintenanceLive,
  knowledgeChatbotLive: service.knowledgeChatbotLive,
  llmChatbotLive: service.llmChatbotLive,
  csrAutomationLive: service.csrAutomationLive,
  humanHandoffLive: service.humanHandoffLive,
  seoLive: service.seoLive,
  googleAdsLive: service.googleAdsLive,
  metaAdsLive: service.metaAdsLive,
  socialReelsLive: service.socialReelsLive,
  emailMarketingLive: service.emailMarketingLive,
  crmIntegrationLive: service.crmIntegrationLive,
  dashboardLive: service.dashboardLive,
  analyticsLive: service.analyticsLive,
  monthlyReportingLive: service.monthlyReportingLive,
  accessibilityFixesLive: service.accessibilityFixesLive,
  accessibilityAuditLive: service.accessibilityAuditLive,
  techSupportLive: service.techSupportLive,
  aiContextUpdateLive: service.aiContextUpdateLive,
  apiMaintenanceLive: service.apiMaintenanceLive,
  auditReady: service.auditReady,
  planReady: service.planReady,
  buildStarted: service.buildStarted,
  optimizeDigest: service.optimizeDigest,
  adsPerformanceUpdate: service.adsPerformanceUpdate,
  seoRankingUpdate: service.seoRankingUpdate,
  chatbotPerformanceUpdate: service.chatbotPerformanceUpdate,
  accessibilityScoreUpdate: service.accessibilityScoreUpdate,

  listTemplates,
  listGroups,
  GROUP_ORDER,
  renderMessage,
  renderPreview,
  stageLabel,
};
