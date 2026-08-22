import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Activity, CheckCircle2, Clock, FolderKanban, Gauge, ListTodo, Loader2,
  MailCheck, MessageSquare, RefreshCw, Send, Radio,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useUsers } from "@/hooks/useData";
import { useProgressBoard, useReplyOnTicket, useTicketActivity } from "@/hooks/useClientProgress";
import { useSendProgressDigest } from "@/hooks/useMail";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { SummaryCard } from "@/components/SummaryCard";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDateTime, formatRelativeTime, initials } from "@/lib/format";
import { isClosed, type ActivityEntry, type ProgressTicket } from "@/lib/clientProgress";
import { cn } from "@/lib/utils";

/**
 * The client's view of work in flight.
 *
 * It answers one question -- "where is my work right now?" -- by pulling the
 * live task-board state and the team's chat thread through the server, so the
 * client never needs a ClickUp seat or a Slack account to see either.
 */
export default function WorkProgress() {
  const { user } = useAuth();
  const isStaff = Boolean(user && user.role !== "client");

  const [clientId, setClientId] = useState<string | null>(null);
  const { data: users } = useUsers();
  const board = useProgressBoard(isStaff ? clientId : null);
  const digest = useSendProgressDigest();
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const isAdmin = user?.role === "admin";

  const clients = useMemo(
    () => (users ?? []).filter((u) => u.role === "client").sort((a, b) => a.name.localeCompare(b.name)),
    [users],
  );

  // Staff land on whichever client the server picked; keep the select in step.
  useEffect(() => {
    if (isStaff && !clientId && board.data?.client?.id) setClientId(board.data.client.id);
  }, [isStaff, clientId, board.data?.client?.id]);

  const data = board.data;
  const tickets = data?.tickets ?? [];
  const open = tickets.filter((t) => !isClosed(t));
  const done = tickets.filter(isClosed);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <PageHeader
        title="Work progress"
        description={
          isStaff
            ? "The board exactly as your client sees it -- live task state and the shared thread."
            : "Everything we are building for you right now, straight from the team's own board."
        }
        actions={
          // Wrapping, because a client picker plus two buttons is wider than a
          // phone and this header is the only thing above the board.
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {isStaff && clients.length > 0 && (
              <Select
                items={Object.fromEntries(
                  clients.map((c) => [c.id, c.company ? `${c.name} · ${c.company}` : c.name]),
                )}
                value={clientId ?? ""}
                onValueChange={(v) => setClientId(v || null)}
              >
                <SelectTrigger size="sm" className="h-9 w-full min-w-0 sm:w-52">
                  <SelectValue placeholder="Pick a client" />
                </SelectTrigger>
                <SelectContent>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.company ? `${c.name} · ${c.company}` : c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {isAdmin && board.data?.client && (
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5"
                disabled={digest.isPending}
                onClick={() =>
                  digest.mutate(board.data!.client!.id, {
                    onSuccess: (r) =>
                      toast.success(
                        r.ok ? `Summary emailed to ${r.to}` : "Summary rendered, but no mail transport is configured",
                      ),
                    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not send the summary"),
                  })
                }
              >
                {digest.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <MailCheck className="size-3.5" />
                )}
                Email summary
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => board.refetch()}
              disabled={board.isFetching}
            >
              <RefreshCw className={cn("size-3.5", board.isFetching && "animate-spin")} />
              Refresh
            </Button>
          </div>
        }
      />

      {board.isError ? (
        <ErrorState title="Could not load the progress board" error={board.error} onRetry={() => board.refetch()} />
      ) : board.isLoading || !data ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-[74px] rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-40 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      ) : !data.client ? (
        <EmptyState
          icon={FolderKanban}
          title="No client selected"
          description="Add a client login first, and their work shows up here."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard icon={ListTodo} value={data.summary.open} label="Requests in flight" tone="primary" />
            <SummaryCard icon={Gauge} value={`${data.summary.averageProgress}%`} label="Average progress" />
            <SummaryCard
              icon={Clock}
              value={data.summary.nextDeadline ? formatRelativeTime(data.summary.nextDeadline) : "—"}
              label="Next reply due"
              tone={data.summary.nextDeadline && data.summary.nextDeadline < Date.now() ? "danger" : "muted"}
            />
            <SummaryCard icon={CheckCircle2} value={data.summary.resolved} label="Finished" tone="success" />
          </div>

          <SourceStrip
            board={data.integrations.board}
            chat={data.integrations.chat}
            chatMode={data.integrations.chatMode}
          />

          {tickets.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="Nothing in progress yet"
              description="When you raise a request, it appears here with live progress from the team's board."
            />
          ) : (
            <Tabs defaultValue="active">
              <TabsList className="mb-4 h-11! w-full gap-1 p-1 sm:w-fit">
                <TabsTrigger value="active" className="px-4">
                  In flight ({open.length})
                </TabsTrigger>
                <TabsTrigger value="done" className="px-4">
                  Finished ({done.length})
                </TabsTrigger>
                <TabsTrigger value="projects" className="px-4">
                  Projects ({data.projects.length})
                </TabsTrigger>
              </TabsList>

              <TabsContent value="active">
                {open.length === 0 ? (
                  <EmptyState icon={CheckCircle2} title="Nothing open" description="Every request you sent is finished." />
                ) : (
                  <ul className="space-y-2">
                    {open.map((t) => (
                      <TicketCard key={t.id} ticket={t} onOpen={() => setOpenTicketId(t.id)} />
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="done">
                {done.length === 0 ? (
                  <EmptyState icon={Activity} title="Nothing finished yet" description="Completed work lands here." />
                ) : (
                  <ul className="space-y-2">
                    {done.map((t) => (
                      <TicketCard key={t.id} ticket={t} onOpen={() => setOpenTicketId(t.id)} />
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="projects">
                {data.projects.length === 0 ? (
                  <EmptyState icon={FolderKanban} title="No active projects" description="Projects appear here once they start." />
                ) : (
                  <ul className="space-y-2">
                    {data.projects.map((p) => (
                      <li
                        key={p.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card p-4 ring-1 ring-foreground/10"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">{p.name}</div>
                          <div className="text-sm text-muted-foreground">{p.type}</div>
                        </div>
                        <StatusBadge status={p.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>
            </Tabs>
          )}
        </>
      )}

      <ActivityDialog ticketId={openTicketId} onClose={() => setOpenTicketId(null)} />
    </div>
  );
}

/** Honest statement of where this page's data comes from, and what is missing. */
function SourceStrip({ board, chat, chatMode }: { board: boolean; chat: boolean; chatMode: string }) {
  const items = [
    {
      key: "board",
      icon: ListTodo,
      label: "Task board",
      on: board,
      detail: board ? "Live status from the team's board" : "Not connected yet",
    },
    {
      key: "chat",
      icon: MessageSquare,
      label: "Team thread",
      on: chat,
      detail: chat
        ? chatMode === "full"
          ? "Full thread, including the team's replies"
          : "Shared updates from the thread"
        : "Not connected yet",
    },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <div
          key={item.key}
          className="flex min-w-0 flex-1 basis-64 items-center gap-3 rounded-2xl bg-card px-4 py-3 ring-1 ring-foreground/10"
        >
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-xl",
              item.on ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
            )}
          >
            <item.icon className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              {item.label}
              {item.on && <Radio aria-hidden className="size-3 text-success" />}
            </div>
            <div className="truncate text-xs text-muted-foreground">{item.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TicketCard({ ticket, onOpen }: { ticket: ProgressTicket; onOpen: () => void }) {
  const pct = ticket.progress ?? 0;
  const late = ticket.responseDueAt != null && !ticket.firstResponseAt && ticket.responseDueAt < Date.now();

  return (
    <li className="rounded-2xl bg-card p-4 ring-1 ring-foreground/10 transition-colors hover:ring-foreground/20">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-72">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 text-base leading-snug font-medium break-words">{ticket.subject}</h3>
            <StatusBadge status={ticket.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {[ticket.id, ticket.category, ticket.ownerName ? `With ${ticket.ownerName}` : null]
              .filter(Boolean)
              .join(" · ")}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {ticket.board && (
              <span
                className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 text-[11px] font-medium"
                title={ticket.board.listName ? `On the ${ticket.board.listName} list` : undefined}
              >
                <span
                  aria-hidden
                  className="size-1.5 rounded-full"
                  style={{ background: ticket.board.statusColor || "currentColor" }}
                />
                Board: {ticket.board.status}
              </span>
            )}
            {ticket.hasThread && (
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                <MessageSquare className="size-3" /> Thread
              </span>
            )}
            {late && (
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
                Reply overdue
              </span>
            )}
          </div>
        </div>

        <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={onOpen}>
          View updates
        </Button>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {ticket.stageLabel ?? "Not started"} · {pct}%
        </span>
      </div>
    </li>
  );
}

/** One ticket told from all three sources, with a reply box under it. */
function ActivityDialog({ ticketId, onClose }: { ticketId: string | null; onClose: () => void }) {
  const activity = useTicketActivity(ticketId);
  const reply = useReplyOnTicket(ticketId);
  const [text, setText] = useState("");

  useEffect(() => {
    setText("");
  }, [ticketId]);

  if (!ticketId) return null;
  const data = activity.data;

  function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    reply.mutate(body, {
      onSuccess: () => {
        setText("");
        toast.success("Sent to the team");
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not send that"),
    });
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="scrollbar-slim max-h-[90svh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="pr-8">{data?.ticket.subject ?? "Request"}</DialogTitle>
          <DialogDescription>
            {data
              ? [data.ticket.id, data.ticket.status, data.ticket.stageLabel ?? "Not started"].join(" · ")
              : "Loading…"}
          </DialogDescription>
        </DialogHeader>

        {activity.isError ? (
          <ErrorState title="Could not load these updates" error={activity.error} onRetry={() => activity.refetch()} />
        ) : activity.isLoading || !data ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : (
          <div className="space-y-6">
            <section className="space-y-3">
              <SectionTitle icon={Activity} label="From the team" />
              {data.notes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No notes yet. The first update lands here.</p>
              ) : (
                <ul className="space-y-3">
                  {data.notes.map((n) => (
                    <li key={n.id} className="flex gap-3">
                      <Avatar className="size-8 shrink-0">
                        <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                          {initials(n.author)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-sm font-medium">{n.author}</span>
                          <span className="text-xs text-muted-foreground">
                            {formatRelativeTime(new Date(n.at).getTime())}
                          </span>
                          {n.stageLabel && (
                            <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                              {n.stageLabel}
                              {n.progress != null ? ` · ${n.progress}%` : ""}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-sm whitespace-pre-wrap text-foreground/90">{n.body}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <FeedSection
              icon={ListTodo}
              label="On the task board"
              enabled={data.board.enabled}
              linked={data.board.linked}
              available={data.board.available}
              error={data.board.error}
              entries={data.board.comments}
              emptyText="No board comments on this one yet."
              offText="The task board is not connected to this workspace yet."
              unlinkedText="This request is tracked here rather than on the task board."
              link={data.board.url}
            />

            <FeedSection
              icon={MessageSquare}
              label={data.chat.mode === "full" ? "Team thread" : "Shared updates"}
              enabled={data.chat.enabled}
              linked={data.chat.linked}
              available={data.chat.available}
              error={data.chat.error}
              entries={data.chat.messages}
              emptyText="Nothing posted in the thread yet."
              offText="Team chat is not connected to this workspace yet."
              unlinkedText="No team thread was opened for this request."
            />

            <form onSubmit={send} className="space-y-3 rounded-xl bg-secondary/30 p-4">
              <label htmlFor="progress-reply" className="text-sm font-medium">
                Reply to the team
              </label>
              <Textarea
                id="progress-reply"
                rows={3}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Ask a question, or add anything that helps."
                maxLength={4000}
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  Goes to the ticket, the team's board, and their thread.
                </span>
                <Button type="submit" size="sm" className="h-9 gap-1.5" disabled={!text.trim() || reply.isPending}>
                  {reply.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                  Send
                </Button>
              </div>
            </form>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SectionTitle({ icon: Icon, label }: { icon: typeof Activity; label: string }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
      <Icon aria-hidden className="size-4 text-muted-foreground" />
      {label}
    </h3>
  );
}

/**
 * One external source. A disconnected integration and an empty one read
 * differently on purpose -- "not connected" is an admin's job to fix, "nothing
 * yet" is not.
 */
function FeedSection({
  icon,
  label,
  enabled,
  linked,
  available,
  error,
  entries,
  emptyText,
  offText,
  unlinkedText,
  link,
}: {
  icon: typeof Activity;
  label: string;
  enabled: boolean;
  linked: boolean;
  available: boolean;
  error: string | null;
  entries: ActivityEntry[];
  emptyText: string;
  offText: string;
  unlinkedText: string;
  link?: string | null;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle icon={icon} label={label} />
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-clear -mx-2 inline-flex items-center rounded-lg px-2 text-xs font-medium text-primary hover:underline coarse:min-h-11"
          >
            Open task
          </a>
        )}
      </div>

      {error ? (
        <p className="rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning">{error}</p>
      ) : !enabled ? (
        <p className="text-sm text-muted-foreground">{offText}</p>
      ) : !linked || !available ? (
        <p className="text-sm text-muted-foreground">{unlinkedText}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-xl bg-secondary/30 px-3.5 py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium">{entry.author}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(entry.at)}</span>
              </div>
              <p className="mt-1 text-sm whitespace-pre-wrap text-foreground/90">{entry.body}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
