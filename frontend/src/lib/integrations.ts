export interface IntegrationStatus {
  clickup: { connected: boolean; ticketMirroring: boolean; ticketsListId: string | null };
  slack: { connected: boolean };
}

// --- ClickUp ---------------------------------------------------------------

export interface ClickUpAssignee {
  id: string;
  name: string;
  email: string | null;
  initials: string | null;
  color: string | null;
}

export interface ClickUpTask {
  id: string;
  name: string;
  url: string | null;
  status: string;
  statusType: string;
  statusColor: string | null;
  priority: string | null;
  priorityLabel: string | null;
  dueAt: number | null;
  startAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  timeEstimate: number | null;
  assignees: ClickUpAssignee[];
  listId: string | null;
  listName: string | null;
  folderName: string | null;
  spaceId: string | null;
  tags: string[];
}

export type ClickUpBucket = "overdue" | "due_today" | "due_this_week" | "later" | "no_due_date";

export interface ClickUpWorkloadRow extends ClickUpAssignee {
  total: number;
  overdue: number;
  dueToday: number;
}

export interface ClickUpOverview {
  tasks: ClickUpTask[];
  buckets: Record<ClickUpBucket, ClickUpTask[]>;
  bucketOrder: ClickUpBucket[];
  workload: ClickUpWorkloadRow[];
  counts: {
    total: number;
    overdue: number;
    dueToday: number;
    dueThisWeek: number;
    unassigned: number;
  };
  fetchedAt: number;
}

export interface ClickUpList {
  id: string;
  name: string;
  taskCount: number | null;
}

export interface ClickUpFolder {
  id: string;
  name: string;
  lists: ClickUpList[];
}

export interface ClickUpSpace {
  id: string;
  name: string;
  color: string | null;
  folders: ClickUpFolder[];
  lists: ClickUpList[];
}

export interface ClickUpTree {
  workspace: { id: string; name: string };
  spaces: ClickUpSpace[];
}

export interface ClickUpMember {
  id: string;
  name: string;
  email: string | null;
  initials: string | null;
  color: string | null;
  avatar: string | null;
}

export interface ClickUpStatus {
  status: string;
  type: string;
  color: string | null;
  orderindex: number;
}

export interface ClickUpComment {
  id: string;
  text: string;
  authorName: string;
  authorInitials: string | null;
  resolved: boolean;
  createdAt: number | null;
}

/** Fields the dashboard can write back to ClickUp. */
export interface ClickUpTaskInput {
  name?: string;
  description?: string;
  status?: string;
  priority?: "urgent" | "high" | "normal" | "low" | null;
  dueAt?: number | null;
  assignees?: string[];
  removeAssignees?: string[];
}

export const PRIORITY_OPTIONS = ["urgent", "high", "normal", "low"] as const;

export const BUCKET_LABELS: Record<ClickUpBucket, string> = {
  overdue: "Overdue",
  due_today: "Due today",
  due_this_week: "Due this week",
  later: "Later",
  no_due_date: "No due date",
};

// --- Slack -----------------------------------------------------------------

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  topic: string;
  purpose: string;
  memberCount: number | null;
}

export interface SlackMessage {
  id: string;
  ts: string;
  at: number | null;
  text: string;
  category: string;
  channelId: string;
  channelName: string;
  authorId: string | null;
  authorName: string;
  authorAvatar: string | null;
  isBot: boolean;
  replyCount: number;
  reactionCount: number;
  files: { id: string; name: string; type: string | null }[];
  permalink: string;
}

export interface SlackCategory {
  key: string;
  label: string;
  description: string;
  messages: SlackMessage[];
}

export interface SlackFeed {
  categories: SlackCategory[];
  channels: { id: string; name: string; isPrivate: boolean; count: number }[];
  skipped: { channelId: string; channelName: string; reason: string }[];
  total: number;
  fetchedAt: number;
}
