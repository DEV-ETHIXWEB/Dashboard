import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Check, ChevronRight, Trash2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useNotifications, useMarkNotificationRead, useClearAllNotifications } from "@/hooks/useData";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { tapFeedback } from "@/lib/haptics";
import { groupByDay, kindOf, kindsPresent, lookFor, type NotificationKind } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import type { Notification } from "@/lib/entities";

type Filter = "all" | "unread" | NotificationKind;

/**
 * One screen, two audiences.
 *
 * A client opens this to answer "did anything happen to my stuff?", so the
 * wording is theirs and the whole row is a way into the thing that moved. Staff
 * open it as a work queue, so they get the same rows plus filters by kind and
 * the count of what is still unread.
 *
 * Everything is grouped by day and unread items carry a dot rather than a
 * colour wash: a list where half the rows are highlighted stops meaning
 * anything.
 */
export default function Notifications() {
  const { user } = useAuth();
  const isClient = user?.role === "client";
  const navigate = useNavigate();

  const { data: notifications, isLoading, isError, error, refetch } = useNotifications();
  const qc = useQueryClient();
  const markRead = useMarkNotificationRead();
  const clearAll = useClearAllNotifications();
  const [filter, setFilter] = useState<Filter>("all");

  const markAllRead = useMutation({
    mutationFn: () => api("POST", "/notifications/read-all"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      toast.success("All caught up");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not mark these as read"),
  });

  const all = useMemo(() => notifications ?? [], [notifications]);
  const unread = all.filter((n) => !n.read);

  const kinds = useMemo(() => kindsPresent(all), [all]);
  const filtered = useMemo(() => {
    if (filter === "all") return all;
    if (filter === "unread") return all.filter((n) => !n.read);
    return all.filter((n) => kindOf(n.type) === filter);
  }, [all, filter]);

  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  function open(item: Notification) {
    tapFeedback();
    if (!item.read) markRead.mutate(item.id);
    const { to } = lookFor(kindOf(item.type), isClient);
    if (to) navigate(to);
  }

  function clear() {
    if (!window.confirm("Clear everything here? This cannot be undone.")) return;
    clearAll.mutate(undefined, {
      onSuccess: () => toast.success("Cleared"),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not clear these"),
    });
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title={isClient ? "Alerts" : "Notifications"}
        description={
          isClient
            ? "Anything that changed on your account, newest first."
            : "Assignments, handovers, and client activity across the workspace."
        }
        actions={
          all.length > 0 ? (
            <div className="flex items-center gap-2">
              {unread.length > 0 && (
                <Button
                  variant="secondary"
                  className="h-10 px-4"
                  onClick={() => markAllRead.mutate()}
                  disabled={markAllRead.isPending}
                >
                  <Check className="size-4" />
                  <span className="hidden sm:inline">Mark all as read</span>
                  <span className="sm:hidden">Mark all</span>
                </Button>
              )}
              <Button
                variant="ghost"
                // The label is hidden on a phone, so the button needs its own.
                aria-label="Clear all"
                title="Clear all"
                className="h-10 px-4 text-muted-foreground hover:text-destructive"
                onClick={clear}
                disabled={clearAll.isPending}
              >
                <Trash2 className="size-4" />
                <span className="hidden sm:inline">Clear all</span>
              </Button>
            </div>
          ) : undefined
        }
      />

      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-56 rounded-full" />
          <Skeleton className="h-20 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
        </div>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : all.length === 0 ? (
        <EmptyState
          icon={Bell}
          title={isClient ? "Nothing to tell you yet" : "No notifications"}
          description={
            isClient
              ? "When we move something on your account, it lands here first."
              : "Assignments and client activity will appear here."
          }
        />
      ) : (
        <>
          <FilterBar
            filter={filter}
            onChange={setFilter}
            unread={unread.length}
            kinds={kinds}
            isClient={isClient}
          />

          {filtered.length === 0 ? (
            <EmptyState
              icon={BellOff}
              title={filter === "unread" ? "Nothing unread" : "Nothing in here"}
              description="Try another filter."
              action={
                <Button variant="secondary" className="mt-2 h-10 px-4" onClick={() => setFilter("all")}>
                  Show everything
                </Button>
              }
            />
          ) : (
            <div className="mt-4 flex flex-col gap-5">
              {groups.map((group) => (
                <section key={group.heading}>
                  <h2 className="px-1 pb-2 t-label text-muted-foreground">
                    {group.heading}
                  </h2>
                  <ul className="overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10">
                    {group.items.map((item, index) => (
                      <li key={item.id}>
                        <Row
                          item={item}
                          isClient={isClient}
                          first={index === 0}
                          onOpen={() => open(item)}
                          onMarkRead={() => markRead.mutate(item.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FilterBar({
  filter,
  onChange,
  unread,
  kinds,
  isClient,
}: {
  filter: Filter;
  onChange: (next: Filter) => void;
  unread: number;
  kinds: NotificationKind[];
  isClient: boolean;
}) {
  const chips: { key: Filter; label: string; count?: number }[] = [
    { key: "all", label: "All" },
    { key: "unread", label: "Unread", count: unread },
    ...kinds.map((k) => ({ key: k as Filter, label: lookFor(k, isClient).label })),
  ];

  return (
    <div
      role="tablist"
      aria-label="Filter notifications"
      className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
    >
      {chips.map((chip) => {
        const active = filter === chip.key;
        return (
          <button
            key={chip.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              tapFeedback();
              onChange(chip.key);
            }}
            className={cn(
              "focus-clear touch-control flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm transition-colors",
              active
                ? "bg-primary text-primary-foreground font-medium"
                : "bg-secondary text-muted-foreground hover:text-foreground",
            )}
          >
            {chip.label}
            {chip.count != null && chip.count > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] leading-4 font-semibold",
                  active ? "bg-primary-foreground/20" : "bg-primary text-primary-foreground",
                )}
              >
                {chip.count > 99 ? "99+" : chip.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Row({
  item,
  isClient,
  first,
  onOpen,
  onMarkRead,
}: {
  item: Notification;
  isClient: boolean;
  first: boolean;
  onOpen: () => void;
  onMarkRead: () => void;
}) {
  const kind = kindOf(item.type);
  const look = lookFor(kind, isClient);
  const at = new Date(item.createdAt).getTime();
  const Icon = look.icon;

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-3 transition-colors sm:px-4",
        !first && "border-t border-row-border",
        !item.read && "bg-primary/[0.035]",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="focus-clear -m-1 flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 text-left active:opacity-70"
      >
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", look.tone)}>
          <Icon aria-hidden className="size-[18px]" strokeWidth={1.9} />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {!item.read && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />}
            <span
              className={cn(
                "min-w-0 flex-1 text-[15px] leading-snug",
                item.read ? "font-normal text-foreground/90" : "font-medium text-foreground",
              )}
            >
              {item.message}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <time dateTime={item.createdAt} title={formatDateTime(at)}>
              {formatRelativeTime(at)}
            </time>
            <span aria-hidden>·</span>
            <span>{look.label}</span>
            {!item.read && <span className="sr-only">Unread</span>}
          </span>
        </span>

        {look.to && <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
      </button>

      {!item.read && (
        <button
          type="button"
          onClick={onMarkRead}
          aria-label="Mark as read"
          title="Mark as read"
          className="tap-target focus-clear hidden shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:text-foreground sm:inline-flex"
        >
          <Check aria-hidden className="size-4" />
        </button>
      )}
    </div>
  );
}
