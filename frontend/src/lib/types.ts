export type Role = "admin" | "sales" | "project_manager" | "employee" | "client";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  company?: string | null;
  googleId?: string | null;
  twoFactorEnabled?: boolean;
  twoFactorContact?: string | null;
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
}

export interface OtpLogEntry {
  id: string;
  userId: string;
  name: string;
  email: string;
  ipAddress: string;
  code: string;
  createdAt: string;
  expiresAt: number;
  consumed: boolean;
}
