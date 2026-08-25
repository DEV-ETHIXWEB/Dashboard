import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Trash2, Send, ExternalLink } from "lucide-react";
import {
  useAddClickUpComment, useClickUpComments, useClickUpListStatuses, useClickUpMembers,
  useCreateClickUpTask, useDeleteClickUpTask, useUpdateClickUpTask,
} from "@/hooks/useIntegrations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { formatRelativeTime, initials, parseLocalISO, toLocalISO } from "@/lib/format";
import { impactFeedback } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { PRIORITY_OPTIONS, type ClickUpTask, type ClickUpTaskInput } from "@/lib/integrations";

const NO_PRIORITY = "__none__";

interface FormState {
  name: string;
  description: string;
  status: string;
  priority: string;
  due: string;
  assignees: string[];
}

const EMPTY_FORM: FormState = { name: "", description: "", status: "", priority: NO_PRIORITY, due: "", assignees: [] };

function formFromTask(task: ClickUpTask): FormState {
  return {
    name: task.name,
    description: "",
    status: task.status,
    priority: task.priorityLabel ? task.priorityLabel.toLowerCase() : NO_PRIORITY,
    due: task.dueAt ? toLocalISO(new Date(task.dueAt)) : "",
    assignees: task.assignees.map((a) => a.id),
  };
}

/** Shared name/status/priority/due/assignee controls for both dialogs. */
function TaskFields({
  form,
  setForm,
  listId,
  showDescription,
}: {
  form: FormState;
  setForm: (next: FormState) => void;
  listId: string | null;
  showDescription: boolean;
}) {
  const statuses = useClickUpListStatuses(listId);
  const members = useClickUpMembers();

  function toggleAssignee(id: string) {
    setForm({
      ...form,
      assignees: form.assignees.includes(id)
        ? form.assignees.filter((a) => a !== id)
        : [...form.assignees, id],
    });
  }

  return (
    // Wide layout: what the task is on the left, how it is routed on the right.
    <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
      <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="cu-name">Task name</Label>
        <Input
          id="cu-name"
          className="h-11"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="What needs doing?"
          required
        />
      </div>

      {showDescription && (
        <div className="space-y-1.5">
          <Label htmlFor="cu-description">Description</Label>
          <Textarea
            id="cu-description"
            rows={5}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Extra context for whoever picks this up."
          />
        </div>
      )}
      </div>

      <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="cu-status">Status</Label>
          <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v ?? "" })}>
            <SelectTrigger id="cu-status" className="h-11">
              <SelectValue placeholder="Pick a status" />
            </SelectTrigger>
            <SelectContent>
              {(statuses.data ?? []).map((s) => (
                <SelectItem key={s.status} value={s.status}>{s.status}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cu-priority">Priority</Label>
          <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v ?? NO_PRIORITY })}>
            <SelectTrigger id="cu-priority" className="h-11">
              {/* Base UI renders the raw value unless given a mapper, which
                  would leak the "__none__" sentinel into the trigger. */}
              <SelectValue className="capitalize">
                {(value) => (value === NO_PRIORITY || !value ? "None" : String(value))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PRIORITY}>None</SelectItem>
              {PRIORITY_OPTIONS.map((p) => (
                <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cu-due">Due date</Label>
          <DatePicker id="cu-due" value={form.due} onChange={(v) => setForm({ ...form, due: v })} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Assignees</Label>
        {members.isLoading ? (
          <Skeleton className="h-10 w-full rounded-lg" />
        ) : (members.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No workspace members found.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {(members.data ?? []).map((member) => {
              const active = form.assignees.includes(member.id);
              return (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => toggleAssignee(member.id)}
                  aria-pressed={active}
                  className={cn(
                    "focus-clear flex items-center gap-1.5 rounded-full py-1.5 pr-3 pl-1.5 text-sm ring-1 transition-colors",
                    active
                      ? "bg-primary/10 font-medium text-primary ring-primary/30"
                      : "bg-card text-foreground/80 ring-foreground/10 hover:bg-secondary",
                  )}
                >
                  <Avatar className="size-6">
                    <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                      {member.initials || initials(member.name)}
                    </AvatarFallback>
                  </Avatar>
                  {member.name}
                </button>
              );
            })}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

/** Translate the form back into the API's field names. */
function toInput(form: FormState, showDescription: boolean): ClickUpTaskInput {
  const dueDate = form.due ? parseLocalISO(form.due) : null;
  return {
    name: form.name.trim(),
    ...(showDescription ? { description: form.description } : {}),
    status: form.status || undefined,
    priority: form.priority === NO_PRIORITY ? null : (form.priority as ClickUpTaskInput["priority"]),
    dueAt: dueDate ? dueDate.getTime() : null,
    assignees: form.assignees,
  };
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  listId,
  listName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listId: string;
  listName: string;
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const createTask = useCreateClickUpTask();

  useEffect(() => {
    if (open) setForm(EMPTY_FORM);
  }, [open]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    createTask.mutate(
      { listId, input: toInput(form, true) },
      {
        onSuccess: ({ task }) => {
          toast.success(`Created "${task.name}"`);
          onOpenChange(false);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create the task"),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="scrollbar-slim max-h-[90svh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>New task in {listName}</DialogTitle>
          <DialogDescription>This creates the task in ClickUp straight away.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <TaskFields form={form} setForm={setForm} listId={listId} showDescription />
          <DialogFooter>
            <Button type="button" variant="outline" className="h-11" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="h-11 gap-2" disabled={createTask.isPending || !form.name.trim()}>
              {createTask.isPending && <Loader2 className="size-4 animate-spin" />}
              Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TaskEditorDialog({
  task,
  onClose,
}: {
  task: ClickUpTask | null;
  onClose: () => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [comment, setComment] = useState("");

  const updateTask = useUpdateClickUpTask();
  const deleteTask = useDeleteClickUpTask();
  const addComment = useAddClickUpComment();
  const comments = useClickUpComments(task?.id ?? null);

  useEffect(() => {
    if (task) {
      setForm(formFromTask(task));
      setConfirmDelete(false);
      setComment("");
    }
  }, [task]);

  if (!task) return null;

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!task) return;
    // Assignees the user unticked have to be sent explicitly -- ClickUp treats
    // the update as an add/remove diff, not a replacement.
    const removeAssignees = task.assignees.map((a) => a.id).filter((id) => !form.assignees.includes(id));
    updateTask.mutate(
      { taskId: task.id, input: { ...toInput(form, false), removeAssignees } },
      {
        onSuccess: () => {
          toast.success("Task updated");
          onClose();
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update the task"),
      },
    );
  }

  function remove() {
    if (!task) return;
    // The second press of a two-press delete: the point of no return, and the
    // only tap in this dialog that earns the heavy one.
    impactFeedback();
    deleteTask.mutate(task.id, {
      onSuccess: () => {
        toast.success("Task deleted in ClickUp");
        onClose();
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not delete the task"),
    });
  }

  function postComment(e: React.FormEvent) {
    e.preventDefault();
    if (!task || !comment.trim()) return;
    addComment.mutate(
      { taskId: task.id, text: comment },
      {
        onSuccess: () => setComment(""),
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not post the comment"),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="scrollbar-slim max-h-[90svh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="pr-8">{task.name}</DialogTitle>
          <DialogDescription>
            {task.folderName ? `${task.folderName} / ${task.listName}` : task.listName} · changes save to ClickUp
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={save} className="space-y-4">
          <TaskFields form={form} setForm={setForm} listId={task.listId} showDescription={false} />
          <Separator />

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
            <div className="flex items-center gap-2">
              {confirmDelete ? (
                <>
                  <Button
                    type="button"
                    variant="destructive"
                    className="h-11 gap-2"
                    onClick={remove}
                    disabled={deleteTask.isPending}
                  >
                    {deleteTask.isPending && <Loader2 className="size-4 animate-spin" />}
                    Delete for good
                  </Button>
                  <Button type="button" variant="ghost" className="h-11" onClick={() => setConfirmDelete(false)}>
                    Keep it
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="size-4" />
                  Delete
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              {task.url && (
                <a
                  href={task.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="focus-clear inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <ExternalLink className="size-4" />
                  ClickUp
                </a>
              )}
              <Button type="submit" className="h-11 gap-2" disabled={updateTask.isPending || !form.name.trim()}>
                {updateTask.isPending && <Loader2 className="size-4 animate-spin" />}
                Save changes
              </Button>
            </div>
          </DialogFooter>
        </form>

        <section className="border-t border-border pt-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Comments</h3>

          {comments.isLoading ? (
            <Skeleton className="h-20 w-full rounded-lg" />
          ) : (comments.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No comments on this task yet.</p>
          ) : (
            <ul className="space-y-2">
              {(comments.data ?? []).map((c) => (
                <li key={c.id} className="flex gap-2.5 rounded-lg bg-secondary/40 p-3">
                  <Avatar className="size-7 shrink-0">
                    <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                      {c.authorInitials || initials(c.authorName)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium">{c.authorName}</span>
                      <span className="text-xs text-muted-foreground">{formatRelativeTime(c.createdAt)}</span>
                    </div>
                    <p className="mt-0.5 text-sm whitespace-pre-wrap text-foreground/90">{c.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={postComment} className="mt-3 flex gap-2">
            <Input
              className="h-11"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Write a comment…"
              aria-label="New comment"
            />
            <Button type="submit" className="h-11 gap-2" disabled={addComment.isPending || !comment.trim()}>
              {addComment.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              Post
            </Button>
          </form>
        </section>
      </DialogContent>
    </Dialog>
  );
}
