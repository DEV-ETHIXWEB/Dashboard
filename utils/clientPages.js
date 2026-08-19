'use strict';

/**
 * Single source of truth for what a client login is allowed to open.
 *
 * An admin picks these when issuing a client login. `allowedPages` on the user
 * is either an array of keys from CLIENT_PAGES, or null/undefined meaning
 * "everything a client could see" -- so logins created before this feature
 * existed keep working exactly as they did.
 */

const CLIENT_PAGES = [
  { key: 'projects', label: 'Projects', description: 'Project list and progress', apiPrefix: '/api/projects' },
  {
    key: 'progress',
    label: 'Work progress',
    description: 'Live ClickUp task board and the team Slack thread for their work',
    apiPrefix: '/api/client',
  },
  { key: 'tickets', label: 'Tickets', description: 'Raise and follow support requests', apiPrefix: '/api/tickets' },
  { key: 'domains', label: 'Domains', description: 'Domains, hosting, and SSL status', apiPrefix: '/api/domains' },
  { key: 'reports', label: 'Reports', description: 'Uploaded reports and documents', apiPrefix: '/api/reports' },
  { key: 'budget', label: 'Budget', description: 'Monthly ad and project spend', apiPrefix: '/api/budget' },
  { key: 'billing', label: 'Billing', description: 'Plan, invoices, and payment status', apiPrefix: '/api/billing' },
];

const CLIENT_PAGE_KEYS = CLIENT_PAGES.map((p) => p.key);

/** Pages every signed-in user keeps regardless of the toggles. */
const ALWAYS_ON = ['dashboard', 'notifications', 'settings'];

/** Normalise whatever the admin sent into a clean key list, or null for "all". */
function normalizeAllowedPages(value) {
  if (value === undefined) return undefined; // caller did not touch the field
  if (value === null) return null; // explicit "no restriction"
  if (!Array.isArray(value)) return null;
  const keys = value.filter((k) => CLIENT_PAGE_KEYS.includes(k));
  return Array.from(new Set(keys));
}

/** The effective page list for a user: staff see everything, clients get their picks. */
function allowedPagesFor(user) {
  if (!user) return [];
  if (user.role !== 'client') return CLIENT_PAGE_KEYS;
  const raw = parseAllowedPages(user.allowedPages);
  return raw == null ? CLIENT_PAGE_KEYS : raw;
}

/** Postgres stores the list as JSON text; Firestore stores a real array. */
function parseAllowedPages(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.filter((k) => CLIENT_PAGE_KEYS.includes(k));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((k) => CLIENT_PAGE_KEYS.includes(k)) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function canSeePage(user, pageKey) {
  if (!user) return false;
  if (ALWAYS_ON.includes(pageKey)) return true;
  return allowedPagesFor(user).includes(pageKey);
}

/**
 * Router guard: block a client from an area the admin switched off. Staff roles
 * are never affected, so this is safe to mount on shared routers.
 */
function requirePage(pageKey) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== 'client') return next();
    if (canSeePage(req.user, pageKey)) return next();
    return res.status(403).json({
      error: 'This section is not enabled for your account. Ask your admin if you need access.',
      pageDisabled: pageKey,
    });
  };
}

module.exports = {
  CLIENT_PAGES,
  CLIENT_PAGE_KEYS,
  ALWAYS_ON,
  normalizeAllowedPages,
  parseAllowedPages,
  allowedPagesFor,
  canSeePage,
  requirePage,
};
