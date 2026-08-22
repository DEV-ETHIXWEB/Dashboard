export type Role = "admin" | "sales" | "project_manager" | "employee" | "client";

/** Sections an admin can switch on or off for a client login. */
export type ClientPageKey =
  | "projects"
  | "progress"
  | "tickets"
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
