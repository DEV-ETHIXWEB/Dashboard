import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link2, MessageSquareText, Archive, TicketPlus, Inbox } from "lucide-react";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useUsers } from "@/hooks/useData";
import { formatRelativeTime } from "@/lib/format";
import { tapFeedback } from "@/lib/haptics";
import { cn } from "@/lib/utils";

type Status = "new" | "read" | "archived";

interface SmsMessage {
  id: string;
  channel: string;
  fromNumber: string | null;
  body: string;
  status: Status;
  createdAt: string;
  clientId: string | null;
  clientName: string | null;
  clientCompany: string | null;
  senderLabel: string;
  summary: string | null;
  intent: string | null;
  priority: string | null;
  category: string | null;
  ticketId: string | null;
  mediaCount: number;
}

interface InboxResponse {
  messages: SmsMessage[];
  unread: number;
  config: {
    twilioReady: boolean;
    outboundEnabled: boolean;
    triageReady: boolean;
    number: string | null;
  };
}

/** Only the priorities that deserve to shout; Normal and Low stay quiet. */
const PRIORITY_TONE: Record<string, string> = {
  Urgent: "bg-destructive/10 text-destructive ring-destructive/20",
  High: "bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-400",
};

function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", className)}>
      {children}
    </span>
  );
}

/**
 * Client texts, as a queue somebody works through.
 *
 * The client's name leads every row, because "who is this" is the first thing
 * anyone asks. The AI summary sits under it as one quiet line and the client's
 * actual words sit under that -- a summary is a convenience for scanning, and
 * the words somebody really sent are what a person needs to read before
 * answering. A message whose number is not on file says so plainly and offers
 * the one control that fixes it.
 */
export default function SmsInbox() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | Status>("all");

  const { data, isLoading, isError, error, refetch } = useQuery<InboxResponse>({
    queryKey: ["sms"],
    queryFn: () => api<InboxResponse>("GET", "/sms"),
  });

  const { data: users } = useUsers();
  const clients = useMemo(
    () => (users ?? [])
      .filter((u) => u.role === "client")
      .map((u) => ({ id: u.id, name: u.name, company: u.company ?? null })),
    [users],
  );

  const link = useMutation({
    mutationFn: ({ id, clientId }: { id: string; clientId: string }) =>
      api("PATCH", `/sms/${id}`, { clientId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sms"] });
      toast.success("Linked. Future texts from this number will match on their own.");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not link that number"),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Status }) =>
      api("PATCH", `/sms/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sms"] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update that message"),
  });

  const promote = useMutation({
    mutationFn: (id: string) => api<{ ticket: { id: string } }>("POST", `/sms/${id}/ticket`),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["sms"] });
      qc.invalidateQueries({ queryKey: ["tickets"] });
      toast.success("Ticket raised", {
        action: { label: "Open", onClick: () => navigate(`/portal/tickets?ticket=${result.ticket.id}`) },
      });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not raise a ticket"),
  });

  const messages = useMemo(() => {
    const all = data?.messages ?? [];
    return filter === "all" ? all : all.filter((m) => m.status === filter);
  }, [data, filter]);

  if (isError) {
    return (
      <>
        <PageHeader title="Client texts" description="Messages sent to the support number." />
        <ErrorState error={error} onRetry={() => refetch()} />
      </>
    );
  }

  const config = data?.config;

  return (
    <>
      <PageHeader
        title="Client texts"
        description={
          config?.number
            ? `Messages sent to ${config.number}.`
            : "Messages clients send to the support number."
        }
      />

      {/* Say what is switched off rather than showing an empty list that looks
          like nobody has ever texted. */}
      {config && !config.twilioReady && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          Twilio is not configured on this deployment, so no texts can arrive. Set
          <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">TWILIO_ACCOUNT_SID</code> and
          <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">TWILIO_AUTH_TOKEN</code>.
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["all", "new", "read", "archived"] as const).map((key) => (
          <Button
            key={key}
            variant={filter === key ? "default" : "outline"}
            size="sm"
            onClick={() => { tapFeedback(); setFilter(key); }}
          >
            {key === "all" ? "All" : key === "new" ? "Unread" : key === "read" ? "Read" : "Archived"}
            {key === "new" && data?.unread ? ` (${data.unread})` : ""}
          </Button>
        ))}
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full rounded-lg" />)}
        </div>
      )}

      {!isLoading && messages.length === 0 && (
        <EmptyState
          icon={Inbox}
          title={filter === "all" ? "No texts yet" : "Nothing here"}
          description={
            filter === "all"
              ? "When a client texts the support number, their message appears here."
              : "Try another filter."
          }
        />
      )}

      <div className="space-y-3">
        {messages.map((m) => (
          <article
            key={m.id}
            className={cn(
              "rounded-lg border bg-card p-4 transition-colors",
              m.status === "new" && "border-primary/30 bg-primary/[0.03]",
            )}
          >
            <header className="mb-2 flex flex-wrap items-center gap-2">
              {m.status === "new" && <span className="size-2 rounded-full bg-primary" aria-label="Unread" />}
              <h3 className="font-medium">
                {m.clientName ?? "Unknown sender"}
                {m.clientCompany && <span className="text-muted-foreground"> · {m.clientCompany}</span>}
              </h3>
              {m.priority && PRIORITY_TONE[m.priority] && (
                <Pill className={PRIORITY_TONE[m.priority]}>{m.priority}</Pill>
              )}
              {m.category && <Pill className="bg-muted text-muted-foreground ring-border">{m.category}</Pill>}
              <span className="ml-auto text-xs text-muted-foreground">
                {formatRelativeTime(new Date(m.createdAt).getTime())}
              </span>
            </header>

            {m.summary && (
              <p className="mb-2 text-sm italic text-muted-foreground">{m.summary}</p>
            )}

            <p className="whitespace-pre-wrap text-sm">{m.body}</p>

            {m.mediaCount > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                {m.mediaCount} attachment{m.mediaCount === 1 ? "" : "s"} (not shown here)
              </p>
            )}

            <footer className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
              <span className="text-xs text-muted-foreground">{m.fromNumber}</span>

              {/* An unlinked number is the one thing on this row worth fixing,
                  so the control to fix it sits inline rather than in a menu. */}
              {!m.clientId && (
                <div className="flex items-center gap-1.5">
                  <Link2 className="size-3.5 text-muted-foreground" />
                  <Select
                    onValueChange={(clientId) => link.mutate({ id: m.id, clientId: String(clientId) })}
                    disabled={link.isPending}
                  >
                    <SelectTrigger className="h-7 w-[190px] text-xs">
                      <SelectValue placeholder="Link to a client" />
                    </SelectTrigger>
                    <SelectContent>
                      {clients.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}{c.company ? ` · ${c.company}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="ml-auto flex items-center gap-2">
                {m.ticketId ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(`/portal/tickets?ticket=${m.ticketId}`)}
                  >
                    <MessageSquareText className="mr-1.5 size-3.5" />
                    View ticket
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={promote.isPending}
                    onClick={() => { tapFeedback(); promote.mutate(m.id); }}
                  >
                    <TicketPlus className="mr-1.5 size-3.5" />
                    Raise ticket
                  </Button>
                )}

                {m.status !== "archived" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={setStatus.isPending}
                    onClick={() => {
                      tapFeedback();
                      setStatus.mutate({ id: m.id, status: m.status === "new" ? "read" : "archived" });
                    }}
                  >
                    <Archive className="mr-1.5 size-3.5" />
                    {m.status === "new" ? "Mark read" : "Archive"}
                  </Button>
                )}
              </div>
            </footer>
          </article>
        ))}
      </div>
    </>
  );
}
