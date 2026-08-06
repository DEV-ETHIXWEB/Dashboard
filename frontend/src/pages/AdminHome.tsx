import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Ticket as TicketIcon, AlarmClock, ListTodo, ArrowRight, UserX, Inbox, FolderKanban,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useTickets, useUsers, useProjects } from "@/hooks/useData";
import { useMyTicketRequests, useTicketStages } from "@/hooks/useTicketWorkflow";
import { useClickUpOverview, useIntegrationStatus } from "@/hooks/useIntegrations";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { TicketTimelineDialog } from "@/components/tickets/TicketTimelineDialog";
import { formatRelativeTime, initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import { stageLabel } from "@/lib/tickets";
import type { Ticket } from "@/lib/entities";

const OPEN_STATUSES = ["Open", "In Progress"];

/** One card surface, matching the rest of the dashboard. */
function Panel({
  title,
  subtitle,
  to,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  to?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-2xl bg-card p-4 ring-1 ring-foreground/10", className)}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {to && (
          <Link
            to={to}
            className="focus-clear inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            View all
            <ArrowRight className="size-3" />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

export default function AdminHome() {
  const { user } = useAuth();
  const { data: tickets, isLoading: ticketsLoading } = useTickets();
  const { data: users } = useUsers();
  const { data: projects } = useProjects();
  const { data: stages } = useTicketStages();
  const { data: myRequests } = useMyTicketRequests();
  const { data: integrationStatus } = useIntegrationStatus();
  const clickup = useClickUpOverview();

  const [timelineId, setTimelineId] = useState<string | null>(null);

  const nameOf = useMemo(() => {
    const map = new Map((users ?? []).map((u) => [u.id, u.name]));
    return (id: string | null | undefined) => (id ? map.get(id) ?? "Unknown" : null);
  }, [users]);

  const open = useMemo(
    () => (tickets ?? []).filter((t) => OPEN_STATUSES.includes(t.status)),
    [tickets],
  );
  const unassigned = open.filter((t) => !t.assigneeId);
  const stalled = useMemo(
    // Open, assigned, but nothing recorded yet -- the ones that quietly rot.
    () => open.filter((t) => t.assigneeId && (t.progress ?? 0) === 0),
    [open],
  );

  const requestTickets = useMemo(() => {
    const byId = new Map((tickets ?? []).map((t) => [t.id, t]));
    return (myRequests ?? [])
      .map((r) => ({ request: r, ticket: byId.get(r.ticketId) }))
      .filter((x): x is { request: typeof x.request; ticket: Ticket } => Boolean(x.ticket));
  }, [myRequests, tickets]);

  return (
    <div className="mx-auto w-full max-w-7xl min-w-0">
      <PageHeader
        title={`Good to see you, ${user?.name?.split(" ")[0] ?? "there"}`}
        description="Everything that needs a decision today, in one place."
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open tickets" value={String(open.length)} icon={TicketIcon} />
        <StatCard
          label="Needs you"
          value={String(requestTickets.length)}
          icon={Inbox}
          tone={requestTickets.length > 0 ? "danger" : "default"}
        />
        <StatCard
          label="Unassigned"
          value={String(unassigned.length)}
          icon={UserX}
          tone={unassigned.length > 0 ? "warning" : "default"}
        />
        <StatCard label="Active projects" value={String(projects?.length ?? 0)} icon={FolderKanban} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Requests aimed at you come first -- they block someone else's work. */}
        <Panel
          title="Waiting on you"
          subtitle={
            requestTickets.length === 0
              ? "No handover or collaboration requests"
              : `${requestTickets.length} request${requestTickets.length === 1 ? "" : "s"} to answer`
          }
          className={cn(requestTickets.length > 0 && "ring-2 ring-destructive/30")}
        >
          {requestTickets.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">Nothing needs your answer right now.</p>
          ) : (
            <ul className="space-y-2">
              {requestTickets.map(({ request, ticket }) => (
                <li
                  key={request.id}
                  className="flex items-center gap-3 rounded-xl bg-secondary/40 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{ticket.subject}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {nameOf(request.authorId)} wants{" "}
                      {request.kind === "handover" ? "to hand this over" : "help on this"} ·{" "}
                      {formatRelativeTime(new Date(request.createdAt).getTime())}
                    </p>
                  </div>
                  <Button size="sm" className="h-9 shrink-0" onClick={() => setTimelineId(ticket.id)}>
                    Answer
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Unassigned tickets" subtitle="Nobody owns these yet" to="/portal/tickets">
          {ticketsLoading ? (
            <Skeleton className="h-24 w-full rounded-xl" />
          ) : unassigned.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">Every open ticket has an owner.</p>
          ) : (
            <TicketList tickets={unassigned.slice(0, 5)} stages={stages} nameOf={nameOf} onOpen={setTimelineId} />
          )}
        </Panel>

        <Panel title="Not started" subtitle="Assigned but no progress recorded" to="/portal/tickets">
          {ticketsLoading ? (
            <Skeleton className="h-24 w-full rounded-xl" />
          ) : stalled.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">Everything assigned has movement on it.</p>
          ) : (
            <TicketList tickets={stalled.slice(0, 5)} stages={stages} nameOf={nameOf} onOpen={setTimelineId} />
          )}
        </Panel>

        <Panel
          title="ClickUp workload"
          subtitle={
            integrationStatus?.clickup.connected ? "Open tasks per person" : "ClickUp is not connected"
          }
          to={integrationStatus?.clickup.connected ? "/portal/clickup" : undefined}
        >
          {!integrationStatus?.clickup.connected ? (
            <EmptyState
              icon={ListTodo}
              title="Not connected"
              description="Set CLICKUP_API_TOKEN to pull tasks in here."
            />
          ) : clickup.isLoading ? (
            <Skeleton className="h-24 w-full rounded-xl" />
          ) : clickup.isError || !clickup.data ? (
            <p className="py-1 text-sm text-muted-foreground">Could not reach ClickUp just now.</p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-secondary px-2.5 py-1 tabular-nums">
                  {clickup.data.counts.total} open
                </span>
                <span className="rounded-full bg-destructive/10 px-2.5 py-1 tabular-nums text-destructive">
                  {clickup.data.counts.overdue} overdue
                </span>
                <span className="rounded-full bg-warning/10 px-2.5 py-1 tabular-nums text-warning">
                  {clickup.data.counts.dueToday} due today
                </span>
              </div>
              <ul className="space-y-2">
                {clickup.data.workload.slice(0, 5).map((row) => (
                  <li key={row.id} className="flex items-center gap-2.5">
                    <Avatar className="size-7 shrink-0">
                      <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                        {row.initials || initials(row.name)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
                    {row.overdue > 0 && (
                      <span className="shrink-0 text-xs font-semibold tabular-nums text-destructive">
                        {row.overdue} late
                      </span>
                    )}
                    <span className="shrink-0 text-sm font-medium tabular-nums">{row.total}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>

        <Panel title="Team" subtitle={`${users?.length ?? 0} people`} to="/portal/team" className="lg:col-span-2">
          {!users ? (
            <Skeleton className="h-16 w-full rounded-xl" />
          ) : (
            <div className="flex flex-wrap gap-2">
              {users
                .filter((u) => u.role !== "client")
                .map((u) => {
                  const load = open.filter((t) => t.assigneeId === u.id).length;
                  return (
                    <span
                      key={u.id}
                      className="inline-flex items-center gap-2 rounded-full bg-secondary/60 py-1 pr-3 pl-1.5 text-sm"
                    >
                      <Avatar className="size-6">
                        <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                          {initials(u.name)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="truncate">{u.name}</span>
                      <span
                        className={cn(
                          "tabular-nums",
                          load === 0 ? "text-muted-foreground" : "font-semibold text-foreground",
                        )}
                        title={`${load} open tickets`}
                      >
                        {load}
                      </span>
                    </span>
                  );
                })}
            </div>
          )}
        </Panel>
      </div>

      <TicketTimelineDialog ticketId={timelineId} onClose={() => setTimelineId(null)} />
    </div>
  );
}

function TicketList({
  tickets,
  stages,
  nameOf,
  onOpen,
}: {
  tickets: Ticket[];
  stages: { key: string; label: string; progress: number }[] | undefined;
  nameOf: (id: string | null | undefined) => string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <ul className="space-y-2">
      {tickets.map((t) => {
        const age = Date.now() - new Date(t.createdAt).getTime();
        const stale = age > 3 * 24 * 60 * 60 * 1000;
        return (
          <li key={t.id} className="flex items-center gap-3 rounded-xl bg-secondary/40 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{t.subject}</p>
              <p className="truncate text-xs text-muted-foreground">
                {[
                  nameOf(t.assigneeId) ?? "Unassigned",
                  stageLabel(t.stage, stages),
                  formatRelativeTime(new Date(t.createdAt).getTime()),
                ].join(" · ")}
              </p>
            </div>
            {stale && (
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-warning">
                <AlarmClock className="size-3" />
                stale
              </span>
            )}
            <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={() => onOpen(t.id)}>
              Open
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
