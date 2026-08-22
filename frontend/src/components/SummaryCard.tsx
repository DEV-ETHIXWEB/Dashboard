import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The compact icon + number tile used across the admin pages. Team and Client
 * Access both hand-rolled this markup; one component keeps them in step.
 */
export function SummaryCard({
  icon: Icon,
  value,
  label,
  tone = "muted",
  className,
}: {
  icon: LucideIcon;
  value: number | string;
  label: string;
  tone?: "muted" | "primary" | "warning" | "danger" | "success";
  className?: string;
}) {
  const toneClass = {
    muted: "bg-muted/80 text-foreground border-border/50",
    primary: "bg-primary/10 text-primary border-primary/20",
    warning: "bg-warning/10 text-warning border-warning/20",
    danger: "bg-destructive/10 text-destructive border-destructive/20",
    success: "bg-success/10 text-success border-success/20",
  }[tone];

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-2xl border border-border/60 bg-card/80 p-4 shadow-xs backdrop-blur-xs",
        className,
      )}
    >
      <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl border", toneClass)}>
        <Icon className="size-5" />
      </div>
      <div className="min-w-0">
        <div className="numeric-display text-2xl font-semibold text-foreground">{value}</div>
        <div className="truncate text-xs font-medium text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}
