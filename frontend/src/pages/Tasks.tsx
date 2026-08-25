import { useState, useMemo } from "react";
import { toast } from "sonner";
import {
  ListChecks,
  Plus,
  Pencil,
  Trash2,
  Search,
  Calendar,
  Folder,
  Loader2,
  X,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useTasks, useProjects, useUsers, useCreateTask, useUpdateTask, useDeleteTask } from "@/hooks/useData";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { formatDate, initials } from "@/lib/format";
import type { Task } from "@/lib/entities";
import { impactFeedback } from "@/lib/haptics";

const PRIORITIES = ["Low", "Medium", "High"];
const STATUSES = ["To Do", "In Progress", "In Review", "Complete"];

export default function Tasks() {
  const { user } = useAuth();
  const { data: tasks, isLoading, isError, error, refetch } = useTasks();
  const { data: projects } = useProjects();
  const { data: users } = useUsers();
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const canManage = user && ["admin", "project_manager"].includes(user.role);
  const employees = (users ?? []).filter((u) => u.role === "employee");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [priority, setPriority] = useState("Medium");
  const [due, setDue] = useState("");

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");

  function openCreate() {
    setEditing(null);
    setName("");
    setProjectId(projects?.[0]?.id ?? "");
    setAssigneeId("");
    setPriority("Medium");
    setDue("");
    setOpen(true);
  }

  function openEdit(t: Task) {
    setEditing(t);
    setName(t.name);
    setProjectId(t.projectId);
    setAssigneeId(t.assigneeId ?? "");
    setPriority(t.priority);
    setDue(t.due ? t.due.slice(0, 10) : "");
    setOpen(true);
  }

  function submit() {
    if (!name.trim()) {
      toast.error("Task name is required");
      return;
    }
    const patch = {
      name,
      assigneeId: assigneeId || null,
      priority,
      due: due ? new Date(due).toISOString() : null,
    };
    if (editing) {
      updateTask.mutate(
        { id: editing.id, patch },
        {
          onSuccess: () => {
            toast.success("Task updated");
            setOpen(false);
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to update task"),
        },
      );
    } else {
      if (!projectId) {
        toast.error("Select a project");
        return;
      }
      createTask.mutate(
        { projectId, ...patch },
        {
          onSuccess: () => {
            toast.success("Task added");
            setOpen(false);
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to add task"),
        },
      );
    }
  }

  function changeStatus(id: string, status: string) {
    updateTask.mutate(
      { id, patch: { status } },
      {
        onSuccess: () => toast.success("Task status updated"),
        onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to update task"),
      },
    );
  }

  function remove(t: Task) {
    if (!window.confirm(`Delete "${t.name}"? This action cannot be undone.`)) return;

    // Confirmed, and this one does not come back. The heavy tap marks the

    // moment the decision was actually taken.

    impactFeedback();
    deleteTask.mutate(t.id, {
      onSuccess: () => toast.success("Task deleted"),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to delete task"),
    });
  }

  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name ?? "Unknown";
  const assignee = (id: string | null) => users?.find((u) => u.id === id);

  const filteredTasks = useMemo(() => {
    return (tasks ?? []).filter((t) => {
      const matchSearch =
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        projectName(t.projectId).toLowerCase().includes(search.toLowerCase());
      const matchStatus = statusFilter === "All" || t.status === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [tasks, search, statusFilter, projects]);

  const priorityBadge = (p: string) => {
    switch (p.toLowerCase()) {
      case "high":
        return "bg-red-500/10 text-red-400 border-red-500/20";
      case "medium":
        return "bg-amber-500/10 text-amber-400 border-amber-500/20";
      default:
        return "bg-blue-500/10 text-blue-400 border-blue-500/20";
    }
  };

  const statusBadgeColor = (s: string) => {
    switch (s) {
      case "Complete":
        return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
      case "In Review":
        return "bg-purple-500/10 text-purple-400 border-purple-500/20";
      case "In Progress":
        return "bg-amber-500/10 text-amber-400 border-amber-500/20";
      default:
        return "bg-muted text-muted-foreground border-border/40";
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title="Tasks"
        description="Track and manage work items linked to your active projects."
        actions={
          canManage ? (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger render={<Button onClick={openCreate} className="h-10 px-4 gap-2 font-medium" />}>
                <Plus className="size-4" /> Add Task
              </DialogTrigger>
              <DialogContent
                showCloseButton={false}
                className="sm:max-w-md p-0 gap-0 overflow-hidden border border-border/60 shadow-2xl rounded-2xl bg-card"
              >
                <div className="relative p-6 pb-4 border-b border-border/40 bg-gradient-to-br from-primary/10 via-background to-background">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-xs">
                        <ListChecks className="size-5" />
                      </div>
                      <div>
                        <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
                          {editing ? "Edit Task" : "Add New Task"}
                        </DialogTitle>
                        <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                          {editing ? "Update details for this task." : "Assign a task to a project and team member."}
                        </DialogDescription>
                      </div>
                    </div>
                    <DialogClose className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors">
                      <X className="size-4" />
                    </DialogClose>
                  </div>
                </div>

                <div className="no-scrollbar max-h-[72svh] space-y-4 overflow-y-auto overscroll-contain p-6">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Task Name *</Label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Redesign checkout wireframes"
                      className="bg-background/50 border-border/60"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Project *</Label>
                    <Select
                      items={Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]))}
                      value={projectId}
                      onValueChange={(v) => setProjectId(v ?? "")}
                      disabled={Boolean(editing)}
                    >
                      <SelectTrigger className="w-full bg-background/50 border-border/60">
                        <SelectValue placeholder="Select project" />
                      </SelectTrigger>
                      <SelectContent>
                        {(projects ?? []).map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">Assignee</Label>
                      <Select
                        items={{ "": "Unassigned", ...Object.fromEntries(employees.map((e) => [e.id, e.name])) }}
                        value={assigneeId}
                        onValueChange={(v) => setAssigneeId(v ?? "")}
                      >
                        <SelectTrigger className="w-full bg-background/50 border-border/60">
                          <SelectValue placeholder="Unassigned" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">Unassigned</SelectItem>
                          {employees.map((e) => (
                            <SelectItem key={e.id} value={e.id}>
                              {e.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">Priority</Label>
                      <Select
                        items={Object.fromEntries(PRIORITIES.map((p) => [p, p]))}
                        value={priority}
                        onValueChange={(v) => setPriority(v ?? "Medium")}
                      >
                        <SelectTrigger className="w-full bg-background/50 border-border/60">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PRIORITIES.map((p) => (
                            <SelectItem key={p} value={p}>
                              {p}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Due Date</Label>
                    <Input
                      type="date"
                      value={due}
                      onChange={(e) => setDue(e.target.value)}
                      className="bg-background/50 border-border/60"
                    />
                  </div>
                </div>

                <DialogFooter className="m-0 px-6 py-4 bg-muted/30 border-t border-border/40 flex flex-row items-center justify-end gap-2.5 rounded-b-2xl">
                  <DialogClose render={<Button variant="ghost" className="h-9 text-xs px-3.5 text-muted-foreground hover:text-foreground" />}>
                    Cancel
                  </DialogClose>
                  <Button
                    onClick={submit}
                    disabled={createTask.isPending || updateTask.isPending || !name.trim()}
                    className="h-9 px-4 text-xs font-medium gap-1.5 shadow-xs"
                  >
                    {createTask.isPending || updateTask.isPending ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" />
                        Saving…
                      </>
                    ) : (
                      editing ? "Save changes" : "Add task"
                    )}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : undefined
        }
      />

      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-1.5 bg-card/60 border border-border/60 rounded-xl backdrop-blur-xs">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks or projects..."
            className="pl-9 h-9 border-none bg-transparent focus-visible:ring-0 text-xs"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 w-full sm:w-auto overflow-x-auto no-scrollbar">
          {["All", ...STATUSES].map((st) => {
            const isSelected = statusFilter === st;
            const count = (tasks ?? []).filter((t) => st === "All" || t.status === st).length;
            return (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium whitespace-nowrap transition-all coarse:min-h-9 coarse:px-3.5 ${
                  isSelected
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                }`}
              >
                <span>{st}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                    isSelected ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : filteredTasks.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title={search || statusFilter !== "All" ? "No matching tasks" : "No tasks yet"}
          description={
            search || statusFilter !== "All"
              ? "Try adjusting your search or status filter."
              : "Tasks assigned to your projects will show up here."
          }
        />
      ) : (
        <>
          {/* A six-column table cannot be read on a 375px screen, and shrinking
              it just makes six unreadable columns. Below md the same rows are
              cards instead: the task and its status lead, the rest follows as
              one line of context. */}
          <ul className="space-y-2 md:hidden">
            {filteredTasks.map((t) => {
              const a = assignee(t.assigneeId);
              const canEditStatus = canManage || (user?.role === "employee" && t.assigneeId === user.id);
              return (
                <li
                  key={t.id}
                  className="rounded-2xl border border-border/60 bg-card/80 p-3.5 shadow-sm"
                >
                  <div className="flex items-start gap-2">
                    <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-primary/80" />
                    <p className="min-w-0 flex-1 text-[15px] leading-snug font-semibold">{t.name}</p>
                    <span
                      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${priorityBadge(t.priority)}`}
                    >
                      {t.priority}
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Folder aria-hidden className="size-3.5 shrink-0 text-primary/70" />
                      <span className="truncate">{projectName(t.projectId)}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Calendar aria-hidden className="size-3.5 shrink-0" />
                      {formatDate(t.due)}
                    </span>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    {a ? (
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <Avatar className="size-6 shrink-0 ring-1 ring-border">
                          <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                            {initials(a.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="truncate text-xs font-medium text-foreground/90">{a.name}</span>
                      </span>
                    ) : (
                      <span className="flex-1 text-xs text-muted-foreground italic">Unassigned</span>
                    )}

                    {canEditStatus ? (
                      <Select
                        items={Object.fromEntries(STATUSES.map((x) => [x, x]))}
                        value={t.status}
                        onValueChange={(v) => changeStatus(t.id, v ?? "To Do")}
                      >
                        <SelectTrigger size="sm" className="h-9 w-32 shrink-0 border-border/60 bg-background/50 text-xs font-medium">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STATUSES.map((x) => (
                            <SelectItem key={x} value={x}>
                              {x}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span
                        className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${statusBadgeColor(t.status)}`}
                      >
                        {t.status}
                      </span>
                    )}
                  </div>

                  {canManage && (
                    <div className="mt-2 flex items-center justify-end gap-1 border-t border-border/40 pt-2">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Edit ${t.name}`}
                        className="hover:bg-primary/10 hover:text-primary"
                        onClick={() => openEdit(t)}
                      >
                        <Pencil aria-hidden className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete ${t.name}`}
                        className="text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => remove(t)}
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

        <div className="hidden overflow-hidden rounded-2xl border border-border/60 bg-card/80 shadow-sm backdrop-blur-xs md:block">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow className="border-border/50 hover:bg-transparent">
                <TableHead className="text-xs uppercase font-semibold text-muted-foreground">Task</TableHead>
                <TableHead className="text-xs uppercase font-semibold text-muted-foreground">Project</TableHead>
                <TableHead className="text-xs uppercase font-semibold text-muted-foreground">Assignee</TableHead>
                <TableHead className="text-xs uppercase font-semibold text-muted-foreground">Priority</TableHead>
                <TableHead className="text-xs uppercase font-semibold text-muted-foreground">Due Date</TableHead>
                <TableHead className="text-xs uppercase font-semibold text-muted-foreground text-right">Status</TableHead>
                {canManage && <TableHead className="w-20" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTasks.map((t) => {
                const a = assignee(t.assigneeId);
                const canEditStatus = canManage || (user?.role === "employee" && t.assigneeId === user.id);
                return (
                  <TableRow key={t.id} className="border-border/40 hover:bg-muted/30 transition-colors">
                    <TableCell className="font-semibold text-foreground text-sm">
                      <div className="flex items-center gap-2">
                        <span className="size-2 rounded-full bg-primary/80 shrink-0" />
                        <span>{t.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <Folder className="size-3.5 text-primary/70 shrink-0" />
                        <span className="truncate max-w-[180px]">{projectName(t.projectId)}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {a ? (
                        <div className="flex items-center gap-2">
                          <Avatar className="size-6 shrink-0 ring-1 ring-border">
                            <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                              {initials(a.name)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="text-xs font-medium text-foreground/90">{a.name}</span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">Unassigned</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${priorityBadge(t.priority)}`}>
                        • {t.priority}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <Calendar className="size-3.5 text-muted-foreground shrink-0" />
                        <span>{formatDate(t.due)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {canEditStatus ? (
                        <Select
                          items={Object.fromEntries(STATUSES.map((s) => [s, s]))}
                          value={t.status}
                          onValueChange={(v) => changeStatus(t.id, v ?? "To Do")}
                        >
                          <SelectTrigger size="sm" className="ml-auto h-8 w-32 bg-background/50 border-border/60 text-xs font-medium">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STATUSES.map((s) => (
                              <SelectItem key={s} value={s}>
                                {s}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${statusBadgeColor(t.status)}`}>
                          {t.status}
                        </span>
                      )}
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon-xs" aria-label={`Edit ${t.name}`} className="hover:bg-primary/10 hover:text-primary" onClick={() => openEdit(t)}>
                            <Pencil aria-hidden className="size-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon-xs" aria-label={`Delete ${t.name}`} className="hover:bg-destructive/10 hover:text-destructive text-destructive/80" onClick={() => remove(t)}>
                            <Trash2 aria-hidden className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        </>
      )}
    </div>
  );
}
