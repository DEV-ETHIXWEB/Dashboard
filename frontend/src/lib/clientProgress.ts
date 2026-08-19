/** Shapes returned by routes/client.js -- the client-facing progress board. */

export interface BoardState {
  status: string;
  statusType: string;
  statusColor: string | null;
  dueAt: number | null;
  updatedAt: number | null;
  listName: string | null;
  assignees: string[];
}

export interface ProgressTicket {
  id: string;
  subject: string;
  category: string;
  status: string;
  priority: string;
  stage: string | null;
  stageLabel: string | null;
  progress: number;
  createdAt: string;
  responseDueAt: number | null;
  firstResponseAt: number | null;
  ownerName: string | null;
  hasBoardTask: boolean;
  hasThread: boolean;
  board: BoardState | null;
}

export interface ProgressBoard {
  client: { id: string; name: string; company: string | null } | null;
  tickets: ProgressTicket[];
  projects: { id: string; name: string; status: string; type: string }[];
  summary: {
    open: number;
    resolved: number;
    averageProgress: number;
    nextDeadline: number | null;
    activeProjects: number;
  };
  integrations: { board: boolean; chat: boolean; chatMode: "summary" | "full" };
}

export interface ActivityNote {
  id: string;
  author: string;
  authorRole: string;
  body: string;
  progress: number | null;
  stage: string | null;
  stageLabel: string | null;
  at: string;
}

export interface ActivityEntry {
  id: string;
  author: string;
  body: string;
  at: number | null;
  isBot?: boolean;
}

export interface TicketActivity {
  ticket: ProgressTicket;
  notes: ActivityNote[];
  board: {
    enabled: boolean;
    linked: boolean;
    available: boolean;
    comments: ActivityEntry[];
    error: string | null;
    url: string | null;
  };
  chat: {
    enabled: boolean;
    linked: boolean;
    available: boolean;
    mode: "summary" | "full";
    messages: ActivityEntry[];
    error: string | null;
  };
}

const CLOSED = ["Resolved", "Closed"];

export function isClosed(ticket: { status: string }): boolean {
  return CLOSED.includes(ticket.status);
}
