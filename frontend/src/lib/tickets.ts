import type { Ticket } from "@/lib/entities";

/** Matches KINDS in utils/ticketWorkflow.js. */
export type TicketUpdateKind = "progress" | "handover" | "collaboration" | "system";
export type RequestStatus = "pending" | "accepted" | "declined";

export interface TicketUpdate {
  id: string;
  ticketId: string;
  authorId: string | null;
  kind: TicketUpdateKind;
  body: string | null;
  progress: number | null;
  stage: string | null;
  targetUserId: string | null;
  status: RequestStatus | null;
  createdAt: string;
  resolvedAt: string | null;
  /**
   * Resolved by the timeline endpoint. The browser cannot always do this
   * itself -- a client is shown a deliberately short staff roster -- so these
   * are the names to render, with the /users lookup only as a fallback.
   */
  authorName?: string | null;
  targetName?: string | null;
}

export interface TicketCollaborator {
  id: string;
  ticketId: string;
  userId: string;
  addedBy: string | null;
  createdAt: string;
  /** Resolved server-side, same reason as TicketUpdate.authorName. */
  name?: string | null;
}

export interface TicketStage {
  key: string;
  label: string;
  progress: number;
}

export interface TicketTimeline {
  ticket: Ticket;
  /** The assignee's name, resolved server-side. Null when unassigned. */
  assigneeName: string | null;
  updates: TicketUpdate[];
  collaborators: TicketCollaborator[];
  can: {
    recordProgress: boolean;
    delegate: boolean;
  };
}

/** Fallback so the UI can render before /tickets/stages resolves. */
export const DEFAULT_STAGES: TicketStage[] = [
  { key: "triage", label: "Triage", progress: 0 },
  { key: "in_progress", label: "In progress", progress: 30 },
  { key: "waiting_on_client", label: "Waiting on client", progress: 50 },
  { key: "review", label: "Review", progress: 80 },
  { key: "done", label: "Done", progress: 100 },
];

export function stageLabel(key: string | null | undefined, stages: TicketStage[] = DEFAULT_STAGES): string {
  if (!key) return "Not started";
  return stages.find((s) => s.key === key)?.label ?? key;
}

export function isRequest(update: TicketUpdate): boolean {
  return update.kind === "handover" || update.kind === "collaboration";
}

// --- service level ---------------------------------------------------------

/** Mirrors PRIORITIES in utils/ticketIntake.js, most urgent last. */
export const TICKET_PRIORITIES = ["Low", "Normal", "High", "Urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export type SlaState = "met" | "breached" | "due-soon" | "on-track" | "none";

export interface SlaStatus {
  state: SlaState;
  /** Milliseconds left (negative once the deadline has passed). */
  remainingMs: number;
  label: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function shortDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < HOUR) return `${Math.max(1, Math.round(abs / MINUTE))}m`;
  if (abs < 24 * HOUR) return `${Math.round(abs / HOUR)}h`;
  return `${Math.round(abs / (24 * HOUR))}d`;
}

/**
 * Where a ticket stands against its first-response deadline. Answered tickets
 * are judged on when the answer landed, not on the clock still running.
 */
export function slaStatus(ticket: Ticket, now = Date.now()): SlaStatus {
  const due = ticket.responseDueAt;
  if (!due) return { state: "none", remainingMs: 0, label: "No SLA" };

  if (ticket.firstResponseAt) {
    const late = ticket.firstResponseAt - due;
    return late > 0
      ? { state: "breached", remainingMs: -late, label: `Answered ${shortDuration(late)} late` }
      : { state: "met", remainingMs: -late, label: `Answered ${shortDuration(late)} early` };
  }

  const remainingMs = due - now;
  if (remainingMs <= 0) return { state: "breached", remainingMs, label: `${shortDuration(remainingMs)} overdue` };
  if (remainingMs <= HOUR) return { state: "due-soon", remainingMs, label: `${shortDuration(remainingMs)} left` };
  return { state: "on-track", remainingMs, label: `${shortDuration(remainingMs)} left` };
}

export function priorityRank(priority: string | null | undefined): number {
  const index = TICKET_PRIORITIES.indexOf((priority ?? "Normal") as TicketPriority);
  return index === -1 ? 1 : index;
}
