'use strict';

const SCHEMAS = {
  users: [
    'id', 'name', 'email', 'role', 'company', 'password', 'google_id',
    // The mobile number this person texts us from, in E.164 (+14155551234).
    // Deliberately not 'two_factor_contact': that is where a sign-in code goes
    // and the account holder chooses it, whereas this is what an inbound text
    // is matched against. Conflating them would let somebody redirect their own
    // login codes by texting us from a new phone.
    'phone',
    'two_factor_enabled', 'two_factor_contact', 'password_expires_at',
    // Password *age*, which is a different question from the line above.
    // `password_expires_at` is when this account's access lapses -- an admin
    // sets it when issuing a client login, and the account stops working. These
    // three are the monthly password policy: when the secret was last set,
    // whether it must be replaced before anything else can happen, and when a
    // reset link was last redeemed. Conflating the two would mean a client on a
    // 30-day password rotation loses their account on day 31. See
    // utils/passwordPolicy.js.
    'password_changed_at', 'password_reset_required', 'password_reset_at',
    // When this account's picture last changed. The bytes live in user_avatars;
    // only the timestamp is here, because db.all('users') runs on nearly every
    // request and must not start dragging images through it. Doubles as the
    // cache-buster on the avatar URL.
    'avatar_updated_at',
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
  // `user_agent` and `ip_address` exist for one screen: the list on somebody's
  // own profile that lets them look down it and spot a session that is not
  // theirs. "Another device" cannot do that job. Both are self-reported and
  // nothing is ever authorised on the strength of them -- they are a label, and
  // only their owner is shown them. See utils/userAgent.js.
  sessions: [
    'id', 'user_id', 'csrf_token', 'created_at', 'expires_at', 'pending',
    'user_agent', 'ip_address',
  ],
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
    'id', 'client_id', 'stripe_customer_id', 'stripe_object_id', 'stripe_payment_intent', 'kind',
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
  // Backup codes an administrator can use in place of the emailed one, so a
  // broken mail transport cannot lock the whole workspace out. Only the bcrypt
  // hash is stored; see utils/recoveryCodes.js.
  recovery_codes: ['id', 'user_id', 'code_hash', 'created_at', 'used_at'],
  // One-tap sign-in links emailed to clients. Only the SHA-256 of the secret
  // half of the link is stored, so a database leak cannot be replayed as a
  // login. See utils/loginLinks.js for the token format.
  login_links: ['id', 'user_id', 'token_hash', 'ip_address', 'created_at', 'expires_at', 'consumed'],
  // One scheduled hand-over of a login. A row is created when an admin picks a
  // date, claimed atomically when it comes due, and never carries the secret
  // itself: what is sent is an activation link, minted at delivery time.
  // See utils/credentialDelivery.js.
  credential_deliveries: [
    'id', 'user_id', 'kind', 'status', 'scheduled_at',
    'attempts', 'last_attempt_at', 'last_error',
    'claimed_at', 'sent_at', 'cancelled_at',
    'created_by', 'created_at', 'updated_at',
  ],
  // Account-activation and password-reset links. Same shape as login_links and
  // for the same reason: only the SHA-256 of the secret half is stored, so a
  // database leak cannot be replayed as a password change.
  password_tokens: [
    'id', 'user_id', 'purpose', 'token_hash', 'ip_address',
    'created_at', 'expires_at', 'consumed', 'consumed_at', 'issued_by',
  ],
  // One picture per account. Its own table rather than columns on `users`
  // because the whole user list is read on nearly every request, and base64
  // image bytes have no business travelling with it.
  user_avatars: [
    'id', 'user_id', 'storage_type', 'mime_type', 'size_bytes',
    'width', 'height', 'content_base64', 'checksum', 'updated_at', 'updated_by',
  ],
  // Every outbound email the app attempted, including the ones skipped because
  // no transport is configured. Drives the admin Mail page.
  email_log: [
    'id', 'to_emails', 'subject', 'template', 'status', 'transport', 'error',
    'entity', 'entity_id', 'html', 'created_at',
  ],
  // One row per message a client texted in, before anybody has decided what it
  // is. Deliberately not a ticket: most texts are a question, a nudge, or a
  // thank-you, and giving every one of them an SLA clock would bury the ones
  // that matter. Promotion to a ticket is a human's one-click decision -- see
  // utils/smsIntake.js.
  //
  // 'provider_sid' is the id Twilio gave the message and carries a UNIQUE
  // index. Twilio re-sends a webhook it believes failed, and that index is what
  // stops one text from becoming two rows.
  //
  // Every 'ai_' column is a label for a person to read, never an instruction.
  // The body is untrusted text from outside the workspace, so nothing derived
  // from it may choose an assignee, move a status, or send anything outward.
  sms_messages: [
    'id', 'provider', 'provider_sid', 'channel', 'direction',
    'from_number', 'to_number', 'body', 'num_media', 'media_json',
    // Null until the number matches an account, or an admin links it by hand.
    'client_id', 'status',
    // Twilio's own outcome for an outbound send, distinct from `status` above
    // (which is inbox triage state: new/read/archived). Null on inbound rows.
    'delivery_status', 'delivery_error',
    'ai_summary', 'ai_intent', 'ai_priority', 'ai_category', 'ai_at',
    // Set once somebody promotes this message into a real ticket.
    'ticket_id', 'created_at',
    // Which broadcast batch this send belongs to, if any. Null for every
    // ordinary inbound text and single reply.
    'broadcast_id',
  ],
  // One row per "send this to a list of clients" action. The individual sends
  // themselves are ordinary rows in sms_messages (broadcast_id ties them back
  // here) -- this table is just the batch record, not a second message store.
  sms_broadcasts: ['id', 'body', 'created_by', 'recipient_count', 'created_at'],
  // The routing table for the SMS <-> Slack bridge: which Slack thread a given
  // phone number's conversation lives in, so a reply posted there can find its
  // way back to the right customer. One shared channel, one thread per
  // customer -- see utils/smsConversations.js. Keyed on phone number rather
  // than client_id because a first-time text has no client yet.
  sms_conversations: [
    'id', 'phone_number', 'client_id',
    'slack_channel_id', 'slack_thread_ts',
    'created_at', 'updated_at',
  ],
  // One tracked unit of work, born from a customer's text and worked inside a
  // single Slack thread. Separate from sms_conversations because a conversation
  // is permanent (a phone number and who it belongs to) while a task is not: a
  // number that texts again after its last task closed starts a new one, with a
  // new card and a new thread. The open task for a conversation is found by
  // state, so there is no "current task" pointer to keep in sync.
  sms_tasks: [
    'id', 'conversation_id', 'phone_number', 'client_id',
    'state', 'priority', 'summary', 'original_body',
    // The card. slack_message_ts doubles as the thread_ts every command and
    // follow-up text is posted under -- a Slack thread is named by its parent.
    'slack_channel_id', 'slack_message_ts',
    'accepted_by', 'accepted_at',
    'owner_slack_id', 'assigned_at',
    // The one outbound text this task is allowed, and when it went. Both stay
    // null until @send succeeds, which is also how a second @send is refused.
    // sent_sid is Twilio's id for that text, and it is what a later delivery
    // status callback matches on: "Twilio accepted it" and "the handset got it"
    // are different questions, sometimes minutes apart, and a task closed on
    // the first answer has to be reopened if the second one is no.
    'sent_body', 'sent_at', 'sent_sid',
    'closed_at', 'created_at', 'updated_at',
  ],
  // Dedup ledger for the Slack Events API, the same role provider_sid plays
  // for Twilio: Slack retries a delivery it did not get a fast 200 for, and
  // the id is the only thing that tells two deliveries of the same event
  // apart from two different events.
  slack_events: ['id', 'processed_at'],
};

/**
 * Columns that may hold a given value only once, in camelCase.
 *
 * Postgres already knows this -- every one of these is a UNIQUE column in
 * db/setup.js, and the constraint is enforced by the database whether the
 * application remembers it or not. Firestore has no equivalent: a field is just
 * a field, and two documents may carry the same one happily. So the list is
 * repeated here, where both drivers can read it, and db/firestore.js reserves
 * each value as it writes.
 *
 * These are not decorative. Several of them are load-bearing guarantees that
 * callers rely on by catching the *failure* of a write:
 *
 *   sms_messages.provider_sid    Twilio re-sends a text it is unsure landed;
 *                                the rejected insert is how routes/sms.js knows
 *                                it is a repeat and not a second text.
 *   sms_conversations.phone_number  two texts from one customer arriving at the
 *                                same moment must land in one conversation.
 *   users.email                  two accounts on one address is an authentication
 *                                problem, not an untidy list.
 *   payments.stripe_object_id    Stripe retries webhooks; this is what stops one
 *                                payment being recorded twice.
 *   billing.client_id            one billing record per client, by definition.
 *   user_avatars.user_id         one picture per account -- a replacement is an
 *                                upsert, not a second row to choose between.
 */
const UNIQUE_FIELDS = {
  users: ['email'],
  billing: ['clientId'],
  payments: ['stripeObjectId'],
  user_avatars: ['userId'],
  sms_messages: ['providerSid'],
  sms_conversations: ['phoneNumber'],
};

function uniqueFields(collection) {
  return UNIQUE_FIELDS[collection] || [];
}

function toSnake(str) { return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`); }
function toCamel(str) { return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }

/**
 * One column, one spelling the application is allowed to write it under.
 *
 * `toSnake` on its own is a normaliser, not a gate: it maps both `isSuperAdmin`
 * and `is_super_admin` onto the same column. That turns every guard written
 * against a camelCase field name into a guard with a synonym that walks around
 * it. So the drivers accept a key only when it is the canonical camelCase name
 * of a real column -- `isSuperAdmin` writes, `is_super_admin` is dropped.
 *
 * Kept here rather than in either driver so Postgres and Firestore cannot
 * drift apart on the question.
 */
function isWritableField(collection, key) {
  const cols = SCHEMAS[collection];
  if (!cols) return false;
  const snakeKey = toSnake(key);
  if (!cols.includes(snakeKey)) return false;
  return key === toCamel(snakeKey);
}

module.exports = { SCHEMAS, UNIQUE_FIELDS, uniqueFields, toSnake, toCamel, isWritableField };
