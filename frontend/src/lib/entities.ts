import type { ClientPageKey, Role } from "./types";

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: Role;
  company?: string | null;
  passwordExpiresAt?: number | null;
  /** null = every client section; an array = only these. */
  allowedPages?: ClientPageKey[] | null;
}

export interface Project {
  id: string;
  name: string;
  type: string;
  clientId: string;
  assignedPmId: string | null;
  status: "On Track" | "At Risk" | "Delayed" | "Complete" | string;
  description: string;
  createdAt: string;
  progress: { pct: number; complete: number; total: number };
}

export interface Task {
  id: string;
  projectId: string;
  name: string;
  assigneeId: string | null;
  status: "To Do" | "In Progress" | "In Review" | "Complete" | string;
  priority: "Low" | "Medium" | "High" | string;
  due: string | null;
}

export interface Ticket {
  id: string;
  subject: string;
  category: string;
  clientId: string;
  assigneeId: string | null;
  status: "Open" | "In Progress" | "Resolved" | "Closed" | string;
  description: string;
  createdAt: string;
  /** Set when the ticket was mirrored into ClickUp. */
  clickupTaskId?: string | null;
  clickupTaskUrl?: string | null;
  /** 0-100, driven by the stage or set directly by the team. */
  progress?: number | null;
  stage?: string | null;
  /** Intake routing: urgency and the first-response clock. */
  priority?: "Low" | "Normal" | "High" | "Urgent" | string | null;
  responseDueAt?: number | null;
  firstResponseAt?: number | null;
}

export interface Domain {
  id: string;
  clientId: string;
  domainName: string;
  platform: string;
  hostingProvider: string;
  hostingRegion: string;
  registrar: string;
  sslStatus: string;
  expiresAt: string;
  autoRenew: boolean;
  dnsStatus: string;
  notes: string;
}

export interface Report {
  id: string;
  clientId: string;
  name: string;
  category: string;
  storageType: "drive" | "database";
  driveLink?: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
}

export interface BudgetItem {
  id: string;
  clientId: string;
  label: string;
  amount: number;
  color: string;
  month: string;
}

export interface Billing {
  id: string;
  clientId: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  plan?: string;
  status: string;
  updatedAt?: string;
  /** Everything below is mirrored from Stripe by utils/stripeSync.js. */
  currency?: string;
  amount?: number | null;
  interval?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  cardBrand?: string | null;
  cardLast4?: string | null;
  latestInvoiceUrl?: string | null;
  syncedAt?: string | null;
}

/**
 * One real money movement, copied from a Stripe invoice or charge. Never
 * written by hand -- see utils/stripeSync.js.
 */
export interface Payment {
  id: string;
  clientId: string | null;
  stripeObjectId: string;
  kind: "invoice" | "charge" | "refund";
  description?: string | null;
  amount: number;
  currency: string;
  status: "paid" | "failed" | "open" | "refunded" | string;
  paidAt?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  invoiceUrl?: string | null;
  receiptUrl?: string | null;
  invoiceNumber?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  failureMessage?: string | null;
  createdAt?: string;
}

/** What `GET /api/billing/payments` returns. */
export interface PaymentSummary {
  enabled: boolean;
  total: number;
  currency: string;
  count: number;
  lastPaidAt?: string | null;
  categories: { id: string; label: string; amount: number }[];
  payments: Payment[];
  client?: { id: string; name: string };
}

export interface Notification {
  id: string;
  userId: string;
  message: string;
  type: string;
  read: boolean;
  createdAt: string;
}
