import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Loader2, Send, UserPlus, ArrowRightLeft, Check, X, MessageSquare, Settings2, UserMinus,
} from "lucide-react";
import {
  usePostTicketUpdate, useRemoveCollaborator, useRequestCollaboration,
  useRequestHandover, useRespondToRequest, useTicketStages, useTicketTimeline,
} from "@/hooks/useTicketWorkflow";
import { useUsers } from "@/hooks/useData";
import { useAuth } from "@/context/AuthContext";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { formatRelativeTime, initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DEFAULT_STAGES, isRequest, stageLabel, type TicketUpdate } from "@/lib/tickets";
import { PriorityBadge, SlaBadge } from "@/components/tickets/TicketMeta";

const NO_STAGE = "__unchanged__";

const KIND_ICON = {
  progress: MessageSquare,
  handover: ArrowRightLeft,
  collaboration: UserPlus,
  system: Settings2,
} as const;

export function TicketTimelineDialog({
  ticketId,
  onClose,
}: {
  ticketId: string | null;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const timeline = useTicketTimeline(ticketId);
  const { data: stages = DEFAULT_STAGES } = useTicketStages();
  const { data: users } = useUsers();

  const [note, setNote] = useState("");
  const [stage, setStage] = useState(NO_STAGE);
  const [progress, setProgress] = useState("");
  const [delegateMode, setDelegateMode] = useState<"handover" | "collaboration" | null>(null);
  const [targetUserId, setTargetUserId] = useState("");
  const [delegateNote, setDelegateNote] = useState("");

  const postUpdate = usePostTicketUpdate();
  const requestHandover = useRequestHandover();
  const requestCollaboration = useRequestCollaboration();
  const respond = useRespondToRequest();
  const removeCollaborator = useRemoveCollaborator();

  const nameOf = useMemo(() => {
    const map = new Map((users ?? []).map((u) => [u.id, u.name]));
    return (id: string | null) => (id ? map.get(id) ?? "Someone" : "System");
  }, [users]);

  /** Staff who could take over or help -- never the person already assigned. */
  const delegateCandidates = useMemo(() => {
    const ticket = timeline.data?.ticket;
    const taken = new Set([ticket?.assigneeId, ...(timeline.data?.collaborators ?? []).map((c) => c.userId)]);
    return (users ?? []).filter(
      (u) => ["admin", "project_manager", "employee"].includes(u.role) && u.id !== user?.id && !taken.has(u.id),
    );
  }, [users, timeline.data, user]);

  if (!ticketId) return null;

  const data = timeline.data;
  const ticket = data?.ticket;
  const canRecord = data?.can.recordProgress ?? false;
  const canDelegate = data?.can.delegate ?? false;
  const isClient = user?.role === "client";

  function submitUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!ticketId) return;
    const trimmed = note.trim();
    const parsedProgress = progress === "" ? undefined : Number(progress);
    if (!trimmed && stage === NO_STAGE && parsedProgress === undefined) return;

    postUpdate.mutate(
      {
        ticketId,
        body: trimmed || undefined,
        stage: stage === NO_STAGE ? undefined : stage,
        progress: parsedProgress,
      },
      {
        onSuccess: () => {
          setNote("");
          setStage(NO_STAGE);
          setProgress("");
          toast.success("Update posted");
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not post the update"),
      },
    );
  }

  function submitDelegate(e: React.FormEvent) {
    e.preventDefault();
    if (!ticketId || !targetUserId || !delegateMode) return;
    const mutation = delegateMode === "handover" ? requestHandover : requestCollaboration;
    mutation.mutate(
      { ticketId, targetUserId, note: delegateNote.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(delegateMode === "handover" ? "Handover requested" : "Collaboration requested");
          setDelegateMode(null);
          setTargetUserId("");
          setDelegateNote("");
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not send the request"),
      },
    );
  }

  function answer(request: TicketUpdate, accept: boolean) {
    if (!ticketId) return;
    respond.mutate(
      { ticketId, requestId: request.id, accept },
      {
        onSuccess: () => toast.success(accept ? "Request accepted" : "Request declined"),
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not answer the request"),
      },
    );
  }

  const delegating = requestHandover.isPending || requestCollaboration.isPending;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="scrollbar-slim max-h-[90svh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="pr-8">{ticket?.subject ?? "Ticket"}</DialogTitle>
          <DialogDescription>
            {ticket ? `${ticket.id} · ${ticket.category} · ${ticket.status}` : "Loading…"}
          </DialogDescription>
        </DialogHeader>

        {timeline.isError ? (
          <ErrorState title="Could not load this ticket" error={timeline.error} onRetry={() => timeline.refetch()} />
        ) : timeline.isLoading || !data || !ticket ? (
          <Skeleton className="h-72 w-full rounded-xl" />
        ) : (
          <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
            {/* Story on the left, the controls that change it on the right. */}
            <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <PriorityBadge priority={ticket.priority} />
              <SlaBadge ticket={ticket} />
            </div>

            <ProgressBar progress={ticket.progress ?? 0} stage={stageLabel(ticket.stage, stages)} />

            <WorkingOn
              assigneeName={ticket.assigneeId ? nameOf(ticket.assigneeId) : null}
              collaborators={data.collaborators.map((c) => ({ ...c, name: nameOf(c.userId) }))}
              canRemove={canDelegate}
              onRemove={(userId) =>
                removeCollaborator.mutate(
                  { ticketId, userId },
                  {
                    onSuccess: () => toast.success("Collaborator removed"),
                    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not remove them"),
                  },
                )
              }
            />

            <Timeline
              updates={data.updates}
              stages={stages}
              nameOf={nameOf}
              currentUserId={user?.id ?? null}
              isAdmin={user?.role === "admin"}
              onAnswer={answer}
              answering={respond.isPending}
            />
            </div>

            <div className="space-y-5">
            {/* Post an update. Clients get a plain note box; the team also gets
                the stage and percentage controls. */}
            {(canRecord || isClient) && (
              <form onSubmit={submitUpdate} className="space-y-3 rounded-xl bg-secondary/30 p-4">
                <Label htmlFor="ticket-note">{isClient ? "Reply" : "Post an update"}</Label>
                <Textarea
                  id="ticket-note"
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={isClient ? "Ask a question or add detail…" : "What moved since last time?"}
                />

                {canRecord && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="ticket-stage">Stage</Label>
                      <Select value={stage} onValueChange={(v) => setStage(v ?? NO_STAGE)}>
                        <SelectTrigger id="ticket-stage" className="h-11">
                          {/* Base UI renders the raw value unless given a
                              mapper, which would leak the sentinel key. */}
                          <SelectValue>
                            {(value) =>
                              value === NO_STAGE
                                ? "Leave unchanged"
                                : stages.find((s) => s.key === value)?.label ?? "Leave unchanged"
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_STAGE}>Leave unchanged</SelectItem>
                          {stages.map((s) => (
                            <SelectItem key={s.key} value={s.key}>
                              {s.label} · {s.progress}%
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="ticket-progress">Progress %</Label>
                      <Input
                        id="ticket-progress"
                        className="h-11"
                        type="number"
                        min={0}
                        max={100}
                        value={progress}
                        onChange={(e) => setProgress(e.target.value)}
                        placeholder="Optional — defaults to the stage"
                      />
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    className="h-11 gap-2"
                    disabled={postUpdate.isPending || (!note.trim() && stage === NO_STAGE && progress === "")}
                  >
                    {postUpdate.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                    Post update
                  </Button>

                  {canDelegate && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11 gap-2"
                        onClick={() => setDelegateMode(delegateMode === "handover" ? null : "handover")}
                      >
                        <ArrowRightLeft className="size-4" />
                        Hand over
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11 gap-2"
                        onClick={() => setDelegateMode(delegateMode === "collaboration" ? null : "collaboration")}
                      >
                        <UserPlus className="size-4" />
                        Ask for help
                      </Button>
                    </>
                  )}
                </div>
              </form>
            )}

            {delegateMode && (
              <form onSubmit={submitDelegate} className="space-y-3 rounded-xl bg-secondary/40 p-4">
                <p className="text-sm font-medium text-foreground">
                  {delegateMode === "handover"
                    ? "Ask someone to take this ticket over"
                    : "Ask someone to help without giving up ownership"}
                </p>

                <div className="space-y-1.5">
                  <Label htmlFor="delegate-target">Who</Label>
                  <Select value={targetUserId} onValueChange={(v) => setTargetUserId(v ?? "")}>
                    <SelectTrigger id="delegate-target" className="h-11">
                      <SelectValue placeholder="Pick a team member" />
                    </SelectTrigger>
                    <SelectContent>
                      {delegateCandidates.map((u) => (
                        <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {delegateCandidates.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Everyone on the team is already on this ticket.
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="delegate-note">Why (optional)</Label>
                  <Textarea
                    id="delegate-note"
                    rows={2}
                    value={delegateNote}
                    onChange={(e) => setDelegateNote(e.target.value)}
                    placeholder="Context that helps them decide."
                  />
                </div>

                <div className="flex gap-2">
                  <Button type="submit" className="h-11 gap-2" disabled={delegating || !targetUserId}>
                    {delegating && <Loader2 className="size-4 animate-spin" />}
                    Send request
                  </Button>
                  <Button type="button" variant="ghost" className="h-11" onClick={() => setDelegateMode(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProgressBar({ progress, stage }: { progress: number; stage: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{stage}</span>
        <span className="text-sm tabular-nums text-muted-foreground">{progress}%</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Ticket progress: ${stage}`}
      >
        <div
          className={cn("h-full rounded-full transition-all duration-300", progress >= 100 ? "bg-success" : "bg-primary")}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

function WorkingOn({
  assigneeName,
  collaborators,
  canRemove,
  onRemove,
}: {
  assigneeName: string | null;
  collaborators: { id: string; userId: string; name: string }[];
  canRemove: boolean;
  onRemove: (userId: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Working on it</span>

      {assigneeName ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 py-1 pr-3 pl-1.5 text-sm font-medium text-primary">
          <Avatar className="size-6">
            <AvatarFallback className="bg-primary/20 text-[10px] font-semibold text-primary">
              {initials(assigneeName)}
            </AvatarFallback>
          </Avatar>
          {assigneeName}
          <span className="text-[10px] tracking-wide uppercase opacity-70">owner</span>
        </span>
      ) : (
        <span className="rounded-full bg-warning/10 px-3 py-1 text-sm font-medium text-warning">Unassigned</span>
      )}

      {collaborators.map((c) => (
        <span
          key={c.id}
          className="inline-flex items-center gap-1.5 rounded-full bg-card py-1 pr-2 pl-1.5 text-sm ring-1 ring-foreground/10"
        >
          <Avatar className="size-6">
            <AvatarFallback className="bg-secondary text-[10px] font-semibold">{initials(c.name)}</AvatarFallback>
          </Avatar>
          {c.name}
          {canRemove && (
            <button
              type="button"
              onClick={() => onRemove(c.userId)}
              aria-label={`Remove ${c.name} from this ticket`}
              className="focus-clear rounded-full p-0.5 text-muted-foreground hover:bg-secondary hover:text-destructive"
            >
              <UserMinus className="size-3.5" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

function Timeline({
  updates,
  stages,
  nameOf,
  currentUserId,
  isAdmin,
  onAnswer,
  answering,
}: {
  updates: TicketUpdate[];
  stages: { key: string; label: string; progress: number }[];
  nameOf: (id: string | null) => string;
  currentUserId: string | null;
  isAdmin: boolean;
  onAnswer: (request: TicketUpdate, accept: boolean) => void;
  answering: boolean;
}) {
  if (updates.length === 0) {
    return <p className="text-sm text-muted-foreground">No updates yet. Post the first one below.</p>;
  }

  return (
    <ol className="space-y-2">
      {[...updates].reverse().map((update) => {
        const Icon = KIND_ICON[update.kind];
        const pending = isRequest(update) && update.status === "pending";
        // Only the person asked can answer — admins can unblock a stuck request.
        const canAnswer = pending && (update.targetUserId === currentUserId || isAdmin);

        return (
          <li key={update.id} className="flex gap-2.5 rounded-xl bg-secondary/40 p-3">
            <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-card ring-1 ring-foreground/10">
              <Icon className="size-3.5 text-muted-foreground" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm font-medium text-foreground">{nameOf(update.authorId)}</span>
                {isRequest(update) && (
                  <span className="text-sm text-muted-foreground">
                    {update.kind === "handover" ? "asked" : "asked for help from"} {nameOf(update.targetUserId)}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">{formatRelativeTime(new Date(update.createdAt).getTime())}</span>
                {update.status && (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
                      update.status === "pending" && "bg-warning/10 text-warning",
                      update.status === "accepted" && "bg-success/10 text-success",
                      update.status === "declined" && "bg-destructive/10 text-destructive",
                    )}
                  >
                    {update.status}
                  </span>
                )}
              </div>

              {update.body && <p className="mt-1 text-sm whitespace-pre-wrap text-foreground/90">{update.body}</p>}

              {(update.stage || update.progress !== null) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {update.stage && <>Moved to {stageLabel(update.stage, stages)}</>}
                  {update.stage && update.progress !== null && " · "}
                  {update.progress !== null && <span className="tabular-nums">{update.progress}%</span>}
                </p>
              )}

              {canAnswer && (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" className="h-9 gap-1.5" disabled={answering} onClick={() => onAnswer(update, true)}>
                    <Check className="size-3.5" />
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 gap-1.5"
                    disabled={answering}
                    onClick={() => onAnswer(update, false)}
                  >
                    <X className="size-3.5" />
                    Decline
                  </Button>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
