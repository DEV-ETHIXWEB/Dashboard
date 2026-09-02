import type { ClientPageKey, Role, User } from "./types";

/**
 * Mirror of utils/clientPages.js on the server. The server is still the
 * authority -- this copy only decides what the sidebar and routes show, so a
 * stale client can never see data it is not allowed to fetch.
 */
export const CLIENT_PAGES: { key: ClientPageKey; label: string; description: string; path: string }[] = [
  { key: "projects", label: "Projects", description: "Project list and progress", path: "/portal/projects" },
  {
    key: "progress",
    label: "Work progress",
    description: "Live task board and the team thread for their work",
    path: "/portal/progress",
  },
  { key: "tickets", label: "Tickets", description: "Raise and follow support requests", path: "/portal/tickets" },
  {
    key: "messages",
    label: "Messages",
    description: "A direct line to the team, in their own Slack channel",
    path: "/portal/messages",
  },
  { key: "domains", label: "Domains", description: "Domains, hosting, and SSL status", path: "/portal/domains" },
  { key: "reports", label: "Reports", description: "Uploaded reports and documents", path: "/portal/reports" },
  { key: "budget", label: "Budget", description: "Monthly ad and project spend", path: "/portal/budget" },
  { key: "billing", label: "Billing", description: "Plan, invoices, and payment status", path: "/portal/billing" },
];

export const CLIENT_PAGE_KEYS = CLIENT_PAGES.map((p) => p.key);

const PATH_TO_KEY = new Map<string, ClientPageKey>(CLIENT_PAGES.map((p) => [p.path, p.key]));

/** Which page key a route belongs to, or null for pages nobody can switch off. */
export function pageKeyForPath(path: string): ClientPageKey | null {
  return PATH_TO_KEY.get(path) ?? null;
}

/** Staff see their whole role; clients see only what the admin ticked. */
export function canSeePage(
  user: { role: Role; allowedPages?: ClientPageKey[] | null } | null | undefined,
  pageKey: ClientPageKey | null,
): boolean {
  if (!user) return false;
  if (pageKey == null) return true;
  if (user.role !== "client") return true;
  const allowed = user.allowedPages;
  // null/undefined is the documented "no restriction" for logins made before
  // the toggles existed. Anything else that is not a list is unreadable, and an
  // unreadable value must not be the reason a section opens -- the server takes
  // the same line in parseAllowedPages.
  if (allowed == null) return true;
  if (!Array.isArray(allowed)) return false;
  return allowed.includes(pageKey);
}

/**
 * Whether this account may read billing at all.
 *
 * Distinct from `canSeePage(user, "billing")`, and the two are not
 * interchangeable: that one answers "has an admin switched this section on for
 * this client", and says yes to every staff role because the toggles were only
 * ever about clients. Billing is the one section where a staff role is the
 * thing being refused -- `requireBillingReader` on the server answers 403 to
 * sales, project managers and employees, because payment history is every
 * client's card brand and receipts.
 *
 * Using the page-toggle check to gate a billing request therefore asked a
 * question whose answer was always yes, and the dashboard sent a request it
 * was always going to be refused. Mirrors the server; the server still decides.
 */
export function canReadBilling(user: { role: Role } | null | undefined): boolean {
  return user?.role === "admin" || user?.role === "client";
}

/**
 * Whether this account can actually open /portal/budget.
 *
 * Two different refusals sit behind that one page, and a link is only safe to
 * draw when neither applies: the route admits admins, project managers and
 * clients, and a client on top of that has to have the section switched on.
 * Sales and employees are shown their clients' spend on the dashboard -- the
 * API gives them the figures -- but the page itself is not theirs, so the
 * "See all spending" link would have bounced them back to where they started.
 */
export function canOpenBudget(
  user: { role: Role; allowedPages?: ClientPageKey[] | null } | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === "client") return canSeePage(user, "budget");
  return user.role === "admin" || user.role === "project_manager";
}

/** Human summary for the admin list: "All sections" or "Projects, Billing". */
export function describeAccess(allowedPages: ClientPageKey[] | null | undefined): string {
  if (allowedPages == null) return "All sections";
  if (allowedPages.length === 0) return "No sections";
  return CLIENT_PAGES.filter((p) => allowedPages.includes(p.key))
    .map((p) => p.label)
    .join(", ");
}

export function isClient(user: User | null | undefined) {
  return user?.role === "client";
}
