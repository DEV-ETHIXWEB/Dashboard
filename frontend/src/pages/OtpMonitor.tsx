import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  KeyRound, Eye, EyeOff, Mail, Globe, Clock, Loader2, Search, X, Copy, CheckCircle2, TriangleAlert,
} from "lucide-react";
import { useOtpLogs, useRevealOtpCode } from "@/hooks/useData";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { SummaryCard } from "@/components/SummaryCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

function statusBadge(expiresAt: number, consumed: boolean) {
  if (consumed) return { label: "Used", className: "bg-muted text-muted-foreground border-border/40" };
  if (Date.now() > expiresAt) return { label: "Expired", className: "bg-destructive/10 text-destructive border-destructive/30" };
  return { label: "Active", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 font-medium" };
}

export default function OtpMonitor() {
  const { data: logs, isLoading, isError, error, refetch } = useOtpLogs();
  const revealCode = useRevealOtpCode();
  const [revealed, setRevealed] = useState<Map<string, string>>(new Map());
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return logs ?? [];
    return (logs ?? []).filter(
      (l) =>
        l.name.toLowerCase().includes(q) ||
        l.email.toLowerCase().includes(q) ||
        (l.ipAddress ?? "").toLowerCase().includes(q),
    );
  }, [logs, search]);

  const stats = useMemo(() => {
    const list = logs ?? [];
    const now = Date.now();
    return {
      active: list.filter((l) => !l.consumed && l.expiresAt > now).length,
      used: list.filter((l) => l.consumed).length,
      expired: list.filter((l) => !l.consumed && l.expiresAt <= now).length,
    };
  }, [logs]);

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Code copied");
    } catch {
      toast.error("Couldn't copy - read it out instead");
    }
  }

  function toggleReveal(id: string) {
    if (revealed.has(id)) {
      setRevealed((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      return;
    }
    setRevealingId(id);
    revealCode.mutate(id, {
      onSuccess: (code) => {
        setRevealed((prev) => new Map(prev).set(id, code));
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to reveal code"),
      onSettled: () => setRevealingId(null),
    });
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title="Login Codes"
        description="One-time codes generated when a client passes the password step. Reveal a code and read it out to confirm their identity."
      />

      <div className="grid grid-cols-3 gap-3">
        <SummaryCard icon={KeyRound} value={stats.active} label="Active now" tone="primary" />
        <SummaryCard icon={CheckCircle2} value={stats.used} label="Used" />
        <SummaryCard
          icon={TriangleAlert}
          value={stats.expired}
          label="Expired unused"
          tone={stats.expired > 0 ? "warning" : "muted"}
        />
      </div>

      <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 p-1.5 backdrop-blur-xs">
        <div className="relative w-full sm:w-72">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, or IP..."
            className="h-9 border-none bg-transparent pl-9 text-xs focus-visible:ring-0"
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
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-2xl" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title={search ? "No matching codes" : "No login codes yet"}
          description={
            search
              ? "Try a different name, email, or IP."
              : "Codes appear here the moment a client's email and password are accepted."
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((log) => {
            const badge = statusBadge(log.expiresAt, log.consumed);
            const revealedCode = revealed.get(log.id);
            const isRevealing = revealingId === log.id;
            return (
              <div
                key={log.id}
                className="p-4 rounded-2xl border border-border/60 bg-card/80 shadow-xs hover:border-border transition-all duration-150 flex items-center justify-between gap-4 flex-wrap"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-foreground truncate">{log.name}</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] border ${badge.className}`}>
                      {badge.label}
                    </span>
                    {log.attempts > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        {log.attempts} attempt{log.attempts === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                    <span className="flex items-center gap-1 truncate">
                      <Mail className="size-3 shrink-0 text-muted-foreground/70" />
                      {log.email}
                    </span>
                    <span className="flex items-center gap-1 truncate">
                      <Globe className="size-3 shrink-0 text-muted-foreground/70" />
                      {log.ipAddress || "Unknown IP"}
                    </span>
                    <span className="flex items-center gap-1 truncate">
                      <Clock className="size-3 shrink-0 text-muted-foreground/70" />
                      {new Date(log.createdAt).toLocaleString()}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono text-lg tracking-[0.3em] text-foreground min-w-[7ch] text-center">
                    {revealedCode ?? "••••••"}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={revealedCode ? "Hide code" : "Reveal code"}
                    onClick={() => toggleReveal(log.id)}
                    disabled={isRevealing}
                    className="hover:bg-primary/10 hover:text-primary transition-colors"
                  >
                    {isRevealing ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : revealedCode ? (
                      <EyeOff className="size-3.5" />
                    ) : (
                      <Eye className="size-3.5" />
                    )}
                  </Button>
                  {revealedCode && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Copy code"
                      onClick={() => copyCode(revealedCode)}
                      className="hover:bg-primary/10 hover:text-primary transition-colors"
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
