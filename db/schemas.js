'use strict';

const SCHEMAS = {
  users: [
    'id', 'name', 'email', 'role', 'company', 'password', 'google_id',
    'two_factor_enabled', 'two_factor_contact', 'password_expires_at',
    // JSON array of client page keys (see utils/clientPages.js). NULL = no restriction.
    'allowed_pages',
    // A super admin is an admin with two extra powers: they can appoint other
    // admins, and they can act without a second signature. Deliberately a flag
    // on top of role 'admin' rather than a role of its own -- every existing
    // `role === 'admin'` check in the app therefore grants it automatically,
    // and no permission can be forgotten by omission. See utils/roles.js.
    // The one Slack channel this client can see and write into. Set when the
    // login is issued; nothing else in Slack is ever reachable from the portal.
    'slack_channel_id', 'slack_channel_name',
    'is_super_admin',
    // A newly appointed admin starts untrusted: their sensitive changes are
    // held for a second signature until a super admin vouches for them.
    'admin_trusted', 'admin_trusted_at', 'admin_trusted_by',
  ],
  projects: ['id', 'name', 'type', 'client_id', 'assigned_pm_id', 'status', 'description', 'created_at'],
  tasks: ['id', 'project_id', 'name', 'assignee_id', 'status', 'priority', 'due'],
  tickets: [
    'id', 'subject', 'category', 'client_id', 'assignee_id', 'status', 'description', 'created_at',
    'clickup_task_id', 'clickup_task_url', 'progress', 'stage',
    // Service level: when the first response is due, and when it actually came.
    'priority', 'response_due_at', 'first_response_at',
    // Where the team is talking about this ticket in Slack, so the client can
    // follow that conversation from their portal without a Slack account.
    'slack_channel_id', 'slack_thread_ts',
    // Set once the client has been told the ticket was resolved, so a reopen
    // and a second close send a second email rather than none.
    'resolved_notified_at',
  ],
  // One row per note, handover request, or collaboration request on a ticket.
  // Requests are just updates with a kind + target + pending/accepted/declined
  // status, so the ticket timeline stays a single ordered list.
  ticket_updates: [
    'id', 'ticket_id', 'author_id', 'kind', 'body', 'progress', 'stage',
    'target_user_id', 'status', 'created_at', 'resolved_at',
  ],
  ticket_collaborators: ['id', 'ticket_id', 'user_id', 'added_by', 'created_at'],
  notifications: ['id', 'user_id', 'message', 'type', 'read', 'created_at'],
  sessions: ['id', 'user_id', 'csrf_token', 'created_at', 'expires_at', 'pending'],
  activity_log: ['id', 'actor_id', 'action', 'entity', 'entity_id', 'meta', 'created_at'],
  domains: [
    'id', 'client_id', 'domain_name', 'platform', 'hosting_provider', 'hosting_region',
    'registrar', 'ssl_status', 'expires_at', 'auto_renew', 'dns_status', 'notes',
  ],
  reports: [
    'id', 'client_id', 'name', 'category', 'storage_type', 'drive_file_id', 'drive_link',
    'content_base64', 'mime_type', 'size_bytes', 'uploaded_by', 'created_at',
  ],
  budget_items: ['id', 'client_id', 'label', 'amount', 'color', 'month'],
  billing: [
    'id', 'client_id', 'stripe_customer_id', 'stripe_subscription_id', 'plan', 'status', 'updated_at',
    // Cached from Stripe so the portal can answer "what am I on and when does
    // it renew?" without a round trip on every page load.
    'currency', 'amount', 'interval', 'current_period_end', 'cancel_at_period_end',
    'card_brand', 'card_last4', 'latest_invoice_url', 'synced_at',
  ],
  // One row per real money movement, mirrored from Stripe. Stripe stays the
  // source of truth: nothing here is ever created by hand, and every row is
  // keyed by its Stripe object id so a replayed webhook updates rather than
  // duplicates.
  payments: [
    'id', 'client_id', 'stripe_customer_id', 'stripe_object_id', 'kind',
    'description', 'amount', 'currency', 'status', 'paid_at', 'period_start', 'period_end',
    'invoice_url', 'receipt_url', 'invoice_number', 'card_brand', 'card_last4',
    'failure_message', 'created_at',
  ],
  // A sensitive change proposed by an admin who cannot yet make it alone.
  // `action` names an entry in utils/approvals.js ACTIONS; `payload` is the
  // arguments that action will be executed with, once and only once.
  approval_requests: [
    'id', 'action', 'summary', 'payload', 'status',
    'requested_by', 'requested_at', 'expires_at',
    'decided_by', 'decided_at', 'decision_note',
    'executed_at', 'execution_error',
  ],
  otp_codes: ['id', 'user_id', 'code', 'ip_address', 'created_at', 'expires_at', 'consumed', 'attempts'],
  // One-tap sign-in links emailed to clients. Only the SHA-256 of the secret
  // half of the link is stored, so a database leak cannot be replayed as a
  // login. See utils/loginLinks.js for the token format.
  login_links: ['id', 'user_id', 'token_hash', 'ip_address', 'created_at', 'expires_at', 'consumed'],
  // Every outbound email the app attempted, including the ones skipped because
  // no transport is configured. Drives the admin Mail page.
  email_log: [
    'id', 'to_emails', 'subject', 'template', 'status', 'transport', 'error',
    'entity', 'entity_id', 'html', 'created_at',
  ],
};

function toSnake(str) { return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`); }
function toCamel(str) { return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }

module.exports = { SCHEMAS, toSnake, toCamel };
