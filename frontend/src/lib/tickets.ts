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
}

export interface TicketCollaborator {
  id: string;
  ticketId: string;
  userId: string;
  addedBy: string | null;
  createdAt: string;
}

export interface TicketStage {
  key: string;
  label: string;
  progress: number;
}

export interface TicketTimeline {
  ticket: Ticket;
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
