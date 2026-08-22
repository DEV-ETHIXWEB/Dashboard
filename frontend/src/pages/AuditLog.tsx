import { useMemo, useState } from "react";
import { Crown, ScrollText, Search } from "lucide-react";
import { useAuditLog } from "@/hooks/useApprovals";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatRelativeTime, initials } from "@/lib/format";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { tapFeedback } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import type { AuditEntry } from "@/lib/types";

/** What each verb did, in a word, and how loud it should look. */
const ACTION_TONE: Record<string, string> = {
  create: "bg-success/15 text-success",
  update: "bg-info/15 text-info",
  delete: "bg-destructive/10 text-destructive",
  approve: "bg-success/15 text-success",
  reject: "bg-destructive/10 text-destructive",
  standing: "bg-primary/10 text-primary",
  login: "bg-secondary text-muted-foreground",
  reveal: "bg-warning/15 text-warning",
  sync: "bg-info/15 text-info",
};

const DESTRUCTIVE = new Set(["delete", "reject", "standing", "reveal"]);

/**
 * The super admin's window on everyone else.
 *
 * Every write in this app already calls `audit()`; this is the first screen
 * that reads it. Newest first, one row per entry, with the person named rather
 * than an id — an id in a log is a second lookup nobody performs.
 */
export default function AuditLog() {
  const { data, isLoading, isError, error, refetch } = useAuditLog();
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<"all" | "sensitive">("all");

  const entries = useMemo(() => {
    const all = data?.entries ?? [];
    const needle = query.trim().toLowerCase();
    return all.filter((e) => {
      if (only === "sensitive" && !DESTRUCTIVE.has(e.action)) return false;
      if (!needle) return true;
      return [e.actorName, e.action, e.entity, e.entityId].join(" ").toLowerCase().includes(needle);
    });
  }, [data, query, only]);

  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader
        title="Audit log"
        description="Every change in this workspace, newest first, with the person who made it."
      />

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by person, action, or record"
            className="pl-9"
            aria-label="Search the audit log"
          />
        </div>
        <div role="tablist" aria-label="Filter" className="flex gap-2">
          {(["all", "sensitive"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={only === key}
              onClick={() => {
                tapFeedback();
                setOnly(key);
              }}
              className={cn(
                "focus-clear touch-control h-9 shrink-0 rounded-full px-3.5 text-sm transition-colors coarse:h-11",
                only === key
                  ? "bg-primary font-medium text-primary-foreground"
                  : "bg-secondary text-muted-foreground hover:text-foreground",
              )}
            >
              {key === "all" ? "Everything" : "Sensitive only"}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-2xl" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={query || only === "sensitive" ? "Nothing matches" : "Nothing logged yet"}
          description={
            query || only === "sensitive"
              ? "Try a different search, or show everything."
              : "Every change made from here on will be listed."
          }
        />
      ) : (
        <>
          <ul className="overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10">
            {entries.map((entry, i) => (
              <li key={entry.id}>
                <LogRow entry={entry} first={i === 0} />
              </li>
            ))}
          </ul>
          <p className="mt-3 px-1 text-xs text-muted-foreground">
            Showing {entries.length} of {data?.total ?? entries.length} entries.
          </p>
        </>
      )}
    </div>
  );
}

function LogRow({ entry, first }: { entry: AuditEntry; first: boolean }) {
  const at = new Date(entry.createdAt).getTime();
  const tone = ACTION_TONE[entry.action] ?? "bg-secondary text-muted-foreground";

  return (
    <div className={cn("flex items-center gap-3 px-3 py-3 sm:px-4", !first && "border-t border-row-border")}>
      <Avatar className="size-9 shrink-0">
        <AvatarFallback className="bg-secondary text-[11px] font-semibold text-muted-foreground">
          {initials(entry.actorName)}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
          <span className="font-medium">{entry.actorName}</span>
          {entry.actorIsSuperAdmin && (
            <Crown aria-label="Super admin" className="size-3.5 shrink-0 text-primary" />
          )}
          <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] font-semibold", tone)}>
            {entry.action}
          </span>
          <span className="text-muted-foreground">{entry.entity}</span>
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {entry.entityId ?? "—"}
        </p>
      </div>

      <time
        dateTime={entry.createdAt}
        title={formatDateTime(at)}
        className="shrink-0 numeric text-xs text-muted-foreground"
      >
        {formatRelativeTime(at)}
      </time>
    </div>
  );
}
