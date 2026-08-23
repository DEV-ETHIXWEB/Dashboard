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
      hero: done ? 'check-badge' : null,
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
      note: 'I am on leave from Friday. Can you carry this to done?',
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
  payment_received: {
    label: 'Payment received',
    description: 'The receipt a client gets the first time Stripe reports an invoice paid.',
    render: () => paymentReceived({ clientName: 'David Shaw', payment: SAMPLE_PAYMENT }),
  },
  payment_failed: {
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
    label: 'Domain expiring',
    description: 'Automatic renewal reminders, from a month out to a week after the date.',
    render: () => domainExpiring({
      domain: {
        domainName: 'brightpath-retail.com',
        expiresAt: 'Sep 14, 2026',
        registrar: 'Registered with EthixWeb',
        autoRenew: false,
        sslStatus: 'Valid',
      },
      clientName: 'David Shaw',
      daysLeft: 7,
      window: 'in 7 days',
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
  adminRosterChanged,
  progressDigest,
  paymentReceived,
  paymentFailed,
  paymentSummary,
  approvalRequested,
  approvalDecided,
  domainExpiring,
  testEmail,
  listTemplates,
  renderMessage,
  renderPreview,
  stageLabel,
};
