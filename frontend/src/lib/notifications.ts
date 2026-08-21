import { Bell, FileText, FolderKanban, LifeBuoy, ListChecks, type LucideIcon } from "lucide-react";
import type { Notification } from "@/lib/entities";

/**
 * What a notification is about, and where it goes when tapped.
 *
 * The server writes a free-text `type`; anything unrecognised falls back to
 * "general" rather than disappearing, so a new notification type added on the
 * server still shows up here the day it ships.
 */
export type NotificationKind = "ticket" | "task" | "project" | "report" | "general";

const KINDS: NotificationKind[] = ["ticket", "task", "project", "report", "general"];

export function kindOf(type: string | null | undefined): NotificationKind {
  const value = String(type ?? "").toLowerCase();
  return (KINDS as string[]).includes(value) ? (value as NotificationKind) : "general";
}

interface KindLook {
  /** The word a client would use, and the word staff would use. */
  label: string;
  icon: LucideIcon;
  /** Where tapping the notification takes you, or null when there is nowhere. */
  to: string | null;
  /** Tailwind classes for the small icon tile. */
  tone: string;
}

export function lookFor(kind: NotificationKind, isClient: boolean): KindLook {
  switch (kind) {
    case "ticket":
      return {
        label: isClient ? "Requests" : "Tickets",
        icon: LifeBuoy,
        to: "/portal/tickets",
        tone: "bg-primary/10 text-primary",
      };
    case "task":
      return {
        // A client has no task list of their own; their tasks live on the
        // progress board, which is what they call "work".
        label: isClient ? "Work" : "Tasks",
        icon: ListChecks,
        to: isClient ? "/portal/progress" : "/portal/tasks",
        tone: "bg-info/10 text-info",
      };
    case "project":
      return {
        label: "Projects",
        icon: FolderKanban,
        to: "/portal/projects",
        tone: "bg-success/10 text-success",
      };
    case "report":
      return {
        label: isClient ? "Documents" : "Reports",
        icon: FileText,
        to: "/portal/reports",
        tone: "bg-warning/15 text-warning",
      };
    default:
      return { label: "General", icon: Bell, to: null, tone: "bg-secondary text-muted-foreground" };
  }
}

/** The filters offered above the list, in the order they are worth reaching for. */
export function kindsPresent(items: Notification[]): NotificationKind[] {
  const seen = new Set(items.map((n) => kindOf(n.type)));
  return KINDS.filter((k) => seen.has(k));
}

export interface NotificationGroup {
  heading: string;
  items: Notification[];
}

const DAY_MS = 86_400_000;

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Today, Yesterday, This week, Earlier.
 *
 * Dates are read the way people talk about them. An exact timestamp is still
 * one hover away on the row itself, for the rare moment somebody needs it.
 */
export function groupByDay(items: Notification[]): NotificationGroup[] {
  const today = startOfDay(new Date());
  const buckets: NotificationGroup[] = [
    { heading: "Today", items: [] },
    { heading: "Yesterday", items: [] },
    { heading: "This week", items: [] },
    { heading: "Earlier", items: [] },
  ];

  for (const item of items) {
    const at = new Date(item.createdAt).getTime();
    const day = Number.isFinite(at) ? startOfDay(new Date(at)) : 0;
    if (day >= today) buckets[0].items.push(item);
    else if (day >= today - DAY_MS) buckets[1].items.push(item);
    else if (day > today - 7 * DAY_MS) buckets[2].items.push(item);
    else buckets[3].items.push(item);
  }

  return buckets.filter((b) => b.items.length > 0);
}
