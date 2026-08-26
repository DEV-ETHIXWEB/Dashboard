/**
 * Every screen's code, and how to fetch it before it is needed.
 *
 * The router loads each page lazily, which keeps the first paint small but
 * moves the download to the worst possible moment: the click. On a phone that
 * is a spinner between tapping Projects and seeing Projects, every time, for a
 * file that was sitting on the CDN the whole while.
 *
 * Pointing at a nav row is enough warning. Hovering or focusing one starts the
 * import, the browser has the chunk by the time the finger lands, and the page
 * renders from cache. If the guess was wrong the cost is one file the visitor
 * was reasonably likely to want anyway.
 *
 * `App.tsx` builds its `lazy()` calls from this same map, so a route can only
 * be prefetched if it is really the route's code -- the two cannot drift.
 */

type ChunkLoader = () => Promise<unknown>;

export const ROUTE_CHUNKS = {
  login: () => import("@/pages/Login"),
  dashboard: () => import("@/pages/Dashboard"),
  adminHome: () => import("@/pages/AdminHome"),
  projects: () => import("@/pages/Projects"),
  tasks: () => import("@/pages/Tasks"),
  tickets: () => import("@/pages/Tickets"),
  domains: () => import("@/pages/Domains"),
  reports: () => import("@/pages/Reports"),
  documentView: () => import("@/pages/DocumentView"),
  budget: () => import("@/pages/Budget"),
  billing: () => import("@/pages/Billing"),
  team: () => import("@/pages/Team"),
  clientAccess: () => import("@/pages/ClientAccess"),
  otpMonitor: () => import("@/pages/OtpMonitor"),
  clickup: () => import("@/pages/ClickUpTasks"),
  progress: () => import("@/pages/WorkProgress"),
  messages: () => import("@/pages/Messages"),
  mail: () => import("@/pages/MailCenter"),
  slack: () => import("@/pages/SlackMessages"),
  notifications: () => import("@/pages/Notifications"),
  approvals: () => import("@/pages/Approvals"),
  audit: () => import("@/pages/AuditLog"),
  security: () => import("@/pages/Security"),
} satisfies Record<string, ChunkLoader>;

/** Which chunk sits behind a nav destination. */
const BY_PATH: Record<string, ChunkLoader> = {
  "/login": ROUTE_CHUNKS.login,
  // Admins get AdminHome here and everyone else gets Dashboard, and which one
  // is decided inside the route. Warm the one this account will actually be
  // handed rather than both.
  "/portal/projects": ROUTE_CHUNKS.projects,
  "/portal/tasks": ROUTE_CHUNKS.tasks,
  "/portal/tickets": ROUTE_CHUNKS.tickets,
  "/portal/domains": ROUTE_CHUNKS.domains,
  "/portal/reports": ROUTE_CHUNKS.reports,
  "/portal/budget": ROUTE_CHUNKS.budget,
  "/portal/billing": ROUTE_CHUNKS.billing,
  "/portal/team": ROUTE_CHUNKS.team,
  "/portal/client-access": ROUTE_CHUNKS.clientAccess,
  "/portal/otp-monitor": ROUTE_CHUNKS.otpMonitor,
  "/portal/clickup": ROUTE_CHUNKS.clickup,
  "/portal/progress": ROUTE_CHUNKS.progress,
  "/portal/messages": ROUTE_CHUNKS.messages,
  "/portal/mail": ROUTE_CHUNKS.mail,
  "/portal/slack": ROUTE_CHUNKS.slack,
  "/portal/notifications": ROUTE_CHUNKS.notifications,
  "/portal/approvals": ROUTE_CHUNKS.approvals,
  "/portal/audit": ROUTE_CHUNKS.audit,
  "/portal/security": ROUTE_CHUNKS.security,
};

/** Asked for once each; a resolved import is already cached by the browser. */
const started = new Set<string>();

/**
 * Start downloading the code for a path. Safe to call on every hover -- it is
 * a no-op after the first, and a failure is left alone for the real navigation
 * to report properly.
 */
export function prefetchRoute(path: string): void {
  if (started.has(path)) return;
  const load = path === "/portal" ? null : BY_PATH[path];
  if (!load) return;
  started.add(path);
  void load().catch(() => started.delete(path));
}

/** The home screen, whichever of the two this account is given. */
export function prefetchHome(isAdmin: boolean): void {
  const key = isAdmin ? "adminHome" : "dashboard";
  if (started.has(key)) return;
  started.add(key);
  void ROUTE_CHUNKS[key]().catch(() => started.delete(key));
}
