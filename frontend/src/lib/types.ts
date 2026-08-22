export type Role = "admin" | "sales" | "project_manager" | "employee" | "client";

/** Sections an admin can switch on or off for a client login. */
export type ClientPageKey =
  | "projects"
  | "progress"
  | "tickets"
  | "messages"
  | "domains"
  | "reports"
  | "budget"
  | "billing";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  company?: string | null;
  googleId?: string | null;
  twoFactorEnabled?: boolean;
  twoFactorContact?: string | null;
  /** null means no restriction; an array lists exactly what this client may open. */
  allowedPages?: ClientPageKey[] | null;
  /**
   * A super admin is an admin carrying a flag, not a sixth role -- see
   * utils/roles.js. Every existing admin check therefore already covers them.
   */
  isSuperAdmin?: boolean;
  /** An admin who has been vouched for and can act without a second signature. */
  adminTrusted?: boolean;
}

/**
 * What this account may do, decided by the server and sent with the session.
 *
 * The UI renders from this; the server checks the same rules again on every
 * route, so a stale or tampered copy buys nothing.
 */
export interface Capabilities {
  isSuperAdmin: boolean;
  isTrustedAdmin: boolean;
  needsApproval: boolean;
  canManageAdmins: boolean;
  canReadAuditLog: boolean;
  canDecideApprovals: boolean;
}

export const NO_CAPABILITIES: Capabilities = {
  isSuperAdmin: false,
  isTrustedAdmin: false,
  needsApproval: false,
  canManageAdmins: false,
  canReadAuditLog: false,
  canDecideApprovals: false,
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled" | "expired" | "failed";

/** One proposal waiting on a second signature. */
export interface ApprovalRequest {
  id: string;
  action: string;
  actionLabel: string;
  summary: string;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
  expiresAt: number | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  executedAt: string | null;
  executionError: string | null;
}

/** One line of the super admin's log. */
export interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  meta: unknown;
  createdAt: string;
  actorId: string | null;
  actorName: string;
  actorRole: Role | null;
  actorIsSuperAdmin: boolean;
}

export interface PublicConfig {
  googleSignInEnabled: boolean;
  googleClientId: string | null;
  firebaseEnabled: boolean;
  firebaseConfig: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
    measurementId?: string;
    storageBucket?: string;
    messagingSenderId?: string;
  } | null;
  stripeEnabled: boolean;
  stripePublishableKey: string | null;
  stripePriceId: string | null;
  driveEnabled: boolean;
}

export interface LoginResponse {
  user?: User;
  csrfToken: string;
  redirect?: string;
  requiresOtp?: boolean;
  otpExpiresAt?: number;
  /** True when the sign-in code actually left the building by email. */
  codeEmailed?: boolean;
  /** Masked inbox the code went to, e.g. "da***@example.com". */
  codeDestination?: string | null;
}

/** What the admin portal gets back when it mints a client sign-in link. */
export interface LoginLinkResponse {
  /** Path to append to the current origin, so the link matches wherever the portal is served from. */
  path: string;
  /** Absolute URL built from APP_BASE_URL, or null when the server has none. */
  url: string | null;
  expiresAt: number;
  /** What the server actually used, after clamping whatever was asked for. */
  expiresInMinutes: number;
}

/** The lifetimes an admin can pick when handing over a sign-in link. */
export const LINK_LIFETIMES: { minutes: number; label: string }[] = [
  { minutes: 5, label: "5 minutes" },
  { minutes: 15, label: "15 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 60 * 8, label: "8 hours" },
  { minutes: 60 * 24, label: "24 hours" },
  { minutes: 60 * 24 * 3, label: "3 days" },
  { minutes: 60 * 24 * 7, label: "7 days" },
];

export interface OtpLogEntry {
  id: string;
  userId: string;
  name: string;
  email: string;
  ipAddress: string;
  createdAt: string;
  expiresAt: number;
  consumed: boolean;
  attempts: number;
}
