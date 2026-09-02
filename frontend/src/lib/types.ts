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

/**
 * Where an account stands on the monthly password policy.
 *
 * Mirrors utils/passwordPolicy.js statusFor(). The server decides the state;
 * this copy exists so a badge can be drawn without a second request, and it is
 * never the thing that grants or refuses anything -- middleware/auth.js checks
 * the same rule again on every call.
 */
export type PasswordState =
  | "active"
  | "expiring_soon"
  | "reset_required"
  | "reset_completed"
  | "no_password";

export interface PasswordStatus {
  state: PasswordState;
  label: string;
  /** When the password was last set. Epoch ms, or null when never recorded. */
  changedAt: number | null;
  /** When a reset link was last redeemed. */
  resetAt: number | null;
  /** When it ages out, or null when the policy does not apply. */
  expiresAt: number | null;
  daysLeft: number | null;
  resetRequired: boolean;
  policyEnabled: boolean;
  maxAgeDays: number;
  warnDays: number;
  minLength: number;
}

export type CredentialDeliveryStatus = "scheduled" | "sent" | "failed" | "cancelled";

/** One scheduled hand-over of a login. Never carries the link or a password. */
export interface CredentialDelivery {
  id: string;
  userId: string;
  kind: "activation" | "reset";
  status: CredentialDeliveryStatus;
  scheduledAt: number | null;
  sentAt: number | null;
  cancelledAt: number | null;
  attempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
  canRetry: boolean;
  createdBy: string | null;
  createdAt: string | null;
}

/** The same row with enough of the account attached to render a table line. */
export interface CredentialDeliveryRow extends CredentialDelivery {
  userName: string;
  userEmail: string | null;
  userRole: Role | null;
}

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
  /**
   * When this *account* lapses, which is a different thing from the password
   * ageing out below. An admin sets it when issuing a client login, and past it
   * the login stops working entirely. See utils/passwordPolicy.js.
   */
  passwordExpiresAt?: number | null;
  /** Where this account stands on the monthly password policy. */
  passwordStatus?: PasswordStatus;
  /** Whether there is a profile picture to fetch. Drives the initials fallback. */
  hasAvatar?: boolean;
  /** Changes whenever the picture does, so the avatar URL busts its own cache. */
  avatarUpdatedAt?: number | null;
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
  /** Versions the actor's avatar URL; null when they have no picture. */
  actorAvatarUpdatedAt?: number | null;
}

export interface PublicConfig {
  /** The password rules, so a form can state them before refusing anything. */
  passwordPolicy?: {
    enabled: boolean;
    minLength: number;
    maxAgeDays: number;
    warnDays: number;
  };
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
  /** Set when an admin finished sign-in with a backup code instead of the emailed one. */
  usedRecoveryCode?: boolean;
  /** How many backup codes this admin has left, so the UI can nag at zero. */
  recoveryCodesRemaining?: number;
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

/** What the Security page knows about an admin's backup codes. Never the codes. */
export interface RecoveryCodeStatus {
  total: number;
  remaining: number;
  used: number;
  generatedAt: string | null;
}

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
