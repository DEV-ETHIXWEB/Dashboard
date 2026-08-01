'use strict';

const SCHEMAS = {
  users: ['id', 'name', 'email', 'role', 'company', 'password', 'google_id', 'two_factor_enabled', 'two_factor_contact', 'password_expires_at'],
  projects: ['id', 'name', 'type', 'client_id', 'assigned_pm_id', 'status', 'description', 'created_at'],
  tasks: ['id', 'project_id', 'name', 'assignee_id', 'status', 'priority', 'due'],
  tickets: ['id', 'subject', 'category', 'client_id', 'assignee_id', 'status', 'description', 'created_at'],
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
  billing: ['id', 'client_id', 'stripe_customer_id', 'stripe_subscription_id', 'plan', 'status', 'updated_at'],
  otp_codes: ['id', 'user_id', 'code', 'ip_address', 'created_at', 'expires_at', 'consumed', 'attempts'],
};

function toSnake(str) { return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`); }
function toCamel(str) { return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }

module.exports = { SCHEMAS, toSnake, toCamel };
