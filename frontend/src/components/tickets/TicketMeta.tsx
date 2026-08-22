import { AlarmClock, CheckCircle2, Flame, TriangleAlert } from "lucide-react";
import { slaStatus } from "@/lib/tickets";
import { cn } from "@/lib/utils";
import type { Ticket } from "@/lib/entities";

const PRIORITY_CLASS: Record<string, string> = {
  Urgent: "border-destructive/30 bg-destructive/10 text-destructive",
  High: "border-warning/30 bg-warning/10 text-warning",
  Normal: "border-border/60 bg-secondary/60 text-muted-foreground",
  Low: "border-border/50 bg-secondary/40 text-muted-foreground",
};

/** Small pill used in every ticket list so urgency reads at a glance. */
export function PriorityBadge({ priority, className }: { priority?: string | null; className?: string }) {
  const value = priority || "Normal";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        PRIORITY_CLASS[value] ?? PRIORITY_CLASS.Normal,
        className,
      )}
    >
      {value === "Urgent" && <Flame aria-hidden className="size-3" />}
      {value}
    </span>
  );
}

const SLA_CLASS = {
  breached: "border-destructive/30 bg-destructive/10 text-destructive",
  "due-soon": "border-warning/30 bg-warning/10 text-warning",
  "on-track": "border-border/60 bg-secondary/60 text-muted-foreground",
  met: "border-success/30 bg-success/10 text-success",
  none: "",
} as const;

/** First-response clock: counts down, then reports how it ended. */
export function SlaBadge({ ticket, className }: { ticket: Ticket; className?: string }) {
  const sla = slaStatus(ticket);
  if (sla.state === "none") return null;

  const Icon = sla.state === "met" ? CheckCircle2 : sla.state === "breached" ? TriangleAlert : AlarmClock;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums",
        SLA_CLASS[sla.state],
        className,
      )}
      title={
        ticket.responseDueAt
          ? `First response due ${new Date(ticket.responseDueAt).toLocaleString()}`
          : undefined
      }
    >
      <Icon aria-hidden className="size-3" />
      {sla.label}
    </span>
  );
}
