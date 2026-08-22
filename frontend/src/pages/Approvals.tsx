import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Clock, ShieldCheck, ShieldQuestion, X, XCircle } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useApprovals, useCancelApproval, useDecideApproval } from "@/hooks/useApprovals";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime, formatRelativeTime, initials } from "@/lib/format";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { ApprovalRequest, ApprovalStatus } from "@/lib/types";

const STATUS_LOOK: Record<ApprovalStatus, { label: string; tone: string }> = {
  pending: { label: "Waiting", tone: "bg-warning/15 text-warning" },
  approved: { label: "Approved", tone: "bg-success/15 text-success" },
  rejected: { label: "Turned down", tone: "bg-destructive/10 text-destructive" },
  cancelled: { label: "Withdrawn", tone: "bg-secondary text-muted-foreground" },
  expired: { label: "Expired", tone: "bg-secondary text-muted-foreground" },
  failed: { label: "Failed", tone: "bg-destructive/10 text-destructive" },
};

/**
 * The second-signature queue.
 *
 * Two audiences again. An admin who has not been vouched for watches their own
 * proposals here and learns what is holding them up. Everyone who can sign off
 * works the pending list at the top.
 *
 * The rule the page is built around: nothing on a pending row has happened. The
 * copy says so in as many words, because an admin who assumes otherwise will
 * make the change twice.
 */
export default function Approvals() {
  const { user, can } = useAuth();
  const { data, isLoading, isError, error, refetch } = useApprovals();
  const decide = useDecideApproval();
  const cancel = useCancelApproval();
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const requests = useMemo(() => data?.requests ?? [], [data]);
  const pending = requests.filter((r) => r.status === "pending");
  const settled = requests.filter((r) => r.status !== "pending");

  function act(request: ApprovalRequest, decision: "approve" | "reject") {
    decide.mutate(
      { id: request.id, decision, note: note.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(decision === "approve" ? "Approved and applied" : "Turned down");
          setNoteFor(null);
          setNote("");
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not record that decision"),
      },
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title="Approvals"
        description={
          can.canDecideApprovals
            ? "Changes proposed by admins who have not been vouched for yet. Nothing here has happened."
            : "Your proposals, and where they have got to. Nothing here has happened yet."
        }
      />

      {can.needsApproval && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl bg-warning/10 p-4 ring-1 ring-warning/25">
          <ShieldQuestion aria-hidden className="mt-0.5 size-5 shrink-0 text-warning" />
          <p className="text-sm leading-relaxed">
            <span className="font-medium">Your account is new.</span> Sensitive changes you make are
            sent to the other admins first. A super admin can lift this once they know you.
          </p>
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-28 w-full rounded-2xl" />
          <Skeleton className="h-28 w-full rounded-2xl" />
        </div>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : requests.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Nothing waiting"
          description="Proposals that need a second signature will appear here."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {pending.length > 0 && (
            <section>
              <h2 className="px-1 pb-2 t-label text-muted-foreground">
                Waiting on a decision
              </h2>
              <div className="flex flex-col gap-3">
                {pending.map((request) => {
                  const mine = request.requestedBy === user?.id;
                  const open = noteFor === request.id;
                  return (
                    <article
                      key={request.id}
                      className="rounded-2xl bg-card p-4 ring-1 ring-warning/25"
                    >
                      <Row request={request} />

                      {/* Nobody signs their own, however senior. */}
                      {can.canDecideApprovals && !mine ? (
                        <div className="mt-3 border-t border-border/60 pt-3">
                          {open && (
                            <Textarea
                              value={note}
                              onChange={(e) => setNote(e.target.value)}
                              placeholder="Add a note for them (optional)"
                              className="mb-2"
                            />
                          )}
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              className="h-10 gap-1.5 px-4"
                              disabled={decide.isPending}
                              onClick={() => act(request, "approve")}
                            >
                              <Check className="size-4" />
                              Approve
                            </Button>
                            <Button
                              variant="outline"
                              className="h-10 gap-1.5 px-4 text-destructive hover:bg-destructive/10"
                              disabled={decide.isPending}
                              onClick={() => act(request, "reject")}
                            >
                              <X className="size-4" />
                              Turn down
                            </Button>
                            <Button
                              variant="ghost"
                              className="h-10 px-3 text-muted-foreground"
                              onClick={() => {
                                setNoteFor(open ? null : request.id);
                                setNote("");
                              }}
                            >
                              {open ? "Hide note" : "Add a note"}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                          <p className="flex-1 text-xs text-muted-foreground">
                            {mine
                              ? "Waiting on another admin. You cannot approve your own request."
                              : "Only a super admin or a trusted admin can decide this."}
                          </p>
                          {mine && (
                            <Button
                              variant="ghost"
                              className="h-10 gap-1.5 px-3 text-muted-foreground hover:text-destructive"
                              disabled={cancel.isPending}
                              onClick={() =>
                                cancel.mutate(request.id, {
                                  onSuccess: () => toast.success("Withdrawn"),
                                  onError: (err) =>
                                    toast.error(err instanceof Error ? err.message : "Could not withdraw it"),
                                })
                              }
                            >
                              <XCircle className="size-4" />
                              Withdraw
                            </Button>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {settled.length > 0 && (
            <section>
              <h2 className="px-1 pb-2 t-label text-muted-foreground">
                Already decided
              </h2>
              <div className="flex flex-col gap-2">
                {settled.map((request) => (
                  <article key={request.id} className="rounded-2xl bg-card p-4 ring-1 ring-foreground/10">
                    <Row request={request} />
                    {request.executionError && (
                      <p className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        Approved, but the change did not go through: {request.executionError}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ request }: { request: ApprovalRequest }) {
  const look = STATUS_LOOK[request.status] ?? STATUS_LOOK.pending;
  const at = new Date(request.requestedAt).getTime();

  return (
    <>
      <div className="flex items-start gap-3">
        <Avatar className="size-9 shrink-0">
          <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
            {initials(request.requestedByName)}
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1">
          <p className="text-[15px] leading-snug font-medium">{request.summary}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{request.requestedByName}</span>
            <span aria-hidden>·</span>
            <time dateTime={request.requestedAt} title={formatDateTime(at)}>
              {formatRelativeTime(at)}
            </time>
            <span aria-hidden>·</span>
            <span>{request.actionLabel}</span>
          </p>
        </div>

        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
            look.tone,
          )}
        >
          {look.label}
        </span>
      </div>

      {request.status === "pending" && request.expiresAt && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock aria-hidden className="size-3.5 shrink-0" />
          Expires by itself {formatRelativeTime(request.expiresAt)} if nobody decides.
        </p>
      )}

      {request.decidedByName && request.status !== "pending" && (
        <p className="mt-2 text-xs text-muted-foreground">
          {request.status === "approved" ? "Approved" : "Decided"} by {request.decidedByName}
          {request.decisionNote ? ` — "${request.decisionNote}"` : ""}
        </p>
      )}
    </>
  );
}
