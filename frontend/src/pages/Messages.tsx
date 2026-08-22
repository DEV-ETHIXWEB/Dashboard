import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, MessageSquare, Send, SlashIcon } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useUsers } from "@/hooks/useData";
import { useClientChannel, useSendChannelMessage, type ChannelMessage } from "@/hooks/useClientChannel";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDateTime, formatRelativeTime, initials } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A direct line to the team, in the one Slack channel this client owns.
 *
 * The client has no Slack account and never needs one: the server reads and
 * writes the channel on their behalf. They see exactly one room -- the one
 * named on their record -- and nothing else in the workspace is reachable from
 * here, because the channel id is read from their own account rather than from
 * anything they can send.
 */
export default function Messages() {
  const { user } = useAuth();
  const isStaff = Boolean(user && user.role !== "client");

  const { data: users } = useUsers();
  const clients = useMemo(
    () => (users ?? []).filter((u) => u.role === "client").sort((a, b) => a.name.localeCompare(b.name)),
    [users],
  );
  const [clientId, setClientId] = useState<string | null>(null);
  useEffect(() => {
    if (isStaff && !clientId && clients[0]) setClientId(clients[0].id);
  }, [isStaff, clientId, clients]);

  const scope = isStaff ? clientId : null;
  const { data, isLoading, isError, error, refetch } = useClientChannel(scope);
  const send = useSendChannelMessage(scope);

  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const messages = data?.messages ?? [];

  // A conversation opens at the newest message, the way every chat does.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  function submit() {
    const body = draft.trim();
    if (!body) return;
    send.mutate(body, {
      onSuccess: () => setDraft(""),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not send that"),
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col">
      <PageHeader
        title={isStaff ? "Client messages" : "Messages"}
        description={
          isStaff
            ? "The client's own channel, exactly as they see it. Anything posted here reaches them."
            : "A direct line to the team. Messages land in the channel they work in."
        }
        actions={
          isStaff && clients.length > 0 ? (
            <Select
              items={Object.fromEntries(clients.map((c) => [c.id, c.company ? `${c.name} · ${c.company}` : c.name]))}
              value={clientId ?? ""}
              onValueChange={(v) => setClientId(v || null)}
            >
              <SelectTrigger size="sm" className="h-9 w-full min-w-0 sm:w-56">
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
          ) : undefined
        }
      />

      {isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-2xl" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : !data?.enabled ? (
        <EmptyState
          icon={SlashIcon}
          title="Messaging is not switched on"
          description="This workspace has no Slack connection yet, so there is nowhere for messages to go."
        />
      ) : data.slackError ? (
        <EmptyState
          icon={MessageSquare}
          title="Slack will not let us read that channel"
          description={
            isStaff
              ? data.slackError
              : "We are still setting your channel up. Raise a request if it stays like this."
          }
        />
      ) : !data.channel ? (
        <EmptyState
          icon={MessageSquare}
          title={isStaff ? "No channel on this account" : "Not set up yet"}
          description={
            isStaff
              ? "Give this client a Slack channel from Client Access, and this becomes their direct line to the team."
              : "We have not opened your channel yet. Raise a request and we will sort it."
          }
        />
      ) : (
        <>
          {data.channel.name && (
            <p className="mb-3 t-caption text-muted-foreground">
              {isStaff ? "Posting into" : "You are talking to the team in"}{" "}
              <span className="font-medium text-foreground">#{data.channel.name}</span>
            </p>
          )}

          <div className="flex flex-col gap-3 rounded-2xl bg-card p-4 ring-1 ring-foreground/10">
            <div className="flex max-h-[52svh] flex-col gap-3 overflow-y-auto overscroll-contain">
              {messages.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Nothing here yet. Say hello.
                </p>
              ) : (
                messages.map((m) => <Bubble key={m.id} message={m} isStaff={isStaff} />)
              )}
              <div ref={endRef} />
            </div>

            <div className="flex items-end gap-2 border-t border-border/60 pt-3">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends, shift+enter breaks the line -- the rule every
                  // chat uses, so nobody has to be told it.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="Write a message…"
                className="min-h-11 flex-1 resize-none"
                aria-label="Your message"
              />
              <Button
                className="h-11 shrink-0 gap-1.5 px-4"
                disabled={send.isPending || !draft.trim()}
                onClick={submit}
              >
                {send.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Send
              </Button>
            </div>
          </div>

          <p className="mt-3 t-caption text-muted-foreground">
            {isStaff
              ? "Everything in this channel is visible to the client. Keep internal notes somewhere else."
              : "Replies appear here within a few seconds of the team sending them."}
          </p>
        </>
      )}
    </div>
  );
}

function Bubble({ message, isStaff }: { message: ChannelMessage; isStaff: boolean }) {
  // "Mine" means written from the portal by this side of the conversation.
  const mine = isStaff ? !message.fromPortal : message.fromPortal;

  return (
    <div className={cn("flex gap-2.5", mine && "flex-row-reverse")}>
      <Avatar className="size-8 shrink-0">
        <AvatarFallback
          className={cn(
            "text-[11px] font-semibold",
            mine ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground",
          )}
        >
          {initials(message.author || "?")}
        </AvatarFallback>
      </Avatar>

      <div className={cn("flex min-w-0 max-w-[80%] flex-col gap-1", mine && "items-end")}>
        <div
          className={cn(
            "rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
            mine ? "bg-primary/10 text-foreground" : "bg-secondary text-foreground",
          )}
        >
          {message.body}
        </div>
        <span className="t-caption text-muted-foreground">
          {message.author}
          {" · "}
          <time dateTime={new Date(message.at).toISOString()} title={formatDateTime(message.at)}>
            {formatRelativeTime(message.at)}
          </time>
        </span>
      </div>
    </div>
  );
}
