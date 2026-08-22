import { useState } from "react";
import { toast } from "sonner";
import { ExternalLink, MessageSquare, Loader2, Layers } from "lucide-react";
import { useClickUpListStatuses, useUpdateClickUpTask } from "@/hooks/useIntegrations";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDateTime, formatRelativeTime, initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ClickUpTask } from "@/lib/integrations";

const PRIORITY_TONE: Record<string, string> = {
  urgent: "bg-destructive/10 text-destructive",
  high: "bg-warning/10 text-warning",
  normal: "bg-primary/10 text-primary",
  low: "bg-secondary text-muted-foreground",
};

/** True when the due date has passed and the task is still open. */
function isOverdue(task: ClickUpTask) {
  return task.dueAt != null && task.dueAt < Date.now();
}

export function TaskRow({
  task,
  onOpen,
  showLocation = true,
}: {
  task: ClickUpTask;
  onOpen: (task: ClickUpTask) => void;
  /** Hide the list breadcrumb when every row on screen is already from one list. */
  showLocation?: boolean;
}) {
  // Only ask ClickUp for this list's statuses once the dropdown is opened --
  // a bucket of 20 rows can span 20 different lists, and fetching all of them
  // on render trips ClickUp's rate limit.
  const [statusOpen, setStatusOpen] = useState(false);
  const statuses = useClickUpListStatuses(task.listId, statusOpen);
  const updateTask = useUpdateClickUpTask();
  const pending = updateTask.isPending && updateTask.variables?.taskId === task.id;
  const overdue = isOverdue(task);

  function changeStatus(status: string | null) {
    if (!status) return;
    updateTask.mutate(
      { taskId: task.id, input: { status } },
      {
        onSuccess: () => toast.success(`Moved to ${status}`),
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update the task"),
      },
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2 border-b border-border/60 px-3 py-2.5 transition-colors last:border-b-0 hover:bg-secondary/40 sm:flex-row sm:items-center sm:gap-3">
      <button type="button" onClick={() => onOpen(task)} className="focus-clear min-w-0 flex-1 text-left">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm leading-snug font-medium text-foreground">{task.name}</span>
          {task.priorityLabel && (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 t-label",
                PRIORITY_TONE[task.priorityLabel.toLowerCase()],
              )}
            >
              {task.priorityLabel}
            </span>
          )}
        </div>

        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {showLocation && task.listName && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <Layers className="size-3 shrink-0" />
              <span className="truncate">
                {task.folderName ? `${task.folderName} / ${task.listName}` : task.listName}
              </span>
            </span>
          )}
          <span className={cn("tabular-nums", overdue && "font-medium text-destructive")}>
            {task.dueAt ? `${overdue ? "Overdue" : "Due"} ${formatDateTime(task.dueAt)}` : "No due date"}
          </span>
          {task.updatedAt && <span>Updated {formatRelativeTime(task.updatedAt)}</span>}
          {task.tags.map((tag) => (
            <span key={tag} className="rounded bg-secondary px-1.5 py-0.5">{tag}</span>
          ))}
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-2">
        <Select
          value={task.status}
          onValueChange={changeStatus}
          disabled={pending}
          open={statusOpen}
          onOpenChange={setStatusOpen}
        >
          <SelectTrigger
            className="h-9 w-[9rem]"
            aria-label={`Status of ${task.name}`}
            style={task.statusColor ? { color: task.statusColor } : undefined}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <SelectValue />}
          </SelectTrigger>
          <SelectContent>
            {statuses.isLoading ? (
              <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading statuses…
              </div>
            ) : (
              // Until the real options arrive, the current status is the only
              // safe value to offer -- Select needs it present to render at all.
              (statuses.data ?? [{ status: task.status, type: task.statusType, color: null, orderindex: 0 }]).map((s) => (
                <SelectItem key={s.status} value={s.status}>
                  {s.status}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>

        <div className="flex -space-x-1.5">
          {task.assignees.length === 0 ? (
            <span className="rounded-full bg-warning/10 px-2 py-1 text-[10px] font-medium text-warning">
              Unassigned
            </span>
          ) : (
            task.assignees.slice(0, 3).map((a) => (
              <Avatar key={a.id} className="size-7 ring-2 ring-card" title={a.name}>
                <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                  {a.initials || initials(a.name)}
                </AvatarFallback>
              </Avatar>
            ))
          )}
        </div>

        <button
          type="button"
          onClick={() => onOpen(task)}
          aria-label={`Open "${task.name}" for editing`}
          className="focus-clear rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <MessageSquare className="size-4" />
        </button>

        {task.url && (
          <a
            href={task.url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`View "${task.name}" on clickup.com`}
            className="focus-clear rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <ExternalLink className="size-4" />
          </a>
        )}
      </div>
    </div>
  );
}
