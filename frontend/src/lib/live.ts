/**
 * What the live wire can say, and what each thing means for the cache.
 *
 * The server sends a topic and nothing else. Every screen still reads its data
 * through the normal, permission-checked endpoints -- this file only decides
 * which of those reads is now out of date.
 */

export const LIVE_TOPICS = [
  "tickets",
  "progress",
  "messages",
  "projects",
  "tasks",
  "reports",
  "budget",
  "billing",
  "domains",
  "notifications",
  "users",
  "mail",
  "otp",
  "approvals",
  "session",
] as const;

export type LiveTopic = (typeof LIVE_TOPICS)[number];

export interface LiveEvent {
  topic: LiveTopic;
  at: number;
}

/** Query key prefixes to refetch when a topic fires. */
const TOPIC_KEYS: Record<LiveTopic, string[][]> = {
  tickets: [["tickets"], ["ticket-timeline"], ["ticket-requests"], ["client-progress"]],
  progress: [["client-progress"]],
  messages: [["client-channel"]],
  projects: [["projects"], ["client-progress"]],
  tasks: [["tasks"], ["client-progress"]],
  reports: [["reports"]],
  budget: [["budget"], ["payments"]],
  billing: [["billing"], ["payments"]],
  domains: [["domains"]],
  notifications: [["notifications"]],
  users: [["users"]],
  mail: [["mail"]],
  otp: [["otp-logs"]],
  approvals: [["approvals"], ["audit-log"]],
  session: [], // handled separately: the account itself changed
};

export function keysForTopic(topic: LiveTopic): string[][] {
  return TOPIC_KEYS[topic] ?? [];
}

export function isLiveTopic(value: unknown): value is LiveTopic {
  return typeof value === "string" && (LIVE_TOPICS as readonly string[]).includes(value);
}

/** What the connection pill shows. */
export type LiveStatus = "connecting" | "live" | "polling" | "offline";
