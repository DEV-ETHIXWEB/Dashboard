import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  icon: Icon,
  trend,
  tone = "default",
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  trend?: string;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  const toneClass = {
    default: "text-primary",
    success: "text-success",
    warning: "text-warning",
    danger: "text-destructive",
  }[tone];

  return (
    // Label and icon share the top row, the number sits under both. Side by
    // side they fought for the same 150px on a phone: the label wrapped to
    // three lines, the icon squeezed the number, and no two cards in the row
    // lined up. Stacked, every card puts its number in the same place whatever
    // the label does.
    <div className="skeu-stat flex h-full flex-col rounded-2xl p-4 sm:p-5 hover:-translate-y-0.5 transition-all duration-300 cursor-default group">
      <div className="flex items-start justify-between gap-2">
        <p className="t-label min-w-0 text-muted-foreground">{label}</p>
        <div className={cn(
          "skeu-tile flex size-9 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105 sm:size-10",
          toneClass
        )}>
          <Icon className="size-4.5 sm:size-5" />
        </div>
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{value}</p>
      {/* Rendered even when empty so the cards in a row end at the same height
          and the numbers stay on one line. */}
      <p className="mt-1 min-h-4 text-xs leading-4 text-muted-foreground">{trend}</p>
    </div>
  );
}
