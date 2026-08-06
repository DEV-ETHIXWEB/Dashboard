import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  MessageSquare, Hash, Lock, RotateCw, Search, Loader2, AlertTriangle, ExternalLink,
  Reply, Paperclip, Smile,
} from "lucide-react";
import {
  useIntegrationStatus, useRefreshIntegration, useSlackChannels, useSlackFeed,
} from "@/hooks/useIntegrations";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { IntegrationNotConnected } from "@/components/IntegrationNotConnected";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime, formatRelativeTime, initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SlackCategory, SlackMessage } from "@/lib/integrations";

const CATEGORY_TONE: Record<string, string> = {
  alerts: "bg-destructive/10 text-destructive",
  announcements: "bg-warning/10 text-warning",
  action_items: "bg-primary/10 text-primary",
  questions: "bg-success/10 text-success",
  links_files: "bg-secondary text-muted-foreground",
  discussion: "bg-secondary text-muted-foreground",
  general: "bg-secondary text-muted-foreground",
};

export default function SlackMessages() {
  const { data: status, isLoading: statusLoading } = useIntegrationStatus();
  const channels = useSlackChannels();
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const feed = useSlackFeed(selected);
  const refresh = useRefreshIntegration();

  const memberChannels = useMemo(
    () => (channels.data ?? []).filter((c) => c.isMember),
    [channels.data],
  );

  const categories: SlackCategory[] = useMemo(() => {
    const raw = feed.data?.categories ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return raw.filter((c) => c.messages.length > 0);
    return raw
      .map((c) => ({
        ...c,
        messages: c.messages.filter(
          (m) =>
            m.text.toLowerCase().includes(q) ||
            m.authorName.toLowerCase().includes(q) ||
            m.channelName.toLowerCase().includes(q),
        ),
      }))
      .filter((c) => c.messages.length > 0);
  }, [feed.data, query]);

  function toggleChannel(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  function handleRefresh() {
    refresh.mutate("slack", {
      onSuccess: () => toast.success("Pulled fresh messages from Slack"),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Refresh failed"),
    });
  }

  if (statusLoading) return <Skeleton className="h-64 w-full rounded-2xl" />;

  if (!status?.slack.connected) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader title="Slack" description="Channel messages, grouped by what they are." />
        <IntegrationNotConnected
          name="Slack"
          icon={MessageSquare}
          vars={[
            {
              key: "SLACK_BOT_TOKEN",
              hint: "A bot token (xoxb-…) with channels:read, channels:history, groups:read, groups:history and users:read.",
            },
          ]}
          steps={[
            "Create a Slack app at api.slack.com/apps for your workspace.",
            "Under OAuth & Permissions add the bot scopes listed above, then install the app.",
            "Copy the Bot User OAuth Token into SLACK_BOT_TOKEN on the server and restart it.",
            "Invite the bot to each channel you want to read: /invite @yourbot",
          ]}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader
        title="Slack"
        description={
          feed.data
            ? `${feed.data.total} messages across ${feed.data.channels.length} channels · updated ${formatRelativeTime(feed.data.fetchedAt)}`
            : "Channel messages, grouped by what they are."
        }
        actions={
          <Button variant="outline" className="h-10 gap-2" onClick={handleRefresh} disabled={refresh.isPending}>
            {refresh.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
            Refresh
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        <aside className="rounded-2xl bg-card p-3 ring-1 ring-foreground/10">
          <div className="flex items-center justify-between px-1 pb-2">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Channels</span>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => setSelected([])}
                className="focus-clear text-xs text-primary hover:underline"
              >
                Reset
              </button>
            )}
          </div>

          {channels.isError ? (
            <ErrorState title="Could not load channels" error={channels.error} onRetry={() => channels.refetch()} />
          ) : channels.isLoading ? (
            <Skeleton className="h-48 w-full rounded-xl" />
          ) : memberChannels.length === 0 ? (
            <p className="px-1 py-3 text-sm text-muted-foreground">
              The bot is not in any channel yet. Run <code className="rounded bg-secondary px-1">/invite @yourbot</code> in
              Slack, then refresh.
            </p>
          ) : (
            <>
              <p className="px-1 pb-2 text-xs text-muted-foreground">
                {selected.length === 0 ? "Showing every channel the bot is in." : `${selected.length} selected.`}
              </p>
              <div className="max-h-[28rem] space-y-0.5 overflow-y-auto">
                {memberChannels.map((channel) => {
                  const active = selected.includes(channel.id);
                  return (
                    <button
                      key={channel.id}
                      type="button"
                      onClick={() => toggleChannel(channel.id)}
                      aria-pressed={active}
                      className={cn(
                        "focus-clear flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
                        active ? "bg-primary/10 font-medium text-primary" : "text-foreground/80 hover:bg-secondary",
                      )}
                    >
                      {channel.isPrivate ? <Lock className="size-3.5 shrink-0" /> : <Hash className="size-3.5 shrink-0" />}
                      <span className="truncate">{channel.name}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </aside>

        <div className="min-w-0">
          {feed.isError ? (
            <ErrorState title="Could not load messages" error={feed.error} onRetry={() => feed.refetch()} />
          ) : feed.isLoading || !feed.data ? (
            <Skeleton className="h-96 w-full rounded-2xl" />
          ) : (
            <>
              {feed.data.skipped.length > 0 && (
                <div className="mb-4 flex items-start gap-2.5 rounded-xl bg-warning/5 p-3.5 ring-1 ring-warning/20">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  <div className="min-w-0 text-sm">
                    <p className="font-medium text-foreground">Some channels were skipped</p>
                    <ul className="mt-1 space-y-0.5 text-muted-foreground">
                      {feed.data.skipped.map((s) => (
                        <li key={s.channelId}>
                          #{s.channelName} — {s.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              <div className="relative mb-4">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-10 pl-9"
                  placeholder="Search messages, authors, channels"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>

              {categories.length === 0 ? (
                <EmptyState
                  icon={MessageSquare}
                  title={query ? "No matching messages" : "No messages yet"}
                  description={
                    query
                      ? "Try a different search."
                      : "The bot can read these channels but found no recent messages."
                  }
                />
              ) : (
                <Tabs defaultValue="all">
                  <TabsList className="mb-4 flex-wrap">
                    <TabsTrigger value="all">All</TabsTrigger>
                    {categories.map((c) => (
                      <TabsTrigger key={c.key} value={c.key}>
                        {c.label}
                        <span className="ml-1.5 text-xs text-muted-foreground">{c.messages.length}</span>
                      </TabsTrigger>
                    ))}
                  </TabsList>

                  <TabsContent value="all">
                    <div className="space-y-6">
                      {categories.map((category) => (
                        <CategorySection key={category.key} category={category} />
                      ))}
                    </div>
                  </TabsContent>

                  {categories.map((category) => (
                    <TabsContent key={category.key} value={category.key}>
                      <CategorySection category={category} />
                    </TabsContent>
                  ))}
                </Tabs>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CategorySection({ category }: { category: SlackCategory }) {
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 className="text-sm font-semibold tracking-wide text-foreground uppercase">{category.label}</h2>
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", CATEGORY_TONE[category.key])}>
          {category.messages.length}
        </span>
        <p className="text-xs text-muted-foreground">{category.description}</p>
      </div>
      <div className="space-y-2">
        {category.messages.map((message) => (
          <MessageCard key={message.id} message={message} />
        ))}
      </div>
    </section>
  );
}

function MessageCard({ message }: { message: SlackMessage }) {
  return (
    <article className="flex gap-3 rounded-xl bg-card p-3.5 ring-1 ring-foreground/10 transition-colors hover:bg-secondary/40">
      <Avatar className="size-8 shrink-0">
        {message.authorAvatar && <AvatarImage src={message.authorAvatar} alt="" />}
        <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
          {initials(message.authorName)}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-foreground">{message.authorName}</span>
          {message.isBot && (
            <span className="rounded bg-secondary px-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              app
            </span>
          )}
          <span className="text-xs text-muted-foreground">#{message.channelName}</span>
          <span className="text-xs text-muted-foreground" title={formatDateTime(message.at)}>
            {formatRelativeTime(message.at)}
          </span>
        </div>

        <p className="mt-1 text-sm whitespace-pre-wrap text-foreground/90">{message.text || "(no text)"}</p>

        {(message.replyCount > 0 || message.reactionCount > 0 || message.files.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {message.replyCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <Reply className="size-3" />
                {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
              </span>
            )}
            {message.reactionCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <Smile className="size-3" />
                {message.reactionCount}
              </span>
            )}
            {message.files.map((file) => (
              <span key={file.id} className="inline-flex items-center gap-1">
                <Paperclip className="size-3" />
                {file.name}
              </span>
            ))}
          </div>
        )}
      </div>

      <a
        href={message.permalink}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={`Open message from ${message.authorName} in Slack`}
        className="focus-clear h-fit shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        <ExternalLink className="size-4" />
      </a>
    </article>
  );
}
