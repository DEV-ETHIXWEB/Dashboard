import { useState } from "react";
import { toast } from "sonner";
import { FolderKanban, Search, Plus, Pencil, Trash2, Loader2, X } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useProjects, useUsers, useCreateProject, useUpdateProject, useDeleteProject } from "@/hooks/useData";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { MoneyPanel, DataList, DataRow, BentoGrid, BentoColumns, bento } from "@/components/money/Money";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter, DialogTrigger, DialogClose,
} from "@/components/ui/dialog";
import { plainDate } from "@/lib/money";
import type { Project } from "@/lib/entities";

const STATUSES = ["On Track", "At Risk", "Delayed", "Complete"];

export default function Projects() {
  const { user } = useAuth();
  const { data: projects, isLoading, isError, error, refetch } = useProjects();
  const { data: users } = useUsers();
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();

  const canManage = user != null && ["admin", "sales", "project_manager"].includes(user.role);
  const canDelete = user?.role === "admin";
  const clients = (users ?? []).filter((u) => u.role === "client");
  const pms = (users ?? []).filter((u) => u.role === "project_manager");

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [clientId, setClientId] = useState("");
  const [assignedPmId, setAssignedPmId] = useState("");
  const [status, setStatus] = useState("On Track");
  const [description, setDescription] = useState("");

  function openCreate() {
    setEditing(null);
    setName("");
    setType("");
    setClientId(clients[0]?.id ?? "");
    setAssignedPmId("");
    setStatus("On Track");
    setDescription("");
    setOpen(true);
  }

  function openEdit(p: Project) {
    setEditing(p);
    setName(p.name);
    setType(p.type);
    setClientId(p.clientId);
    setAssignedPmId(p.assignedPmId ?? "");
    setStatus(p.status);
    setDescription(p.description);
    setOpen(true);
  }

  function submit() {
    if (!name.trim()) {
      toast.error("Project name is required");
      return;
    }
    if (editing) {
      updateProject.mutate(
        { id: editing.id, patch: { name, type, assignedPmId: assignedPmId || null, status, description } },
        {
          onSuccess: () => {
            toast.success("Project updated");
            setOpen(false);
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to update project"),
        },
      );
    } else {
      if (!clientId) {
        toast.error("Select a client");
        return;
      }
      createProject.mutate(
        { name, type: type || "General", clientId, assignedPmId: assignedPmId || null, status, description },
        {
          onSuccess: () => {
            toast.success("Project created");
            setOpen(false);
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to create project"),
        },
      );
    }
  }

  function remove(p: Project) {
    if (!window.confirm(`Delete "${p.name}"? This also removes its tasks and cannot be undone.`)) return;
    deleteProject.mutate(p.id, {
      onSuccess: () => toast.success("Project deleted"),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to delete project"),
    });
  }

  const clientName = (id: string) => users?.find((u) => u.id === id)?.name ?? "Unknown";
  const filtered = (projects ?? []).filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));
  const active = filtered.filter((p) => p.status !== "Complete");
  const complete = filtered.filter((p) => p.status === "Complete");

  function rowActions(p: Project) {
    if (!canManage) return undefined;
    return (
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="icon-xs" aria-label={`Edit ${p.name}`} className="hover:bg-primary/10 hover:text-primary" onClick={() => openEdit(p)}>
          <Pencil aria-hidden className="size-3.5" />
        </Button>
        {canDelete && (
          <Button variant="ghost" size="icon-xs" aria-label={`Delete ${p.name}`} className="hover:bg-destructive/10 hover:text-destructive text-destructive/80" onClick={() => remove(p)}>
            <Trash2 aria-hidden className="size-3.5" />
          </Button>
        )}
      </div>
    );
  }

  return (
    <BentoGrid className="mx-auto w-full max-w-6xl">
      <div className={bento(4)}>
        <PageHeader
          title="Projects"
          description="Delivery status and progress across every piece of work."
          actions={
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <div className="relative w-full sm:w-64">
                <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search projects…"
                  aria-label="Search projects"
                  className="h-10 pl-9"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              {canManage && (
                <Dialog open={open} onOpenChange={setOpen}>
                  <DialogTrigger render={<Button onClick={openCreate} className="h-10 shrink-0 px-4 gap-2 font-medium" />}>
                    <Plus className="size-4" /> Add Project
                  </DialogTrigger>
                  <DialogContent
                    showCloseButton={false}
                    className="sm:max-w-md p-0 gap-0 overflow-hidden border border-border/60 shadow-2xl rounded-2xl bg-card"
                  >
                    <div className="relative p-6 pb-4 border-b border-border/40 bg-gradient-to-br from-primary/10 via-background to-background">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-xs">
                            <FolderKanban className="size-5" />
                          </div>
                          <div>
                            <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
                              {editing ? "Edit Project" : "Add New Project"}
                            </DialogTitle>
                            <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                              {editing ? "Update details for this project." : "Create a new project for a client."}
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
                        <Label className="text-xs font-medium">Project Name *</Label>
                        <Input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="e.g. Website Redesign"
                          className="bg-background/50 border-border/60"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Client *</Label>
                        <Select
                          items={Object.fromEntries(clients.map((c) => [c.id, c.company || c.name]))}
                          value={clientId}
                          onValueChange={(v) => setClientId(v ?? "")}
                          disabled={Boolean(editing)}
                        >
                          <SelectTrigger className="w-full bg-background/50 border-border/60">
                            <SelectValue placeholder="Select client" />
                          </SelectTrigger>
                          <SelectContent>
                            {clients.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.company || c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium">Type</Label>
                          <Input
                            value={type}
                            onChange={(e) => setType(e.target.value)}
                            placeholder="e.g. Website"
                            className="bg-background/50 border-border/60"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium">Status</Label>
                          <Select
                            items={Object.fromEntries(STATUSES.map((s) => [s, s]))}
                            value={status}
                            onValueChange={(v) => setStatus(v ?? "On Track")}
                          >
                            <SelectTrigger className="w-full bg-background/50 border-border/60">
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
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Project Manager</Label>
                        <Select
                          items={{ "": "Unassigned", ...Object.fromEntries(pms.map((p) => [p.id, p.name])) }}
                          value={assignedPmId}
                          onValueChange={(v) => setAssignedPmId(v ?? "")}
                        >
                          <SelectTrigger className="w-full bg-background/50 border-border/60">
                            <SelectValue placeholder="Unassigned" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="">Unassigned</SelectItem>
                            {pms.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Description</Label>
                        <Textarea
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          placeholder="What is this project about?"
                          rows={3}
                          className="bg-background/50 border-border/60 resize-none"
                        />
                      </div>
                    </div>

                    <DialogFooter className="m-0 px-6 py-4 bg-muted/30 border-t border-border/40 flex flex-row items-center justify-end gap-2.5 rounded-b-2xl">
                      <DialogClose render={<Button variant="ghost" className="h-9 text-xs px-3.5 text-muted-foreground hover:text-foreground" />}>
                        Cancel
                      </DialogClose>
                      <Button
                        onClick={submit}
                        disabled={createProject.isPending || updateProject.isPending || !name.trim()}
                        className="h-9 px-4 text-xs font-medium gap-1.5 shadow-xs"
                      >
                        {createProject.isPending || updateProject.isPending ? (
                          <>
                            <Loader2 className="size-3.5 animate-spin" />
                            Saving…
                          </>
                        ) : editing ? (
                          "Save changes"
                        ) : (
                          "Add project"
                        )}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}
            </div>
          }
        />
      </div>

      {isLoading ? (
        <Skeleton className={`h-64 w-full rounded-2xl ${bento(4)}`} />
      ) : isError ? (
        <div className={bento(4)}>
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      ) : filtered.length === 0 ? (
        <div className={bento(4)}>
          <EmptyState
            icon={FolderKanban}
            title="No projects found"
            description="Projects assigned to you will show up here once created."
          />
        </div>
      ) : (
        <div className={bento(4)}>
          <BentoColumns
            items={[
              {
                key: "active",
                node: (
                  <MoneyPanel
                    title="In progress"
                    subtitle={`${active.length} ${active.length === 1 ? "project" : "projects"}`}
                  >
                    {active.length === 0 ? (
                      <p className="py-1 text-sm text-muted-foreground">Nothing in progress right now.</p>
                    ) : (
                      <DataList>
                        {active.map((p) => (
                          <DataRow
                            key={p.id}
                            title={p.name}
                            meta={`${p.type} · ${clientName(p.clientId)} · Started ${plainDate(p.createdAt)}`}
                            status={p.status}
                            progress={{ pct: p.progress.pct, label: `${p.progress.pct}%` }}
                            action={rowActions(p)}
                          />
                        ))}
                      </DataList>
                    )}
                  </MoneyPanel>
                ),
              },
              {
                key: "complete",
                node: (
                  <MoneyPanel
                    title="Finished"
                    subtitle={`${complete.length} ${complete.length === 1 ? "project" : "projects"}`}
                  >
                    {complete.length === 0 ? (
                      <p className="py-1 text-sm text-muted-foreground">Nothing finished yet.</p>
                    ) : (
                      <DataList>
                        {complete.map((p) => (
                          <DataRow
                            key={p.id}
                            title={p.name}
                            meta={`${p.type} · ${clientName(p.clientId)} · Started ${plainDate(p.createdAt)}`}
                            status={p.status}
                            action={rowActions(p)}
                          />
                        ))}
                      </DataList>
                    )}
                  </MoneyPanel>
                ),
              },
            ]}
          />
        </div>
      )}
    </BentoGrid>
  );
}
