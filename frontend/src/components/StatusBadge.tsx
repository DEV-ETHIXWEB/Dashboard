import { cn } from "@/lib/utils";

const MAP: Record<string, string> = {
  "On Track": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  "Complete": "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  "In Progress": "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20",
  "At Risk": "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  "Delayed": "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",

  "Open": "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  "Resolved": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  "Closed": "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/20",

  "Valid": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  "Active": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  "Propagated": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  "pending": "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  "canceled": "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",

  "SLA Met": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  "SLA Breached": "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
  "SLA Active": "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const style = MAP[status] || "bg-zinc-500/10 text-zinc-600 border-zinc-500/20";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium capitalize whitespace-nowrap",
        style,
        className,
      )}
    >
      <span className="size-1 rounded-full bg-current" />
      {status.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}
