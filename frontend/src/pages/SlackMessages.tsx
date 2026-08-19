import * as emoji from "node-emoji";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  MessageSquare, Hash, Lock, RotateCw, Search, Loader2, AlertTriangle, ExternalLink,
  Reply, Paperclip, Smile, Send, CheckSquare, Sparkles, ChevronDown, ChevronUp,
  Bell, Megaphone, HelpCircle, MessagesSquare, Inbox,
} from "lucide-react";
import {
  useIntegrationStatus, useRefreshIntegration, useSlackChannels, useSlackFeed,
  useSlackThread, useSendSlackMessage, useConvertSlackToTask, useSendSlackDigest,
} from "@/hooks/useIntegrations";
import { useProjects, useUsers } from "@/hooks/useData";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { IntegrationNotConnected } from "@/components/IntegrationNotConnected";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { formatDateTime, formatRelativeTime, initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SlackCategory, SlackChannel, SlackMessage } from "@/lib/integrations";

const CATEGORY_TONE: Record<string, string> = {
  alerts: "bg-destructive/10 text-destructive",
  announcements: "bg-warning/10 text-warning",
  action_items: "bg-primary/10 text-primary",
  questions: "bg-success/10 text-success",
  links_files: "bg-secondary text-muted-foreground",
  discussion: "bg-secondary text-muted-foreground",
  general: "bg-secondary text-muted-foreground",
};

const TAB_BASE =
  "inline-flex h-9 flex-none items-center gap-2 rounded-xl px-3.5 text-xs font-medium whitespace-nowrap text-muted-foreground transition-all hover:bg-foreground/5 hover:text-foreground";

/**
 * Selected pill. Keyed off aria-selected, which Base UI keeps in step with the
 * real selection -- its data-active attribute tracks keyboard highlight instead.
 */
const TAB_ACTIVE =
  "aria-selected:bg-background aria-selected:font-semibold aria-selected:text-foreground aria-selected:shadow-sm aria-selected:ring-1 aria-selected:ring-foreground/10 dark:aria-selected:bg-foreground/10";

/** Icon and short name per category, so the tab strip reads at a glance. */
const CATEGORY_META: Record<string, { icon: typeof MessageSquare; short: string }> = {
  alerts: { icon: Bell, short: "Alerts" },
  announcements: { icon: Megaphone, short: "Announcements" },
  action_items: { icon: CheckSquare, short: "Action items" },
  questions: { icon: HelpCircle, short: "Questions" },
  links_files: { icon: Paperclip, short: "Links & files" },
  discussion: { icon: MessagesSquare, short: "Discussions" },
  general: { icon: MessageSquare, short: "General" },
};

const SLACK_EMOJIS: Record<string, string> = {
  "+1": "👍",
  "-1": "👎",
  thumbsup: "👍",
  thumbsdown: "👎",
  saluting_face: "🫡",
  wave: "👋",
  eyes: "👀",
  raising_hand: "🙋",
  raised_hands: "🙌",
  folded_hands: "🙏",
  pray: "🙏",
  joy: "😂",
  rofl: "🤣",
  sob: "😭",
  sweat_smile: "😅",
  thinking_face: "🤔",
  thinking: "🤔",
  party_popper: "🎉",
  tada: "🎉",
  "100": "💯",
  sparkles: "✨",
  heavy_check_mark: "✔️",
  check: "✓",
  x: "❌",
  cross_mark: "❌",
  arrow_right: "➡️",
  point_right: "👉",
  clap: "👏",
  bar_chart: "📊",
  chart_with_upwards_trend: "📈",
  file_folder: "📁",
  warning: "⚠️",
  pushpin: "📌",
  white_check_mark: "✅",
  memo: "📝",
  rocket: "🚀",
  fire: "🔥",
  star: "⭐",
  bell: "🔔",
  calendar: "📅",
  smile: "😊",
  heart: "❤️",
  exclamation: "❗",
  question: "❓",
  bulb: "💡",
};

export default function SlackMessages() {
  const { data: status, isLoading: statusLoading } = useIntegrationStatus();
  const channels = useSlackChannels();
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const feed = useSlackFeed(selected);
  const refresh = useRefreshIntegration();

  // Modals state
  const [isPostOpen, setIsPostOpen] = useState(false);
  const [isDigestOpen, setIsDigestOpen] = useState(false);
  const [activeThreadMessage, setActiveThreadMessage] = useState<SlackMessage | null>(null);
  const [activeTaskMessage, setActiveTaskMessage] = useState<SlackMessage | null>(null);

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

  const totalMessages = useMemo(
    () => categories.reduce((sum, c) => sum + c.messages.length, 0),
    [categories],
  );

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
              hint: "A bot token (xoxb-…) with channels:read, channels:history, chat:write, and users:read.",
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
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="default" className="h-10 gap-2" onClick={() => setIsPostOpen(true)}>
              <Send className="size-4" />
              New Message
            </Button>

            <Button variant="outline" className="h-10 gap-2" onClick={() => setIsDigestOpen(true)}>
              <Sparkles className="size-4 text-primary" />
              Send Digest
            </Button>

            <Button variant="outline" className="h-10 gap-2" onClick={handleRefresh} disabled={refresh.isPending}>
              {refresh.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
              Refresh
            </Button>
          </div>
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
                  {/* Wraps onto a second row instead of clipping the first and
                      last tab, which is what an overflow strip does here. The
                      selected pill keys off aria-selected: Base UI's
                      data-active tracks keyboard highlight, not selection. */}
                  <TabsList className="group-data-horizontal/tabs:h-auto mb-6 flex h-auto w-full flex-wrap items-center gap-1.5 rounded-2xl bg-secondary/60 p-2 ring-1 ring-foreground/10">
                    <TabsTrigger
                      value="all"
                      className={cn(TAB_BASE, TAB_ACTIVE)}
                    >
                      <Inbox aria-hidden className="size-3.5" />
                      <span>All</span>
                      <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
                        {totalMessages}
                      </span>
                    </TabsTrigger>

                    {categories.map((c) => {
                      const meta = CATEGORY_META[c.key];
                      const Icon = meta?.icon ?? MessageSquare;
                      const count = c.messages.length;

                      return (
                        <TabsTrigger
                          key={c.key}
                          value={c.key}
                          title={c.description}
                          className={cn(
                            TAB_BASE,
                            TAB_ACTIVE,
                            // An empty bucket stays clickable but stops competing for attention.
                            count === 0 && "opacity-50",
                          )}
                        >
                          <Icon aria-hidden className="size-3.5" />
                          <span>{meta?.short ?? c.label}</span>
                          <span
                            className={cn(
                              "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                              count === 0 ? "bg-foreground/5 text-muted-foreground" : CATEGORY_TONE[c.key],
                            )}
                          >
                            {count}
                          </span>
                        </TabsTrigger>
                      );
                    })}
                  </TabsList>

                  <TabsContent value="all">
                    <div className="space-y-6">
                      {categories.map((category) => (
                        <CategorySection
                          key={category.key}
                          category={category}
                          onOpenThread={(m) => setActiveThreadMessage(m)}
                          onConvertToTask={(m) => setActiveTaskMessage(m)}
                        />
                      ))}
                    </div>
                  </TabsContent>

                  {categories.map((category) => (
                    <TabsContent key={category.key} value={category.key}>
                      <CategorySection
                        category={category}
                        onOpenThread={(m) => setActiveThreadMessage(m)}
                        onConvertToTask={(m) => setActiveTaskMessage(m)}
                      />
                    </TabsContent>
                  ))}
                </Tabs>
              )}
            </>
          )}
        </div>
      </div>

      {/* Post Message Modal */}
      <PostMessageDialog
        open={isPostOpen}
        onOpenChange={setIsPostOpen}
        channels={memberChannels}
      />

      {/* Executive Digest Modal */}
      <SendDigestDialog
        open={isDigestOpen}
        onOpenChange={setIsDigestOpen}
        channels={memberChannels}
      />

      {/* Thread Reply Viewer Modal */}
      {activeThreadMessage && (
        <ThreadViewerDialog
          message={activeThreadMessage}
          onClose={() => setActiveThreadMessage(null)}
        />
      )}

      {/* Convert to Task Modal */}
      {activeTaskMessage && (
        <ConvertToTaskDialog
          message={activeTaskMessage}
          onClose={() => setActiveTaskMessage(null)}
        />
      )}
    </div>
  );
}

function CategorySection({
  category,
  onOpenThread,
  onConvertToTask,
}: {
  category: SlackCategory;
  onOpenThread: (m: SlackMessage) => void;
  onConvertToTask: (m: SlackMessage) => void;
}) {
  return (
    <section className="mb-6">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 className="text-sm font-semibold tracking-wide text-foreground uppercase">{category.label}</h2>
        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", CATEGORY_TONE[category.key])}>
          {category.messages.length}
        </span>
        <p className="text-xs text-muted-foreground">{category.description}</p>
      </div>
      <div className="space-y-3">
        {category.messages.map((message) => (
          <MessageCard
            key={message.id}
            message={message}
            onOpenThread={() => onOpenThread(message)}
            onConvertToTask={() => onConvertToTask(message)}
          />
        ))}
      </div>
    </section>
  );
}

function MessageCard({
  message,
  onOpenThread,
  onConvertToTask,
}: {
  message: SlackMessage;
  onOpenThread: () => void;
  onConvertToTask: () => void;
}) {
  const [isInlineThreadOpen, setIsInlineThreadOpen] = useState(false);

  return (
    <article className="group flex gap-4 rounded-2xl bg-card p-4 sm:p-4.5 ring-1 ring-foreground/10 transition-all hover:bg-secondary/40 shadow-xs">
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

        <FormattedSlackText text={message.text} />

        {/* Inline Rich Attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-2.5 space-y-2">
            {message.attachments.map((att) => (
              <div
                key={att.id}
                style={att.color ? { borderLeftColor: att.color } : undefined}
                className={cn(
                  "rounded-r-xl rounded-l-xs bg-secondary/60 p-3 text-xs ring-1 ring-foreground/10 border-l-4 border-l-primary/60",
                )}
              >
                {att.authorName && <p className="font-semibold text-foreground/80 mb-0.5">{att.authorName}</p>}
                {att.title && (
                  <p className="font-medium text-foreground mb-1">
                    {att.titleUrl ? (
                      <a href={att.titleUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        {att.title}
                      </a>
                    ) : (
                      att.title
                    )}
                  </p>
                )}
                {att.text && <FormattedSlackText text={att.text} />}
                {att.imageUrl && (
                  <img
                    src={att.imageUrl}
                    alt={att.title || "Slack attachment"}
                    className="mt-2 max-h-60 rounded-lg object-cover ring-1 ring-foreground/10"
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {/* Inline Uploaded Files / Images */}
        {message.files && message.files.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {message.files.map((file) => {
              if (file.isImage && file.thumb) {
                return (
                  <a
                    key={file.id}
                    href={file.url || message.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="group relative block overflow-hidden rounded-xl ring-1 ring-foreground/10 hover:ring-primary/50 transition-all"
                  >
                    <img
                      src={file.thumb}
                      alt={file.name}
                      className="h-28 max-w-xs object-cover transition-transform group-hover:scale-105"
                    />
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5 text-[10px] text-white truncate">
                      {file.name}
                    </div>
                  </a>
                );
              }
              return (
                <a
                  key={file.id}
                  href={file.url || message.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-secondary/80 px-2.5 py-1.5 text-xs text-foreground ring-1 ring-foreground/10 hover:bg-secondary transition-colors"
                >
                  <Paperclip className="size-3.5 text-primary" />
                  <span className="font-medium truncate max-w-40">{file.name}</span>
                  <ExternalLink className="size-3 text-muted-foreground" />
                </a>
              );
            })}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => setIsInlineThreadOpen((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 bg-secondary/70 hover:bg-secondary text-foreground font-medium transition-colors"
          >
            <Reply className="size-3.5 text-primary" />
            <span>
              {message.replyCount > 0
                ? `${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}`
                : "Reply"}
            </span>
            {isInlineThreadOpen ? (
              <ChevronUp className="size-3.5 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-3.5 text-muted-foreground" />
            )}
          </button>

          {message.reactionCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <Smile className="size-3" />
              {message.reactionCount}
            </span>
          )}

          <button
            type="button"
            onClick={onConvertToTask}
            className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
          >
            <CheckSquare className="size-3" />
            Convert to Task
          </button>

          <button
            type="button"
            onClick={onOpenThread}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
            title="Open in modal dialog"
          >
            <ExternalLink className="size-3" />
            <span>Pop-out</span>
          </button>
        </div>

        {/* Inline Reddit Thread View */}
        {isInlineThreadOpen && (
          <RedditThreadSection message={message} />
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

function RedditThreadSection({ message }: { message: SlackMessage }) {
  const { data: replies, isLoading, isError, refetch } = useSlackThread(message.channelId, message.ts);
  const sendMessage = useSendSlackMessage();
  const [replyText, setReplyText] = useState("");

  const handleSendReply = (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyText.trim()) return;
    sendMessage.mutate(
      { channelId: message.channelId, text: replyText.trim(), threadTs: message.ts },
      {
        onSuccess: () => {
          setReplyText("");
          refetch();
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to post reply"),
      }
    );
  };

  const childReplies = (replies || []).filter((r) => r.ts !== message.ts);

  return (
    <div className="mt-3.5 border-l-2 border-primary/40 dark:border-primary/30 pl-3.5 sm:pl-4 space-y-3 pt-1 transition-all">
      <div className="flex items-center justify-between text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        <span className="flex items-center gap-1.5 text-primary">
          <MessageSquare className="size-3.5" />
          Thread Discussion ({childReplies.length})
        </span>
        {isLoading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin text-primary" />
          Loading thread replies...
        </div>
      ) : isError ? (
        <p className="text-xs text-destructive">Failed to load thread. Make sure bot is in channel.</p>
      ) : childReplies.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No replies in this thread yet. Be the first to reply!</p>
      ) : (
        <div className="space-y-2.5">
          {childReplies.map((r) => (
            <div
              key={r.id}
              className="flex gap-3 rounded-xl bg-secondary/50 p-3 ring-1 ring-foreground/10 transition-colors hover:bg-secondary/70"
            >
              <Avatar className="size-7 shrink-0 mt-0.5">
                {r.authorAvatar && <AvatarImage src={r.authorAvatar} alt="" />}
                <AvatarFallback className="bg-primary/10 text-[9px] font-semibold text-primary">
                  {initials(r.authorName)}
                </AvatarFallback>
              </Avatar>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-xs font-semibold text-foreground">{r.authorName}</span>
                  {r.isBot && (
                    <span className="rounded bg-secondary px-1 text-[9px] font-semibold text-muted-foreground uppercase">
                      bot
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground">{formatRelativeTime(r.at)}</span>
                </div>

                <FormattedSlackText text={r.text} />

                {r.attachments && r.attachments.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {r.attachments.map((att) => (
                      <div
                        key={att.id}
                        className="rounded-r-lg bg-background/60 p-2 text-xs ring-1 ring-foreground/10 border-l-2 border-l-primary"
                      >
                        {att.title && <p className="font-medium text-foreground">{att.title}</p>}
                        {att.text && <FormattedSlackText text={att.text} />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Inline Reply Form */}
      <form onSubmit={handleSendReply} className="flex items-center gap-2 pt-2">
        <Input
          placeholder="Reply to thread..."
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          className="h-9 text-xs rounded-xl flex-1 bg-background/80"
        />
        <Button
          type="submit"
          size="sm"
          className="h-9 px-3.5 gap-1.5 rounded-xl text-xs font-medium shrink-0"
          disabled={sendMessage.isPending || !replyText.trim()}
        >
          {sendMessage.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          Reply
        </Button>
      </form>
    </div>
  );
}

// --- Modals & Dialogs --------------------------------------------------------

function PostMessageDialog({
  open,
  onOpenChange,
  channels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channels: SlackChannel[];
}) {
  const [channelId, setChannelId] = useState(channels[0]?.id || "");
  const [text, setText] = useState("");
  const sendMessage = useSendSlackMessage();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!channelId || !text.trim()) {
      toast.error("Select a channel and enter message text.");
      return;
    }
    sendMessage.mutate(
      { channelId, text: text.trim() },
      {
        onSuccess: () => {
          toast.success("Message sent to Slack channel!");
          setText("");
          onOpenChange(false);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to post message"),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Send Message to Slack</DialogTitle>
            <DialogDescription>Post a update or message directly to a Slack channel.</DialogDescription>
          </DialogHeader>

          {/* Where it goes on the left, what it says on the right. */}
          <div className="grid gap-x-5 gap-y-4 py-4 md:grid-cols-2">
            <div className="grid content-start gap-1.5">
              <Label htmlFor="slack-channel">Channel</Label>
              <Select value={channelId || channels[0]?.id || ""} onValueChange={(val) => setChannelId(val ?? "")}>
                <SelectTrigger id="slack-channel">
                  <SelectValue placeholder="Select a channel" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      #{c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="slack-text">Message</Label>
              <Textarea
                id="slack-text"
                rows={5}
                placeholder="Type your message here..."
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={sendMessage.isPending || !text.trim()}>
              {sendMessage.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Send to Slack
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SendDigestDialog({
  open,
  onOpenChange,
  channels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channels: SlackChannel[];
}) {
  const [channelId, setChannelId] = useState(channels[0]?.id || "");
  const sendDigest = useSendSlackDigest();

  function handleSend() {
    sendDigest.mutate(
      { channelId: channelId || undefined },
      {
        onSuccess: () => {
          toast.success("Dashboard Executive Digest posted to Slack!");
          onOpenChange(false);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to send digest"),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            Send Executive Summary Digest
          </DialogTitle>
          <DialogDescription>
            Generate and broadcast an active projects & pending tasks summary directly into your team's Slack channel.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-1.5">
            <Label htmlFor="digest-channel">Target Channel</Label>
            <Select value={channelId || channels[0]?.id || ""} onValueChange={(val) => setChannelId(val ?? "")}>
              <SelectTrigger id="digest-channel">
                <SelectValue placeholder="Select channel" />
              </SelectTrigger>
              <SelectContent>
                {channels.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    #{c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={sendDigest.isPending}>
            {sendDigest.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Publish Digest
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ThreadViewerDialog({
  message,
  onClose,
}: {
  message: SlackMessage;
  onClose: () => void;
}) {
  const { data: replies, isLoading, error } = useSlackThread(message.channelId, message.ts);
  const [replyText, setReplyText] = useState("");
  const sendMessage = useSendSlackMessage();

  function handleSendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!replyText.trim()) return;
    sendMessage.mutate(
      { channelId: message.channelId, text: replyText.trim(), threadTs: message.ts },
      {
        onSuccess: () => {
          toast.success("Reply posted!");
          setReplyText("");
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to post reply"),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(val) => !val && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Reply className="size-4 text-primary" />
            Thread Discussion (#{message.channelName})
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* Main Parent Message */}
          <div className="rounded-xl bg-secondary/50 p-3 ring-1 ring-foreground/10">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground">{message.authorName}</span>
              <span className="text-[10px] text-muted-foreground">{formatRelativeTime(message.at)}</span>
            </div>
            <FormattedSlackText text={message.text} />
          </div>

          <div className="border-t border-border pt-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Replies ({replies ? Math.max(0, replies.length - 1) : 0})
          </div>

          {isLoading ? (
            <Skeleton className="h-24 w-full rounded-lg" />
          ) : error ? (
            <p className="text-xs text-destructive">Could not load replies.</p>
          ) : (replies || []).length <= 1 ? (
            <p className="text-xs text-muted-foreground">No replies in this thread yet. Be the first to reply below!</p>
          ) : (
            (replies || []).slice(1).map((r) => (
              <div key={r.id} className="flex gap-2.5 rounded-lg bg-card p-2.5 ring-1 ring-foreground/10">
                <Avatar className="size-6 shrink-0">
                  {r.authorAvatar && <AvatarImage src={r.authorAvatar} alt="" />}
                  <AvatarFallback className="text-[9px]">{initials(r.authorName)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-foreground">{r.authorName}</span>
                    <span className="text-[10px] text-muted-foreground">{formatRelativeTime(r.at)}</span>
                  </div>
                  <FormattedSlackText text={r.text} />
                </div>
              </div>
            ))
          )}
        </div>

        <form onSubmit={handleSendReply} className="flex items-center gap-2 pt-3 border-t border-border">
          <Input
            placeholder="Reply to thread..."
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            className="h-10 text-xs rounded-xl flex-1 bg-secondary/40"
          />
          <Button
            type="submit"
            className="h-10 px-4 gap-2 rounded-xl text-xs font-medium shrink-0"
            disabled={sendMessage.isPending || !replyText.trim()}
          >
            {sendMessage.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Reply
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FormattedSlackText({ text }: { text: string }) {
  if (!text) return <span className="italic text-muted-foreground">(no text)</span>;

  const emojified = emoji.emojify(text);
  const processedText = emojified.replace(/:([a-z0-9_+-]+):/g, (match, code) => SLACK_EMOJIS[code] || match);
  const lines = processedText.split("\n");

  return (
    <div className="mt-1 space-y-1">
      {lines.map((line, lineIdx) => {
        if (!line.trim()) return <div key={lineIdx} className="h-1.5" />;
        const parts = line.split(/(\*[^*]+\*|_[^_]+_|`[^`]+`)/g);

        return (
          <p key={lineIdx} className="text-sm leading-relaxed text-foreground/90">
            {parts.map((part, partIdx) => {
              if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
                return (
                  <strong key={partIdx} className="font-semibold text-foreground">
                    {part.slice(1, -1)}
                  </strong>
                );
              }
              if (part.startsWith("_") && part.endsWith("_") && part.length > 2) {
                return (
                  <em key={partIdx} className="italic text-foreground/85">
                    {part.slice(1, -1)}
                  </em>
                );
              }
              if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
                return (
                  <code key={partIdx} className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-primary">
                    {part.slice(1, -1)}
                  </code>
                );
              }
              return part;
            })}
          </p>
        );
      })}
    </div>
  );
}


function cleanSlackTextForTitle(rawText: string): string {
  if (!rawText) return "Follow up on Slack message";

  let cleaned = rawText.replace(/:([a-z0-9_+-]+):/g, (match, code) => SLACK_EMOJIS[code] || match);
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);

  let firstLine = lines[0] || cleaned;
  firstLine = firstLine
    .replace(/^[-*_]{3,}$/g, "")
    .replace(/[*_~`]/g, "")
    .trim();

  if (!firstLine && lines[1]) {
    firstLine = lines[1].replace(/[*_~`]/g, "").trim();
  }

  return (firstLine.slice(0, 80) || "Follow up on Slack message").trim();
}

function ConvertToTaskDialog({
  message,
  onClose,
}: {
  message: SlackMessage;
  onClose: () => void;
}) {
  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const { data: users = [] } = useUsers();
  const convertTask = useConvertSlackToTask();

  const [title, setTitle] = useState(() => cleanSlackTextForTitle(message.text));
  const [projectId, setProjectId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [priority, setPriority] = useState<"High" | "Medium" | "Low" | "Urgent">("Medium");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || !title.trim()) {
      toast.error("Please choose a project and enter a task title.");
      return;
    }

    convertTask.mutate(
      {
        projectId,
        name: title.trim(),
        assigneeId: assigneeId || undefined,
        priority,
        slackMessageUrl: message.permalink,
        text: message.text,
      },
      {
        onSuccess: () => {
          toast.success(`Task "${title.slice(0, 30)}..." created!`);
          onClose();
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to create task"),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(val) => !val && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckSquare className="size-5 text-primary" />
              Convert Slack Message to Task
            </DialogTitle>
            <DialogDescription>
              Create an actionable task in your Dashboard from #{message.channelName}.
            </DialogDescription>
          </DialogHeader>

          {/* Task fields on the left, the Slack context it came from on the right. */}
          <div className="grid gap-x-5 gap-y-4 py-4 md:grid-cols-2">
            <div className="grid gap-1.5 md:col-span-2">
              <Label htmlFor="task-title">Task Title</Label>
              <Input
                id="task-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title"
              />
            </div>

            <div className="grid content-start gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="task-project">Project</Label>
              <Select value={projectId} onValueChange={(val) => setProjectId(val ?? "")}>
                <SelectTrigger id="task-project">
                  <SelectValue placeholder={projectsLoading ? "Loading projects..." : "Select a project"} />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="task-assignee">Assignee (Optional)</Label>
              <Select value={assigneeId} onValueChange={(val) => setAssigneeId(val ?? "")}>
                <SelectTrigger id="task-assignee">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name} ({u.role})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="task-priority">Priority</Label>
              <Select value={priority} onValueChange={(val) => setPriority((val as any) ?? "Medium")}>
                <SelectTrigger id="task-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Urgent">Urgent</SelectItem>
                  <SelectItem value="High">High</SelectItem>
                  <SelectItem value="Medium">Medium</SelectItem>
                  <SelectItem value="Low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
            </div>

            <div className="rounded-lg bg-secondary/60 p-2.5 text-xs text-muted-foreground">
              <p className="mb-1 font-semibold text-foreground">Slack Context Included:</p>
              <div className="max-h-48 overflow-y-auto rounded bg-background/60 p-2 ring-1 ring-foreground/10">
                <FormattedSlackText text={message.text} />
              </div>
              <p className="mt-1.5 text-[11px]">Permalink will be saved to task description.</p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={convertTask.isPending || !projectId}>
              {convertTask.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Create Task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}


