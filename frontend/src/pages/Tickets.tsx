import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Ticket as TicketIcon, Plus, Search, X } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useTickets, useUpdateTicket, useUsers } from "@/hooks/useData";
import { isHeldForApproval } from "@/lib/api";

import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { plainDate } from "@/lib/money";
import { CreateTicketModal } from "@/components/CreateTicketModal";
import { TicketTimelineDialog } from "@/components/tickets/TicketTimelineDialog";
import { PriorityBadge, SlaBadge } from "@/components/tickets/TicketMeta";
import { useMyTicketRequests, useTicketStages } from "@/hooks/useTicketWorkflow";
import { priorityRank, stageLabel, type TicketStage } from "@/lib/tickets";
import { cn } from "@/lib/utils";
import type { Ticket } from "@/lib/entities";

const STAFF_STATUSES = ["Open", "In Progress", "Resolved", "Closed"];
const CLOSED = ["Resolved", "Closed"];

type Filter = "open" | "closed" | "all";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "open", label: "Still open" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "Everything" },
];

export default function Tickets() {
  const { user } = useAuth();
  const { data: tickets, isLoading, isError, error, refetch } = useTickets();
  const { data: users } = useUsers();
  const updateTicket = useUpdateTicket();
  const { data: stages } = useTicketStages();
  const { data: myRequests } = useMyTicketRequests();

  const isStaff = Boolean(user && ["admin", "sales", "project_manager", "employee"].includes(user.role));
  const [createOpen, setCreateOpen] = useState(false);
  const [timelineId, setTimelineId] = useState<string | null>(null);

  /**
   * Email notifications link straight at one ticket (?ticket=ticket-1042), so
   * the recipient lands on the timeline rather than on a list to search.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkId = searchParams.get("ticket");
  useEffect(() => {
    if (deepLinkId) setTimelineId(deepLinkId);
  }, [deepLinkId]);

  function closeTimeline() {
    setTimelineId(null);
    if (searchParams.has("ticket")) {
      const next = new URLSearchParams(searchParams);
      next.delete("ticket");
      setSearchParams(next, { replace: true });
    }
  }
  const [filter, setFilter] = useState<Filter>("open");
  const [search, setSearch] = useState("");

  /** Tickets with a handover or collaboration request waiting on this user. */
  const awaitingMe = useMemo(
    () => new Set((myRequests ?? []).map((r) => r.ticketId)),
    [myRequests],
  );

  const nameOf = useMemo(() => {
    const map = new Map((users ?? []).map((u) => [u.id, u.name]));
    return (id: string) => map.get(id) ?? id;
  }, [users]);

  const all = tickets ?? [];
  const openCount = all.filter((t) => !CLOSED.includes(t.status)).length;
  const closedCount = all.length - openCount;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all
      .filter((t) => {
        if (filter === "open") return !CLOSED.includes(t.status);
        if (filter === "closed") return CLOSED.includes(t.status);
        return true;
      })
      .filter((t) => {
        if (!q) return true;
        return (
          t.subject.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q) ||
          (isStaff && nameOf(t.clientId).toLowerCase().includes(q))
        );
      })
      // Anything waiting on this user floats up, then urgency, then newest.
      .sort((a, b) => {
        const mine = Number(awaitingMe.has(b.id)) - Number(awaitingMe.has(a.id));
        if (mine !== 0) return mine;
        const urgency = priorityRank(b.priority) - priorityRank(a.priority);
        if (urgency !== 0) return urgency;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [all, filter, search, isStaff, nameOf, awaitingMe]);

  function changeStatus(id: string, status: string) {
    updateTicket.mutate(
      { id, patch: { status } },
      {
        onSuccess: () => toast.success("Ticket updated"),
        // Closing a ticket emails the client, so an admin who has not been
        // vouched for has it held. Reporting "updated" would send them away
        // believing the client had already been told.
        onError: (err) =>
          isHeldForApproval(err)
            ? toast.success(err.message, { duration: 6000 })
            : toast.error(err instanceof Error ? err.message : "Failed to update ticket"),
      },
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <PageHeader
        title={isStaff ? "Tickets" : "Your requests"}
        description={
          isStaff
            ? "Every client request, most urgent first."
            : "Every request you send us, tracked from opened to resolved."
        }
        actions={
          <CreateTicketModal
            open={createOpen}
            onOpenChange={setCreateOpen}
            trigger={
              <Button className="h-10 gap-2 px-4 font-medium">
                <Plus className="size-4" /> New request
              </Button>
            }
          />
        }
      />

      {/* One toolbar instead of two competing panels: filter left, search right. */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-card p-2 ring-1 ring-foreground/10">
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => {
            const count = f.key === "open" ? openCount : f.key === "closed" ? closedCount : all.length;
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={active}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-xl px-3.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary/10 text-primary ring-1 ring-primary/25"
                    : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                )}
              >
                {f.label}
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
                    active ? "bg-primary/15 text-primary" : "bg-foreground/10",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isStaff ? "Search subject, client, category" : "Search your requests"}
            className="h-9 border-none bg-transparent pl-9 text-sm focus-visible:ring-0"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-2xl" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={TicketIcon}
          title={search ? "Nothing matches that search" : filter === "closed" ? "Nothing closed yet" : "No open requests"}
          description={
            search
              ? "Try a different word, or clear the search."
              : "When you ask us something, it shows up here so you can follow along."
          }
          action={
            !search ? (
              <Button className="mt-1 h-10 px-4" onClick={() => setCreateOpen(true)}>
                Ask us something
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-2">
          {visible.map((t) => (
            <TicketRow
              key={t.id}
              ticket={t}
              stages={stages}
              isStaff={isStaff}
              needsYou={awaitingMe.has(t.id)}
              clientName={isStaff ? nameOf(t.clientId) : null}
              onOpen={() => setTimelineId(t.id)}
              onStatusChange={(s) => changeStatus(t.id, s)}
            />
          ))}
        </ul>
      )}

      <TicketTimelineDialog ticketId={timelineId} onClose={closeTimeline} />
    </div>
  );
}

/**
 * A ticket gets its own three-line block: title and badges, then who and when,
 * then progress. Controls sit on the right and wrap under on narrow screens,
 * so nothing has to be truncated to a stub.
 */
function TicketRow({
  ticket,
  stages,
  isStaff,
  needsYou,
  clientName,
  onOpen,
  onStatusChange,
}: {
  ticket: Ticket;
  stages: TicketStage[] | undefined;
  isStaff: boolean;
  needsYou: boolean;
  clientName: string | null;
  onOpen: () => void;
  onStatusChange: (status: string) => void;
}) {
  const pct = ticket.progress ?? 0;
  const meta = [ticket.category, clientName, `Asked ${plainDate(ticket.createdAt)}`].filter(Boolean).join(" · ");

  return (
    <li
      className={cn(
        "rounded-2xl bg-card p-4 ring-1 ring-foreground/10 transition-colors hover:ring-foreground/20",
        needsYou && "ring-2 ring-destructive/30",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-72">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 text-base leading-snug font-medium break-words">{ticket.subject}</h3>
            {needsYou && (
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
                Needs you
              </span>
            )}
          </div>

          <p className="mt-1 text-sm text-muted-foreground">{meta}</p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <PriorityBadge priority={ticket.priority} />
            <SlaBadge ticket={ticket} />
            {!isStaff && (
              <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {ticket.status}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isStaff && (
            <Select value={ticket.status} onValueChange={(v) => onStatusChange(v || "Open")}>
              <SelectTrigger size="sm" className="h-9 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STAFF_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={onOpen}
            aria-label={`Open "${ticket.subject}" and its updates`}
          >
            Open
          </Button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="shrink-0 numeric text-xs text-muted-foreground">
          {stageLabel(ticket.stage, stages)}
        </span>
      </div>
    </li>
  );
}
