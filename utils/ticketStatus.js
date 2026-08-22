'use strict';

/**
 * Moving a ticket's status, and everything that has to happen with it.
 *
 * This lives in its own module because a status change now has two ways in: an
 * admin who may act alone does it through the route, and an admin who does not
 * has it done for them when somebody signs the request off. Both paths have to
 * do the *same* things -- above all, tell the client.
 *
 * The failure this prevents is a quiet one: a ticket closed through the
 * approval queue while the client never hears about it, because the email lived
 * in the route the approval path skipped.
 */

const { db } = require('../db/setup');
const clickup = require('./clickup');
const intake = require('./ticketIntake');
const mailer = require('./mailer');
const messages = require('./emailMessages');
const live = require('./liveBus');

/** The statuses that mean "we are finished here", and need the client told. */
const CLOSING_STATUSES = ['Resolved', 'Closed'];

function isClosing(status) {
  return CLOSING_STATUSES.includes(status);
}

/** Mirror the new state onto the ClickUp task, when there is one. */
async function syncToClickUp(ticket, status) {
  if (!ticket.clickupTaskId || !clickup.isEnabled()) return;
  try {
    await clickup.updateTask(ticket.clickupTaskId, {
      status: isClosing(status) ? 'complete' : 'to do',
    });
  } catch (err) {
    console.error(`Could not sync ticket ${ticket.id} status to ClickUp:`, err.message);
  }
}

/**
 * Tell the client whose ticket this is -- by email, in their bell, and in the
 * Slack thread the team is using.
 *
 * Never throws. The status change is already saved by the time this runs, and
 * an unreachable mail server must not roll it back or fail the request.
 */
async function announce(ticket, fromStatus, toStatus, actor) {
  try {
    const [client, assignee] = await Promise.all([
      ticket.clientId ? db.find('users', ticket.clientId) : null,
      ticket.assigneeId ? db.find('users', ticket.assigneeId) : null,
    ]);

    await intake.echoActivity(ticket, `🔁 *${actor.name}* moved ${ticket.id} from ${fromStatus} to *${toStatus}*`);

    if (!client?.email) return { emailed: false, reason: 'the client has no email address' };

    // Straight to the client this ticket belongs to, never to a shared inbox.
    const result = await mailer.sendTemplate({
      to: client.email,
      message: messages.ticketStatusChanged({
        ticket, fromStatus, toStatus, clientName: client.name, assigneeName: assignee?.name || null,
      }),
      template: 'ticket_status',
      entity: 'ticket',
      entityId: ticket.id,
    });

    if (isClosing(toStatus)) {
      await db.update('tickets', ticket.id, { resolvedNotifiedAt: Date.now() });
    }
    return { emailed: Boolean(result?.ok), to: client.email };
  } catch (err) {
    console.error(`Could not announce the status change on ticket ${ticket.id}:`, err.message);
    return { emailed: false, reason: err.message };
  }
}

/**
 * Apply a status change and do everything that goes with it.
 *
 * `actor` is whoever asked for the change -- the proposer, not the approver,
 * when this arrives through the queue. The client should read "Ryan moved your
 * ticket", not the name of whoever happened to countersign it.
 */
async function applyStatusChange({ ticketId, toStatus, actor, patch = {} }) {
  const ticket = await db.find('tickets', ticketId);
  if (!ticket) throw new Error('That ticket no longer exists');

  const fromStatus = ticket.status;
  const updated = await db.update('tickets', ticketId, { ...patch, status: toStatus });

  const notify = require('../middleware/auth').notify;
  await notify(ticket.clientId, `Your ticket "${ticket.subject}" is now ${toStatus}`, 'ticket');

  await syncToClickUp(ticket, toStatus);
  const announced = await announce(updated, fromStatus, toStatus, actor);

  live.publish('tickets', { to: ticket.clientId ? [ticket.clientId] : null });
  return { ticket: updated, fromStatus, announced };
}

module.exports = { CLOSING_STATUSES, isClosing, syncToClickUp, announce, applyStatusChange };
