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
      `${clientName || 'A client'} raised a new ${String(ticket.priority || 'Normal').toLowerCase()} priority ticket. The first response clock is already running.`,
    ),
    t.taskCard({
      status: ticket.status || 'Open',
      title: ticket.subject,
      breadcrumb: `Support tickets / ${ticket.category || 'General'}`,
      meta,
      url: link,
    }),
    ticket.description ? t.comment({ author: clientName || 'Client', at: ticket.createdAt, body: ticket.description }) : '',
    clickupUrl ? t.callout({ tone: 'info', title: 'Mirrored to ClickUp', body: clickupUrl }) : '',
  ].filter(Boolean);

  return {
    subject: `[${ticket.priority || 'Normal'}] New ticket ${ticket.id}: ${ticket.subject}`,
    html: t.renderEmail({
      preheader: `${clientName || 'A client'} raised "${ticket.subject}"`,
      eyebrow: 'New ticket',
      title: `${clientName || 'A client'} raised a new ticket`,
      actor: { name: clientName || 'Client', line: `${clientName || 'A client'} opened ${ticket.id}` },
      blocks,
      cta: link ? { label: 'Open ticket', url: link } : null,
      secondaryCta: clickupUrl ? { label: 'View in ClickUp', url: clickupUrl } : null,
      reason: 'You are receiving this because you are on the support rota for this workspace.',
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
      title: 'Your request is in, and someone owns it',
      blocks: [
        t.paragraph(
          `Thanks ${clientName || 'there'} -- your request is logged as ${ticket.id}. You can follow every step from your portal, including the live task board and the team's working notes.`,
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
          'Progress updates appear in your portal as the team moves the work forward.',
          'Reply on the ticket any time -- the team sees it straight away.',
        ]),
      ],
      cta: link ? { label: 'Track this ticket', url: link } : null,
      secondaryCta: progressLink() ? { label: 'See all work progress', url: progressLink() } : null,
      reason: 'You are receiving this because you raised a support request in your client portal.',
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
function ticketAssigned({ ticket, assigneeName, clientName, actorName }) {
  const meta = ticketMeta(ticket, { clientName, assigneeName });
  const link = ticketLink(ticket.id);

  return {
    subject: `Assigned to you: ${ticket.subject} (${ticket.id})`,
    html: t.renderEmail({
      preheader: `${actorName || 'A manager'} assigned you ${ticket.id}`,
      eyebrow: 'Assignment',
      title: `${actorName || 'A manager'} assigned you a ticket`,
      actor: { name: actorName || 'Dashboard', line: `${actorName || 'A manager'} assigned this to you` },
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
      reason: 'You are receiving this because you were assigned this ticket.',
    }),
    text: t.renderText([
      `${actorName || 'A manager'} assigned you ticket ${ticket.id}: ${ticket.subject}`,
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
      title: done ? 'Your request is resolved' : `Your request moved to ${toStatus}`,
      blocks: [
        t.paragraph(
          done
            ? `Hi ${clientName || 'there'} -- the team finished the work on ${ticket.id}. If anything still looks wrong, reply on the ticket and it reopens with all its history intact.`
            : `Hi ${clientName || 'there'} -- ${ticket.id} moved from ${fromStatus || 'Open'} to ${toStatus}.`,
        ),
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
      reason: 'You are receiving this because you raised this support request.',
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
        ? 'You are receiving this because you raised this support request.'
        : 'You are receiving this because you are working on this ticket.',
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
      reason: 'You are receiving this because a teammate sent you a request on a ticket.',
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
      preheader: overdue ? `${ticket.id} has blown its first-response window` : `${minutesLeft} minutes left on ${ticket.id}`,
      eyebrow: overdue ? 'Overdue' : 'Due soon',
      title: overdue ? 'This ticket has no first response yet' : 'A first response is due shortly',
      blocks: [
        t.callout({
          tone: overdue ? 'danger' : 'warn',
          title: overdue ? 'Past due' : 'Closing window',
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
      reason: 'You are receiving this because you own this ticket or administer this workspace.',
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
      preheader: isReset ? 'A new password for your account' : 'Your sign-in details are ready',
      eyebrow: isReset ? 'Password reset' : 'Welcome',
      title: isReset ? 'Your password has been reset' : `You have access to the ${roleWord}`,
      actor: invitedBy ? { name: invitedBy, line: `${invitedBy} set this up for you` } : null,
      blocks: [
        t.paragraph(
          isReset
            ? `Hi ${user.name} -- an administrator issued you a new password. Your previous one no longer works, and any other session has been signed out.`
            : `Hi ${user.name} -- your account is ready. Sign in with the details below, then change the password from Settings.`,
        ),
        // Email and password sit side by side, and the access window next to
        // the section list, so the message reads across the card instead of
        // running down it. Both pairs stack again on a phone.
        t.detailPanel({
          tone: 'info',
          title: 'Sign-in details',
          mono: true,
          fields: [
            { label: 'Email', value: user.email },
            { label: 'Password', value: temporaryPassword },
          ],
        }),
        // The link sits directly under the ID and password, as the other way to
        // do the same thing, rather than at the bottom of the message where a
        // reader who already started typing would never look.
        oneTap ? t.orDivider('or') : '',
        oneTap ? t.button({ label: 'Sign in with link', url: oneTap }) : '',
        oneTap
          ? t.paragraph('That link signs you in on its own -- no password, no code. It works once, within 24 hours.', { muted: true, size: 13 })
          : '',
        t.columns([
          expiresAt
            ? t.callout({ tone: 'warn', title: 'Access window', body: `This login stops working on ${t.formatWhen(expiresAt)}.` })
            : null,
          sections && sections.length > 0
            ? [t.paragraph('Your account can open:', { muted: true, size: 13 }), t.bulletList(sections)].join('\n')
            : null,
        ]),
        t.paragraph('Treat this email as a password. Delete it once you have signed in and set your own.', { muted: true, size: 13 }),
      ].filter(Boolean),
      cta: link ? { label: 'Sign in with password', url: link } : null,
      reason: 'You are receiving this because an administrator created or reset this account.',
    }),
    text: t.renderText([
      isReset ? 'Your password has been reset.' : 'Your account is ready.',
      '',
      `Email: ${user.email}`,
      `Password: ${temporaryPassword}`,
      expiresAt ? `Access expires: ${t.formatWhen(expiresAt)}` : null,
      '',
      oneTap ? 'Or sign in with this link -- no password needed, works once, within 24 hours:' : null,
      oneTap || null,
      oneTap ? '' : null,
      link ? `Sign in with your password: ${link}` : null,
      '',
      'Change this password from Settings once you are in.',
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
      title: 'Finish signing in',
      blocks: [
        t.paragraph(`Hi ${user.name} -- enter this code to finish signing in. It expires in ${minutes} minutes.`),
        t.callout({ tone: 'info', title: 'Your code', mono: true, body: code }),
        t.paragraph(
          ipAddress
            ? `Requested from ${ipAddress}. If that was not you, do not enter the code -- change your password and tell an administrator.`
            : 'If you did not try to sign in, ignore this email and tell an administrator.',
          { muted: true, size: 13 },
        ),
      ],
      reason: 'You are receiving this because someone asked to sign in to your account.',
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
      title: `Where your work stands ${period}`,
      blocks: [
        t.paragraph(`Hi ${clientName || 'there'} -- a short read on everything we are running for you.`),
        t.callout({
          tone: 'info',
          title: 'At a glance',
          body: `${open.length} request${open.length === 1 ? '' : 's'} in flight\n${closed.length} finished ${period}\n${projects.length} active project${projects.length === 1 ? '' : 's'}`,
        }),
        ...cards,
        open.length > 5 ? t.paragraph(`...and ${open.length - 5} more in your portal.`, { muted: true, size: 13 }) : '',
        t.divider(),
        projects.length > 0
          ? [t.paragraph('Active projects', { muted: true, size: 13 }), t.bulletList(projects.map((p) => `${p.name} -- ${p.status}`))].join('\n')
          : '',
      ].filter(Boolean),
      cta: link ? { label: 'Open the progress board', url: link } : null,
      reason: 'You are receiving this because you have an active client portal account.',
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

/** Deliverability check an admin can fire at their own inbox. */
function testEmail({ requestedBy }) {
  const base = baseUrl();
  return {
    subject: `${t.brand().name} email test`,
    html: t.renderEmail({
      preheader: 'If you can read this, outbound email works.',
      eyebrow: 'Test message',
      title: 'Outbound email is working',
      actor: requestedBy ? { name: requestedBy, line: `${requestedBy} sent this test` } : null,
      blocks: [
        t.paragraph('This is what every notification from this dashboard will look like: one card, one clear action, nothing else.'),
        t.taskCard({
          status: 'In Progress',
          title: 'Sample ticket -- homepage CTA not linking correctly',
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

const TEMPLATES = {
  new_ticket_staff: {
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
    label: 'Ticket receipt (client)',
    description: "The client's confirmation that their request landed and has an owner.",
    render: () => ticketReceiptForClient({ ticket: SAMPLE_TICKET, clientName: 'David Shaw', assigneeName: 'Ryan Coleman' }),
  },
  ticket_assigned: {
    label: 'Ticket assigned',
    description: 'Sent to a team member when a ticket becomes theirs.',
    render: () => ticketAssigned({
      ticket: SAMPLE_TICKET, assigneeName: 'Ryan Coleman', clientName: 'David Shaw', actorName: 'Admin User',
    }),
  },
  ticket_status: {
    label: 'Status changed',
    description: 'Sent to the client when a ticket moves status.',
    render: () => ticketStatusChanged({
      ticket: SAMPLE_TICKET, fromStatus: 'Open', toStatus: 'Resolved', clientName: 'David Shaw', assigneeName: 'Ryan Coleman',
    }),
  },
  ticket_comment: {
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
    label: 'Handover request',
    description: 'Sent when a teammate is asked to take over or help.',
    render: () => ticketRequest({
      ticket: SAMPLE_TICKET, kind: 'handover', fromName: 'Ryan Coleman', toName: 'Jordan Brooks',
      note: 'I am on leave from Friday -- can you carry this to done?',
    }),
  },
  sla_warning: {
    label: 'Response due',
    description: 'Sent to the owner and admins as the first-response clock runs out.',
    render: () => slaWarning({
      ticket: SAMPLE_TICKET, assigneeName: 'Ryan Coleman', clientName: 'David Shaw', minutesLeft: 30,
    }),
  },
  login_code: {
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
    label: 'Admin roster change',
    description: 'Sent to every administrator when the admin list changes.',
    render: () => adminRosterChanged({
      actorName: 'Admin User', targetName: 'Priya Nair', targetEmail: 'priya@ethixweb.local', change: 'added', adminCount: 3,
    }),
  },
  progress_digest: {
    label: 'Progress summary',
    description: 'Periodic client-facing summary of tickets and projects.',
    render: () => progressDigest({
      clientName: 'David Shaw',
      tickets: [SAMPLE_TICKET, { ...SAMPLE_TICKET, id: 'ticket-1039', subject: 'Add fall promo landing page', status: 'Resolved', progress: 100, stage: 'done' }],
      projects: [{ name: 'BrightPath Website Redesign', status: 'In Progress' }],
    }),
  },
  test: {
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

function listTemplates() {
  return Object.entries(TEMPLATES).map(([key, v]) => ({ key, label: v.label, description: v.description }));
}

/**
 * Render a template for the Mail page.
 *
 * The emblem is pinned to a same-origin path here: a preview is looked at in a
 * browser that is already talking to this server, so it always resolves, even
 * on a laptop with no public URL. Real sends keep the absolute URL.
 */
function renderPreview(key) {
  const entry = TEMPLATES[key];
  if (!entry) return null;
  const rendered = t.withBrandOverride({ logoUrl: '/emblem-mark.png' }, () => entry.render());
  return { key, label: entry.label, ...rendered };
}

module.exports = {
  newTicketForStaff,
  ticketReceiptForClient,
  ticketAssigned,
  ticketStatusChanged,
  ticketComment,
  ticketRequest,
  slaWarning,
  loginCode,
  credentialsIssued,
  adminRosterChanged,
  progressDigest,
  testEmail,
  listTemplates,
  renderMessage,
  renderPreview,
  stageLabel,
};
