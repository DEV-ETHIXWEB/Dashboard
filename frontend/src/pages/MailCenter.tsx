import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle, CheckCircle2, Clock, Eye, Inbox, Loader2, Mail, MailCheck, MailX,
  PlugZap, RefreshCw, Send, ShieldCheck, Trash2, Users, Globe,
} from "lucide-react";
import {
  useDeleteMailLog, useMailLog, useMailLogEntry, useMailPreview, useMailStatus, useMailTemplates,
  useRunDomainSweep, useRunSlaSweep, useSendTestEmail, useVerifyTransport,
} from "@/hooks/useMail";
import { useAuth } from "@/context/AuthContext";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { SummaryCard } from "@/components/SummaryCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { formatRelativeTime } from "@/lib/format";
import { IntegrationNotConnected } from "@/components/IntegrationNotConnected";
import {
  MAIL_SETUP, TEMPLATE_GROUPS, TRANSPORT_LABEL,
  type EmailLogEntry, type EmailStatus, type SmtpSummary,
} from "@/lib/mail";
import { cn } from "@/lib/utils";

/**
 * Everything the app can send, what it looks like, and what actually left.
 *
 * The previews are rendered by the same code that builds real messages, so
 * approving a design here is approving what a client receives.
 */
export default function MailCenter() {
  const { user } = useAuth();
  const isSuperAdmin = user?.isSuperAdmin ?? false;

  const status = useMailStatus();
  const templates = useMailTemplates();
  const log = useMailLog(150);

  const [selected, setSelected] = useState<string | null>(null);
  const [openEntry, setOpenEntry] = useState<EmailLogEntry | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());

  const activeKey = selected ?? templates.data?.[0]?.key ?? null;

  const counts = useMemo(() => {
    const entries = log.data?.entries ?? [];
    return {
      sent: entries.filter((e) => e.status === "sent").length,
      failed: entries.filter((e) => e.status === "failed").length,
      skipped: entries.filter((e) => e.status === "skipped").length,
    };
  }, [log.data]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <PageHeader
        title="Mail"
        description="Every message this dashboard sends, exactly as it will land."
        actions={
          <>
            <DeadlineCheckButton />
      <DomainCheckButton />
            <TestEmailDialog configured={status.data?.configured ?? false} />
          </>
        }
      />

      {status.isError ? (
        <ErrorState title="Could not read the mail settings" error={status.error} onRetry={() => status.refetch()} />
      ) : status.isLoading || !status.data ? (
        <Skeleton className="h-[92px] w-full rounded-2xl" />
      ) : (
        <TransportCard
          configured={status.data.configured}
          transport={status.data.transport}
          from={status.data.from}
          inboxes={status.data.adminInboxes}
          adminCount={status.data.adminCount}
          smtp={status.data.smtp}
        />
      )}

      {status.data && !status.data.configured && (
        <IntegrationNotConnected
          name="Outbound email"
          icon={PlugZap}
          vars={MAIL_SETUP.vars}
          steps={MAIL_SETUP.steps}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard icon={MailCheck} value={counts.sent} label="Delivered" tone="success" />
        <SummaryCard icon={MailX} value={counts.failed} label="Failed" tone={counts.failed ? "danger" : "muted"} />
        <SummaryCard icon={Inbox} value={counts.skipped} label="Held (no transport)" tone={counts.skipped ? "warning" : "muted"} />
      </div>

      <Tabs defaultValue="templates">
        <TabsList className="mb-4 h-11! w-full gap-1 p-1 sm:w-fit">
          <TabsTrigger value="templates" className="px-4">
            Templates
          </TabsTrigger>
          <TabsTrigger value="log" className="px-4">
            Sent log ({log.data?.entries.length ?? 0})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="templates">
          {templates.isError ? (
            <ErrorState error={templates.error} onRetry={() => templates.refetch()} />
          ) : templates.isLoading || !templates.data ? (
            <Skeleton className="h-96 w-full rounded-2xl" />
          ) : (
            <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
              <nav className="space-y-4">
                {TEMPLATE_GROUPS.map((group) => {
                  const items = group.keys
                    .map((k) => templates.data.find((t) => t.key === k))
                    .filter((t): t is NonNullable<typeof t> => t != null);
                  if (items.length === 0) return null;
                  return (
                    <div key={group.heading}>
                      <div className="px-1 pb-1.5 t-label text-muted-foreground">
                        {group.heading}
                      </div>
                      <div className="space-y-1">
                        {items.map((t) => (
                          <button
                            key={t.key}
                            type="button"
                            onClick={() => setSelected(t.key)}
                            aria-pressed={activeKey === t.key}
                            className={cn(
                              "focus-clear w-full rounded-xl px-3 py-2.5 text-left transition-colors",
                              activeKey === t.key
                                ? "bg-primary/10 text-primary ring-1 ring-primary/25"
                                : "hover:bg-foreground/5",
                            )}
                          >
                            <div className="text-sm font-medium">{t.label}</div>
                            <div
                              className={cn(
                                "mt-0.5 text-xs",
                                activeKey === t.key ? "text-primary/80" : "text-muted-foreground",
                              )}
                            >
                              {t.description}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </nav>

              <TemplatePreview templateKey={activeKey} />
            </div>
          )}
        </TabsContent>

        <TabsContent value="log">
          <LogTable
            entries={log.data?.entries ?? []}
            loading={log.isLoading}
            error={log.isError ? log.error : null}
            onRetry={() => log.refetch()}
            refreshing={log.isFetching}
            onOpen={setOpenEntry}
            isSuperAdmin={isSuperAdmin}
            checkedIds={checkedIds}
            onCheckedIdsChange={setCheckedIds}
          />
        </TabsContent>
      </Tabs>

      <MessageDialog entry={openEntry} onClose={() => setOpenEntry(null)} />
    </div>
  );
}

/**
 * Deadline alerts normally ride along on ticket traffic. This runs the same
 * sweep on demand, which is what you want after changing an SLA or an owner.
 */
function DeadlineCheckButton() {
  const sweep = useRunSlaSweep();
  return (
    <Button
      variant="outline"
      className="h-10 gap-2 px-4 font-medium"
      disabled={sweep.isPending}
      onClick={() =>
        sweep.mutate(undefined, {
          onSuccess: (r) =>
            toast.success(
              r.warned > 0
                ? `Alerted on ${r.warned} ticket${r.warned === 1 ? "" : "s"} close to their deadline`
                : "No tickets are close to their first-response deadline",
            ),
          onError: (err) => toast.error(err instanceof Error ? err.message : "Could not run the check"),
        })
      }
    >
      {sweep.isPending ? <Loader2 className="size-4 animate-spin" /> : <Clock className="size-4" />}
      Check deadlines
    </Button>
  );
}

/**
 * Expiry reminders normally ride along on domain traffic, at most once an hour.
 * This runs the same sweep on demand -- what you want after correcting an
 * expiry date, or when nobody has opened the Domains page in a while.
 */
function DomainCheckButton() {
  const sweep = useRunDomainSweep();
  return (
    <Button
      variant="outline"
      className="h-10 gap-2 px-4 font-medium"
      disabled={sweep.isPending}
      onClick={() =>
        sweep.mutate(undefined, {
          onSuccess: (r) =>
            toast.success(
              r.sent > 0
                ? `Reminded ${r.sent} client${r.sent === 1 ? "" : "s"} about an expiring address`
                : r.due > 0
                  ? "Everyone due a reminder has already had one"
                  : "No website addresses are due a reminder",
            ),
          onError: (err) => toast.error(err instanceof Error ? err.message : "Could not run the check"),
        })
      }
    >
      {sweep.isPending ? <Loader2 className="size-4 animate-spin" /> : <Globe className="size-4" />}
      Check domains
    </Button>
  );
}

function TransportCard({
  configured,
  transport,
  from,
  inboxes,
  adminCount,
  smtp,
}: {
  configured: boolean;
  transport: string;
  from: string;
  inboxes: string[];
  adminCount: number;
  smtp: SmtpSummary | null;
}) {
  const label = TRANSPORT_LABEL[transport] ?? transport;
  const verify = useVerifyTransport();

  return (
    <div className="rounded-2xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl",
              configured ? "bg-success/10 text-success" : "bg-warning/10 text-warning",
            )}
          >
            {configured ? <CheckCircle2 className="size-5" /> : <AlertTriangle className="size-5" />}
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight">{label}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {configured ? (
                <>
                  Sending as <span className="font-mono text-xs">{from}</span>
                  {smtp && (
                    <>
                      {" via "}
                      <span className="font-mono text-xs">
                        {smtp.host}:{smtp.port}
                      </span>
                      {smtp.user ? (
                        <>
                          {" as "}
                          <span className="font-mono text-xs">{smtp.user}</span>
                        </>
                      ) : null}
                      {smtp.secure ? " (TLS)" : " (STARTTLS)"}
                    </>
                  )}
                </>
              ) : (
                "Nothing is being delivered. Every message is still rendered and kept below, so you can review the templates now and switch delivery on when the details are in."
              )}
            </p>
            {configured && smtp && !smtp.hasPassword && (
              <p className="mt-1 text-sm text-warning">
                SMTP_PASSWORD is empty. Most providers refuse the connection without it.
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {configured && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              disabled={verify.isPending}
              onClick={() =>
                verify.mutate(undefined, {
                  onSuccess: (r) =>
                    toast.success(r.note ? `${TRANSPORT_LABEL[r.transport] ?? r.transport}: ${r.note}` : "Connected and authenticated"),
                  onError: (err) => toast.error(err instanceof Error ? err.message : "Could not reach the mail server"),
                })
              }
            >
              {verify.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
              Verify connection
            </Button>
          )}
          <div className="flex items-center gap-2 rounded-xl bg-secondary/40 px-3 py-2">
            <Users className="size-4 shrink-0 text-muted-foreground" />
            <div className="text-sm">
              <span className="font-semibold tabular-nums">{adminCount}</span>
              <span className="text-muted-foreground"> admin{adminCount === 1 ? "" : "s"} on alerts</span>
            </div>
          </div>
        </div>
      </div>

      {inboxes.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3">
          <ShieldCheck aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Alerts go to:</span>
          {inboxes.map((address) => (
            <span key={address} className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[11px]">
              {address}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TemplatePreview({ templateKey }: { templateKey: string | null }) {
  const preview = useMailPreview(templateKey);
  const [showText, setShowText] = useState(false);

  if (!templateKey) return null;

  return (
    <div className="min-w-0 rounded-2xl bg-card ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 p-4">
        <div className="min-w-0">
          <div className="t-label text-muted-foreground">Subject</div>
          <div className="truncate text-sm font-semibold">
            {preview.data?.subject ?? (preview.isLoading ? "Loading…" : "—")}
          </div>
        </div>
        <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setShowText((v) => !v)}>
          <Eye className="size-3.5" />
          {showText ? "Show HTML" : "Show plain text"}
        </Button>
      </div>

      {preview.isError ? (
        <div className="p-4">
          <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
        </div>
      ) : showText ? (
        <pre className="scrollbar-slim max-h-[560px] overflow-auto p-4 font-mono text-xs whitespace-pre-wrap text-foreground/90">
          {preview.data?.text ?? ""}
        </pre>
      ) : (
        <iframe
          key={templateKey}
          title={`Preview of the ${templateKey} email`}
          srcDoc={preview.data?.html ?? ""}
          className="h-[560px] w-full rounded-b-2xl border-0 bg-white"
          sandbox=""
        />
      )}
    </div>
  );
}

const STATUS_STYLE: Record<EmailStatus, string> = {
  sent: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  failed: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
  skipped: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
};

function StatusChip({ status }: { status: EmailStatus }) {
  const label = { sent: "Delivered", failed: "Failed", skipped: "Held" }[status] ?? status;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        STATUS_STYLE[status] ?? "bg-zinc-500/10 text-zinc-600 border-zinc-500/20",
      )}
    >
      <span className="size-1 rounded-full bg-current" />
      {label}
    </span>
  );
}

function LogTable({
  entries,
  loading,
  error,
  onRetry,
  refreshing,
  onOpen,
  isSuperAdmin,
  checkedIds,
  onCheckedIdsChange,
}: {
  entries: EmailLogEntry[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  refreshing: boolean;
  onOpen: (entry: EmailLogEntry) => void;
  isSuperAdmin: boolean;
  checkedIds: Set<string>;
  onCheckedIdsChange: (next: Set<string>) => void;
}) {
  if (error) return <ErrorState title="Could not read the mail log" error={error} onRetry={onRetry} />;
  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-2xl" />
        ))}
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={Mail}
        title="Nothing sent yet"
        description="Raise a ticket or issue a login, and every message the app sends shows up here."
      />
    );
  }

  function toggle(id: string) {
    const next = new Set(checkedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onCheckedIdsChange(next);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {isSuperAdmin && checkedIds.size > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-muted-foreground"
              onClick={() => onCheckedIdsChange(new Set())}
            >
              Clear selection ({checkedIds.size})
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isSuperAdmin && (
            <ClearLogDialog
              selectedIds={[...checkedIds]}
              onCleared={() => onCheckedIdsChange(new Set())}
            />
          )}
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground" onClick={onRetry}>
            <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <ul className="space-y-2">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-stretch gap-2">
            {isSuperAdmin && (
              <label className="flex shrink-0 cursor-pointer items-center px-1 select-none">
                <input
                  type="checkbox"
                  checked={checkedIds.has(entry.id)}
                  onChange={() => toggle(entry.id)}
                  aria-label={`Select message: ${entry.subject}`}
                  className="size-3.5 accent-primary cursor-pointer"
                />
              </label>
            )}
            <button
              type="button"
              onClick={() => onOpen(entry)}
              className="focus-clear w-full rounded-2xl bg-card p-4 text-left ring-1 ring-foreground/10 transition-colors hover:ring-foreground/20"
            >
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-72">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 text-sm font-medium break-words">{entry.subject}</span>
                    <StatusChip status={entry.status} />
                  </div>
                  <p className="mt-1 truncate text-sm text-muted-foreground">To {entry.toEmails}</p>
                  {entry.error && <p className="mt-1 text-xs text-destructive">{entry.error}</p>}
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-xs text-muted-foreground">
                    {formatRelativeTime(new Date(entry.createdAt).getTime())}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{entry.template}</div>
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Super-admin only: empty out the mail log, either the messages checked by
 * hand on the list, or everything that landed within a date range.
 */
function ClearLogDialog({ selectedIds, onCleared }: { selectedIds: string[]; onCleared: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"selected" | "range">("selected");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const del = useDeleteMailLog();

  function openDialog() {
    setMode(selectedIds.length > 0 ? "selected" : "range");
    setOpen(true);
  }

  function submit() {
    if (mode === "selected") {
      if (selectedIds.length === 0) return;
      del.mutate(
        { ids: selectedIds },
        {
          onSuccess: (res) => {
            toast.success(`Deleted ${res.removed} message${res.removed === 1 ? "" : "s"} from the log`);
            onCleared();
            setOpen(false);
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Could not delete those messages"),
        },
      );
    } else {
      if (!from || !to) return;
      del.mutate(
        { from, to },
        {
          onSuccess: (res) => {
            toast.success(`Deleted ${res.removed} message${res.removed === 1 ? "" : "s"} from the log`);
            setFrom("");
            setTo("");
            onCleared();
            setOpen(false);
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Could not delete those messages"),
        },
      );
    }
  }

  const canSubmit = mode === "selected" ? selectedIds.length > 0 : Boolean(from && to);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? openDialog() : setOpen(false))}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-muted-foreground hover:text-destructive">
            <Trash2 className="size-3.5" />
            Clear log
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clear mail log entries</DialogTitle>
          <DialogDescription>
            This permanently removes log entries. It does not affect anything that was already sent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-1 rounded-xl bg-secondary/40 p-1">
            <button
              type="button"
              onClick={() => setMode("selected")}
              className={cn(
                "flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                mode === "selected" ? "bg-card shadow-xs ring-1 ring-foreground/10" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Selected ({selectedIds.length})
            </button>
            <button
              type="button"
              onClick={() => setMode("range")}
              className={cn(
                "flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                mode === "range" ? "bg-card shadow-xs ring-1 ring-foreground/10" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Date range
            </button>
          </div>

          {mode === "selected" ? (
            <p className="text-sm text-muted-foreground">
              {selectedIds.length > 0
                ? `${selectedIds.length} message${selectedIds.length === 1 ? "" : "s"} checked on the list will be deleted.`
                : "Check messages on the list first, or switch to a date range."}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="clear-from">From</Label>
                <DatePicker id="clear-from" value={from} onChange={setFrom} placeholder="Start date" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="clear-to">To</Label>
                <DatePicker id="clear-to" value={to} onChange={setTo} min={from || undefined} placeholder="End date" />
              </div>
            </div>
          )}

          <Button
            variant="destructive"
            className="h-10 w-full gap-2"
            disabled={!canSubmit || del.isPending}
            onClick={submit}
          >
            {del.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Delete{mode === "selected" && selectedIds.length > 0 ? ` ${selectedIds.length}` : ""}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MessageDialog({ entry, onClose }: { entry: EmailLogEntry | null; onClose: () => void }) {
  // The list drops the stored body to stay light, so the full one is fetched
  // only for the message actually opened.
  const full = useMailLogEntry(entry?.id ?? null);
  if (!entry) return null;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="scrollbar-slim max-h-[90svh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="pr-8">{entry.subject}</DialogTitle>
          <DialogDescription>
            To {entry.toEmails} · {entry.template} · {entry.status} via {entry.transport}
          </DialogDescription>
        </DialogHeader>

        {entry.error && (
          <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{entry.error}</p>
        )}

        {!entry.hasHtml ? (
          <p className="text-sm text-muted-foreground">This message was logged without a stored body.</p>
        ) : full.isLoading ? (
          <Skeleton className="h-[560px] w-full rounded-xl" />
        ) : full.isError ? (
          <ErrorState title="Could not load the message body" error={full.error} onRetry={() => full.refetch()} />
        ) : (
          <iframe
            title={`Message sent to ${entry.toEmails}`}
            srcDoc={full.data?.html ?? ""}
            className="h-[560px] w-full rounded-xl border border-border/60 bg-white"
            sandbox=""
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TestEmailDialog({ configured }: { configured: boolean }) {
  const { user } = useAuth();
  const send = useSendTestEmail();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const address = (to || user?.email || "").trim();
    if (!address) return;
    send.mutate(address, {
      onSuccess: (res) => {
        toast.success(`Test sent to ${res.to}`);
        setOpen(false);
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not send the test"),
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button className="h-10 gap-2 px-4 font-medium" disabled={!configured}>
            <Send className="size-4" /> Send test
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send a test message</DialogTitle>
          <DialogDescription>
            Fires a real email through the configured transport so you can check delivery and rendering.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="test-to">Send to</Label>
            <Input
              id="test-to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={user?.email ?? "you@example.com"}
            />
          </div>
          <Button type="submit" className="h-10 w-full gap-2" disabled={send.isPending}>
            {send.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Send it
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
