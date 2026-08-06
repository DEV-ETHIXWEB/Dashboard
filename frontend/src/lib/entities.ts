import type { Role } from "./types";

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: Role;
  company?: string | null;
  passwordExpiresAt?: number | null;
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
}

export interface Notification {
  id: string;
  userId: string;
  message: string;
  type: string;
  read: boolean;
  createdAt: string;
}
