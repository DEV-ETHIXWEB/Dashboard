import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ListTodo, AlarmClock, CalendarClock, UserX, RotateCw, ChevronRight, ChevronDown,
  Layers, Search, Loader2, Plus, Ticket as TicketIcon, Building2,
} from "lucide-react";
import {
  useClickUpOverview, useClickUpTree, useClickUpListTasks, useIntegrationStatus, useRefreshIntegration,
} from "@/hooks/useIntegrations";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { IntegrationNotConnected } from "@/components/IntegrationNotConnected";
import { TaskRow } from "@/components/clickup/TaskRow";
import { CreateTaskDialog, TaskEditorDialog } from "@/components/clickup/TaskDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRelativeTime, initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BUCKET_LABELS, type ClickUpBucket, type ClickUpTask } from "@/lib/integrations";

/** How many rows a list shows before you have to ask for more. */
const PAGE_SIZE = 20;

const BUCKET_TONE: Record<ClickUpBucket, string> = {
  overdue: "bg-destructive/10 text-destructive ring-destructive/20",
  due_today: "bg-warning/10 text-warning ring-warning/20",
  due_this_week: "bg-primary/10 text-primary ring-primary/20",
  later: "bg-secondary text-muted-foreground ring-foreground/10",
  no_due_date: "bg-secondary text-muted-foreground ring-foreground/10",
};

/** The page's standard surface: matches the cards used across the dashboard. */
function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-2xl bg-card ring-1 ring-foreground/10", className)}>{children}</div>;
}

// --- Priority filter -------------------------------------------------------

/** "none" covers tasks ClickUp left without a priority at all. */
type PriorityKey = "urgent" | "high" | "normal" | "low" | "none";

const PRIORITY_FILTERS: { key: PriorityKey; label: string; tone: string }[] = [
  { key: "urgent", label: "Urgent", tone: "bg-destructive/10 text-destructive ring-destructive/20" },
  { key: "high", label: "High", tone: "bg-warning/10 text-warning ring-warning/20" },
  { key: "normal", label: "Normal", tone: "bg-primary/10 text-primary ring-primary/20" },
  { key: "low", label: "Low", tone: "bg-secondary text-foreground ring-foreground/15" },
  { key: "none", label: "No priority", tone: "bg-secondary text-foreground ring-foreground/15" },
];

function priorityOf(task: ClickUpTask): PriorityKey {
  return (task.priorityLabel?.toLowerCase() as PriorityKey) || "none";
}

/**
 * Multi-select priority chips. Nothing selected means "show everything", which
 * keeps the common case one glance rather than one click.
 */
function PriorityFilter({
  tasks,
  selected,
  onChange,
}: {
  tasks: ClickUpTask[];
  selected: PriorityKey[];
  onChange: (next: PriorityKey[]) => void;
}) {
  const counts = useMemo(() => {
    const map = {} as Record<PriorityKey, number>;
    for (const task of tasks) {
      const key = priorityOf(task);
      map[key] = (map[key] ?? 0) + 1;
    }
    return map;
  }, [tasks]);

  function toggle(key: PriorityKey) {
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="t-label text-muted-foreground">Priority</span>

      <button
        type="button"
        aria-pressed={selected.length === 0}
        onClick={() => onChange([])}
        className={cn(
          "focus-clear flex min-h-9 items-center rounded-full px-3 text-sm ring-1 transition-colors",
          selected.length === 0
            ? "bg-foreground/10 font-semibold text-foreground ring-foreground/20"
            : "bg-card text-muted-foreground ring-foreground/10 hover:bg-secondary",
        )}
      >
        All
      </button>

      {PRIORITY_FILTERS.map((option) => {
        const count = counts[option.key] ?? 0;
        const active = selected.includes(option.key);
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={active}
            disabled={count === 0}
            onClick={() => toggle(option.key)}
            className={cn(
              "focus-clear flex min-h-9 items-center gap-1.5 rounded-full px-3 text-sm ring-1 transition-colors",
              count === 0 && "cursor-not-allowed opacity-40",
              active ? cn("font-semibold", option.tone) : "bg-card text-muted-foreground ring-foreground/10 hover:bg-secondary",
            )}
          >
            {option.label}
            <span className="tabular-nums">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

function applyPriority(tasks: ClickUpTask[], selected: PriorityKey[]) {
  if (selected.length === 0) return tasks;
  return tasks.filter((t) => selected.includes(priorityOf(t)));
}

export default function ClickUpTasks() {
  const { data: status, isLoading: statusLoading } = useIntegrationStatus();
  const overview = useClickUpOverview();
  const refresh = useRefreshIntegration();

  /** The task open in the editor dialog, shared by every tab. */
  const [editing, setEditing] = useState<ClickUpTask | null>(null);

  function handleRefresh() {
    refresh.mutate("clickup", {
      onSuccess: () => toast.success("Pulled fresh data from ClickUp"),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Refresh failed"),
    });
  }

  if (statusLoading) return <Skeleton className="h-64 w-full rounded-2xl" />;

  if (!status?.clickup.connected) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader title="ClickUp" description="Run your ClickUp workspace without leaving this dashboard." />
        <IntegrationNotConnected
          name="ClickUp"
          icon={ListTodo}
          vars={[
            { key: "CLICKUP_API_TOKEN", hint: "A personal API token from ClickUp → Settings → Apps → API Token." },
            { key: "CLICKUP_TEAM_ID", hint: "Pin a specific workspace. Defaults to the first one the token can see.", optional: true },
            {
              key: "CLICKUP_TICKETS_LIST_ID",
              hint: "Mirror every ticket raised here into this ClickUp list. Open the list in ClickUp — the id is the number in the URL after /v/li/.",
              optional: true,
            },
          ]}
          steps={[
            "In ClickUp, open Settings → Apps and generate a personal API token.",
            "Add CLICKUP_API_TOKEN to the server's .env file.",
            "Restart the server and reload this page.",
          ]}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl min-w-0">
      <PageHeader
        title="ClickUp"
        description={
          overview.data
            ? `${overview.data.counts.total} open tasks · updated ${formatRelativeTime(overview.data.fetchedAt)}`
            : "Run your ClickUp workspace without leaving this dashboard."
        }
        actions={
          <Button variant="outline" className="h-11 gap-2" onClick={handleRefresh} disabled={refresh.isPending}>
            {refresh.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
            Refresh
          </Button>
        }
      />

      {!status.clickup.ticketMirroring && (
        <Panel className="mb-4 flex items-start gap-2.5 p-3.5">
          <TicketIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 text-sm text-muted-foreground">
            Tickets raised in this dashboard are not being copied into ClickUp. Set{" "}
            <code className="rounded bg-secondary px-1 font-mono text-xs">CLICKUP_TICKETS_LIST_ID</code> to the list you
            want them to land in — open that list in ClickUp and copy the number from the URL after{" "}
            <code className="rounded bg-secondary px-1 font-mono text-xs">/v/li/</code>.
          </p>
        </Panel>
      )}

      {overview.isError ? (
        <ErrorState title="Could not load ClickUp" error={overview.error} onRetry={() => overview.refetch()} />
      ) : overview.isLoading || !overview.data ? (
        <Skeleton className="h-96 w-full rounded-2xl" />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Open tasks" value={String(overview.data.counts.total)} icon={ListTodo} />
            <StatCard label="Overdue" value={String(overview.data.counts.overdue)} icon={AlarmClock} tone="danger" />
            <StatCard label="Due today" value={String(overview.data.counts.dueToday)} icon={CalendarClock} tone="warning" />
            <StatCard label="Unassigned" value={String(overview.data.counts.unassigned)} icon={UserX} tone="warning" />
          </div>

          <Tabs defaultValue="spaces">
            {/* h-11! overrides the component's default h-8 -- these three tabs
                are the page's primary navigation and need a real touch target. */}
            <TabsList className="mb-4 h-11! w-full gap-1 p-1 sm:w-fit">
              <TabsTrigger value="spaces" className="px-4">Spaces &amp; lists</TabsTrigger>
              <TabsTrigger value="urgency" className="px-4">By urgency</TabsTrigger>
              <TabsTrigger value="workload" className="px-4">Workload</TabsTrigger>
            </TabsList>

            <TabsContent value="spaces">
              <SpaceBrowser onOpenTask={setEditing} />
            </TabsContent>

            <TabsContent value="urgency">
              <UrgencyView onOpenTask={setEditing} />
            </TabsContent>

            <TabsContent value="workload">
              <WorkloadTable />
            </TabsContent>
          </Tabs>
        </>
      )}

      <TaskEditorDialog task={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

// --- Spaces & lists --------------------------------------------------------

function SpaceBrowser({ onOpenTask }: { onOpenTask: (task: ClickUpTask) => void }) {
  const tree = useClickUpTree();
  const [openSpaces, setOpenSpaces] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<{ id: string; name: string; space: string; folder?: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [navOpen, setNavOpen] = useState(false); // mobile only: the tree is a disclosure
  const [priorities, setPriorities] = useState<PriorityKey[]>([]);
  const listTasks = useClickUpListTasks(selected?.id ?? null);

  const visibleTasks = useMemo(() => applyPriority(listTasks.data ?? [], priorities), [listTasks.data, priorities]);

  // Open on the first list that actually has work in it, so the page never
  // lands on an empty list when the workspace is busy.
  useEffect(() => {
    if (selected || !tree.data) return;
    for (const pickNonEmpty of [true, false]) {
      for (const space of tree.data.spaces) {
        const entries = [
          ...space.lists.map((l) => ({ list: l, folder: undefined as string | undefined })),
          ...space.folders.flatMap((f) => f.lists.map((l) => ({ list: l, folder: f.name }))),
        ];
        const hit = pickNonEmpty ? entries.find((e) => (e.list.taskCount ?? 0) > 0) : entries[0];
        if (hit) {
          setSelected({ id: hit.list.id, name: hit.list.name, space: space.name, folder: hit.folder });
          setOpenSpaces({ [space.id]: true });
          return;
        }
      }
    }
  }, [tree.data, selected]);

  if (tree.isError) {
    return <ErrorState title="Could not load spaces" error={tree.error} onRetry={() => tree.refetch()} />;
  }
  if (tree.isLoading || !tree.data) return <Skeleton className="h-80 w-full rounded-2xl" />;

  const pick = (list: { id: string; name: string }, space: string, folder?: string) => {
    setSelected({ id: list.id, name: list.name, space, folder });
    setNavOpen(false);
  };

  const nav = (
    <div className="p-2">
      {tree.data.spaces.map((space) => {
        const isOpen = openSpaces[space.id] ?? false;
        const listCount = space.lists.length + space.folders.reduce((n, f) => n + f.lists.length, 0);

        return (
          <div key={space.id} className="mb-1 last:mb-0">
            <button
              type="button"
              onClick={() => setOpenSpaces((s) => ({ ...s, [space.id]: !isOpen }))}
              aria-expanded={isOpen}
              className="focus-clear flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-sm font-medium hover:bg-secondary"
            >
              <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", isOpen && "rotate-90")} />
              <span className="min-w-0 flex-1 truncate">{space.name}</span>
              <span className="shrink-0 numeric text-xs text-muted-foreground">{listCount}</span>
            </button>

            {isOpen && (
              <div className="mt-0.5 ml-3.5 border-l border-border pl-1.5">
                {space.lists.map((list) => (
                  <ListButton
                    key={list.id}
                    list={list}
                    active={selected?.id === list.id}
                    onSelect={() => pick(list, space.name)}
                  />
                ))}

                {/* Folders are client companies -- they're the thing you scan
                    this tree for, so they read louder than the lists inside. */}
                {space.folders.map((folder) => (
                  <div key={folder.id} className="mt-3 first:mt-1">
                    <div className="flex items-center gap-1.5 px-2 pb-1">
                      <Building2 aria-hidden className="size-3 shrink-0 text-primary" />
                      <span className="min-w-0 truncate t-label text-foreground">
                        {folder.name}
                      </span>
                      <span aria-hidden className="h-px flex-1 bg-border" />
                    </div>
                    {folder.lists.map((list) => (
                      <ListButton
                        key={list.id}
                        list={list}
                        active={selected?.id === list.id}
                        onSelect={() => pick(list, space.name, folder.name)}
                      />
                    ))}
                  </div>
                ))}

                {listCount === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">No lists</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start">
      {/* Mobile: the tree collapses so the task list stays at the top of the page. */}
      <Panel className="lg:hidden">
        <button
          type="button"
          onClick={() => setNavOpen((v) => !v)}
          aria-expanded={navOpen}
          className="focus-clear flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm"
        >
          <ChevronDown className={cn("size-4 shrink-0 transition-transform", !navOpen && "-rotate-90")} />
          <span className="min-w-0 flex-1 truncate font-medium">
            {selected ? `${selected.space} / ${selected.name}` : "Choose a list"}
          </span>
        </button>
        {navOpen && <div className="border-t border-border">{nav}</div>}
      </Panel>

      {/* Desktop: sticky tree with its own scroll, so a long workspace doesn't stretch the page. */}
      <Panel className="scrollbar-slim hidden lg:sticky lg:top-4 lg:block lg:max-h-[calc(100svh-6rem)] lg:overflow-y-auto">
        <div className="sticky top-0 z-10 rounded-t-2xl border-b border-border bg-card px-4 py-2.5 t-label text-muted-foreground">
          {tree.data.workspace.name}
        </div>
        {nav}
      </Panel>

      <div className="min-w-0">
        {!selected ? (
          <EmptyState icon={Layers} title="Pick a list" description="Choose a list to see its open tasks." />
        ) : (
          <Panel className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <p className="truncate t-label text-muted-foreground">
                  {selected.folder ? `${selected.space} / ${selected.folder}` : selected.space}
                </p>
                <h2 className="truncate text-base font-semibold tracking-tight text-foreground">{selected.name}</h2>
              </div>
              <Button className="h-10 gap-2" onClick={() => setCreating(true)}>
                <Plus className="size-4" />
                New task
              </Button>
            </div>

            {listTasks.isError ? (
              <div className="p-3">
                <ErrorState
                  title={`Could not load ${selected.name}`}
                  error={listTasks.error}
                  onRetry={() => listTasks.refetch()}
                />
              </div>
            ) : listTasks.isLoading || !listTasks.data ? (
              <Skeleton className="m-3 h-64 rounded-xl" />
            ) : listTasks.data.length === 0 ? (
              <div className="p-3">
                <EmptyState
                  icon={ListTodo}
                  title="No open tasks"
                  description={`Everything in ${selected.name} is closed.`}
                  action={
                    <Button className="mt-1 h-11 gap-2" onClick={() => setCreating(true)}>
                      <Plus className="size-4" />
                      Add the first one
                    </Button>
                  }
                />
              </div>
            ) : (
              <>
                <div className="border-b border-border px-4 py-3">
                  <PriorityFilter tasks={listTasks.data} selected={priorities} onChange={setPriorities} />
                </div>
                {visibleTasks.length === 0 ? (
                  <div className="p-3">
                    <EmptyState
                      icon={ListTodo}
                      title="Nothing at that priority"
                      description="Clear the priority filter to see the rest of this list."
                    />
                  </div>
                ) : (
                  <PagedTaskList tasks={visibleTasks} onOpenTask={onOpenTask} showLocation={false} />
                )}
              </>
            )}

            <CreateTaskDialog
              open={creating}
              onOpenChange={setCreating}
              listId={selected.id}
              listName={selected.name}
            />
          </Panel>
        )}
      </div>
    </div>
  );
}

function ListButton({
  list,
  active,
  onSelect,
}: {
  list: { id: string; name: string; taskCount: number | null };
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "focus-clear flex min-h-10 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-sm",
        active ? "bg-primary/10 font-medium text-primary" : "text-foreground/80 hover:bg-secondary",
      )}
    >
      <span className="min-w-0 truncate">{list.name}</span>
      {list.taskCount != null && (
        <span className="shrink-0 numeric text-xs text-muted-foreground">{list.taskCount}</span>
      )}
    </button>
  );
}

/** Renders a capped slice of a task list with an explicit "show more" control. */
function PagedTaskList({
  tasks,
  onOpenTask,
  showLocation = true,
}: {
  tasks: ClickUpTask[];
  onOpenTask: (task: ClickUpTask) => void;
  showLocation?: boolean;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);

  // A new filter or list means we start counting again from the top.
  useEffect(() => setLimit(PAGE_SIZE), [tasks]);

  const remaining = tasks.length - limit;

  return (
    <>
      <div className="min-w-0">
        {tasks.slice(0, limit).map((task) => (
          <TaskRow key={task.id} task={task} onOpen={onOpenTask} showLocation={showLocation} />
        ))}
      </div>

      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + PAGE_SIZE)}
          className="focus-clear w-full border-t border-border py-3 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          Show {Math.min(remaining, PAGE_SIZE)} more · {remaining} left
        </button>
      )}
    </>
  );
}

// --- Urgency ---------------------------------------------------------------

function UrgencyView({ onOpenTask }: { onOpenTask: (task: ClickUpTask) => void }) {
  const overview = useClickUpOverview();
  const [query, setQuery] = useState("");
  /** One bucket at a time -- the whole point is not scrolling past 100 rows. */
  const [bucket, setBucket] = useState<ClickUpBucket | null>(null);
  const [priorities, setPriorities] = useState<PriorityKey[]>([]);

  // Search narrows the buckets; priority narrows the bucket you're looking at.
  // Keeping them separate lets the bucket counts stay honest as you filter.
  const buckets = useMemo(() => {
    const data = overview.data;
    if (!data) return null;
    const q = query.trim().toLowerCase();
    const matches = (t: ClickUpTask) =>
      !q ||
      t.name.toLowerCase().includes(q) ||
      (t.listName ?? "").toLowerCase().includes(q) ||
      t.assignees.some((a) => a.name.toLowerCase().includes(q));

    return data.bucketOrder.map((b) => ({ bucket: b, tasks: data.buckets[b].filter(matches) }));
  }, [overview.data, query]);

  // Default to the first bucket that has anything in it (usually Overdue).
  useEffect(() => {
    if (bucket || !buckets) return;
    const first = buckets.find((b) => b.tasks.length > 0);
    if (first) setBucket(first.bucket);
  }, [buckets, bucket]);

  if (!buckets) return <Skeleton className="h-64 w-full rounded-2xl" />;

  const active = buckets.find((b) => b.bucket === bucket) ?? buckets[0];
  const total = buckets.reduce((sum, b) => sum + b.tasks.length, 0);
  const visible = applyPriority(active?.tasks ?? [], priorities);

  return (
    <div className="min-w-0 space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-11 pl-9"
          placeholder="Filter by task, list, or assignee"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter tasks"
        />
      </div>

      {/* Pick a bucket instead of scrolling through every one of them. */}
      <div role="tablist" aria-label="Urgency" className="flex min-w-0 flex-wrap gap-2">
        {buckets.map((b) => {
          const isActive = active?.bucket === b.bucket;
          return (
            <button
              key={b.bucket}
              type="button"
              role="tab"
              aria-selected={isActive}
              disabled={b.tasks.length === 0}
              onClick={() => setBucket(b.bucket)}
              className={cn(
                "focus-clear flex min-h-10 items-center gap-2 rounded-full px-3.5 text-sm ring-1 transition-colors",
                b.tasks.length === 0 && "cursor-not-allowed opacity-40",
                isActive
                  ? cn("font-semibold", BUCKET_TONE[b.bucket])
                  : "bg-card text-muted-foreground ring-foreground/10 hover:bg-secondary",
              )}
            >
              {BUCKET_LABELS[b.bucket]}
              <span className="tabular-nums">{b.tasks.length}</span>
            </button>
          );
        })}
      </div>

      {total === 0 ? (
        <EmptyState
          icon={ListTodo}
          title={query ? "No matching tasks" : "Nothing pending"}
          description={query ? "Try a different search." : "Every task in the workspace is closed."}
        />
      ) : !active || active.tasks.length === 0 ? (
        <EmptyState icon={ListTodo} title="Nothing in this bucket" description="Pick another one above." />
      ) : (
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">{BUCKET_LABELS[active.bucket]}</h2>
            <span className="numeric text-xs text-muted-foreground">
              {visible.length === active.tasks.length
                ? `${active.tasks.length} ${active.tasks.length === 1 ? "task" : "tasks"}`
                : `${visible.length} of ${active.tasks.length}`}
            </span>
          </div>

          <div className="border-b border-border px-4 py-3">
            <PriorityFilter tasks={active.tasks} selected={priorities} onChange={setPriorities} />
          </div>

          {visible.length === 0 ? (
            <div className="p-3">
              <EmptyState
                icon={ListTodo}
                title="Nothing at that priority"
                description="Clear the priority filter to see the rest of this bucket."
              />
            </div>
          ) : (
            <PagedTaskList tasks={visible} onOpenTask={onOpenTask} />
          )}
        </Panel>
      )}
    </div>
  );
}

// --- Workload --------------------------------------------------------------

function WorkloadTable() {
  const overview = useClickUpOverview();
  const workload = overview.data?.workload ?? [];

  if (workload.length === 0) return <EmptyState icon={UserX} title="No open tasks to distribute" />;

  const max = workload[0].total || 1;

  return (
    <Panel className="scrollbar-slim overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Team member</TableHead>
            <TableHead className="text-right">Open</TableHead>
            <TableHead className="text-right">Overdue</TableHead>
            <TableHead className="text-right">Due today</TableHead>
            <TableHead className="w-40">Share</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workload.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <Avatar className="size-7">
                    <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                      {row.initials || initials(row.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{row.name}</div>
                    {row.email && <div className="truncate text-xs text-muted-foreground">{row.email}</div>}
                  </div>
                </div>
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">{row.total}</TableCell>
              <TableCell className={cn("text-right tabular-nums", row.overdue > 0 && "font-semibold text-destructive")}>
                {row.overdue}
              </TableCell>
              <TableCell className="text-right tabular-nums">{row.dueToday}</TableCell>
              <TableCell>
                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-secondary"
                  role="img"
                  aria-label={`${row.name} holds ${row.total} of the workspace's open tasks`}
                >
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(row.total / max) * 100}%` }} />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}
