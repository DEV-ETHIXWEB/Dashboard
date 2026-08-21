import { useState, useMemo } from "react";
import { toast } from "sonner";
import {
  ShieldCheck,
  Plus,
  Search,
  X,
  Loader2,
  KeyRound,
  RefreshCw,
  Copy,
  Trash2,
  CalendarClock,
  Building2,
  Mail,
  Clock,
  AlertTriangle,
  Infinity as InfinityIcon,
  LayoutGrid,
  Check,
  Link2,
} from "lucide-react";
import { useUsers, useCreateUser, useUpdateUser, useDeleteUser } from "@/hooks/useData";
import { api, ApiError } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SummaryCard } from "@/components/SummaryCard";
import { initials, toLocalISO, parseLocalISO } from "@/lib/format";
import { CLIENT_PAGES, CLIENT_PAGE_KEYS, describeAccess } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import type { UserRecord } from "@/lib/entities";
import type { ClientPageKey, LoginLinkResponse } from "@/lib/types";

const DAY_MS = 86_400_000;

type Credential = { name: string; email: string; password: string; emailed: boolean };
type SignInLink = { name: string; email: string; url: string; expiresAt: number };

/**
 * Tick list of the sections a client login may open. Ticking every box sends
 * `null` -- "no restriction" -- so the account keeps any section added later.
 */
function PageToggles({
  selected,
  onChange,
  className,
}: {
  selected: ClientPageKey[];
  onChange: (next: ClientPageKey[]) => void;
  className?: string;
}) {
  const allOn = selected.length === CLIENT_PAGE_KEYS.length;

  return (
    <div className={`space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3 ${className ?? ""}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <LayoutGrid className="size-3.5 shrink-0 text-primary" />
          <span className="text-xs font-medium">What this client can see</span>
        </div>
        <button
          type="button"
          onClick={() => onChange(allOn ? [] : [...CLIENT_PAGE_KEYS])}
          className="text-[11px] font-medium text-primary hover:underline"
        >
          {allOn ? "Clear all" : "Select all"}
        </button>
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2">
        {CLIENT_PAGES.map((page) => {
          const on = selected.includes(page.key);
          return (
            <button
              key={page.key}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange(on ? selected.filter((k) => k !== page.key) : [...selected, page.key])
              }
              className={`flex items-start gap-2 rounded-lg border p-2 text-left transition-colors ${
                on
                  ? "border-primary/40 bg-primary/10"
                  : "border-border/60 bg-background/40 hover:border-border"
              }`}
            >
              <span
                className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${
                  on ? "border-primary bg-primary text-primary-foreground" : "border-border/70"
                }`}
              >
                {on && <Check className="size-3" />}
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-foreground">{page.label}</span>
                <span className="block text-[11px] leading-tight text-muted-foreground">
                  {page.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {selected.length === 0 && (
        <p className="text-[11px] leading-relaxed text-amber-500">
          Nothing selected - they will sign in and only see their dashboard.
        </p>
      )}
    </div>
  );
}

function toDateInput(ts?: number | null) {
  return ts ? toLocalISO(new Date(ts)) : "";
}

function endOfDay(dateStr: string) {
  const d = parseLocalISO(dateStr);
  if (!d) return null;
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function accessStatus(u: UserRecord) {
  if (!u.passwordExpiresAt) {
    return {
      label: "No expiry",
      icon: InfinityIcon,
      className: "bg-muted text-muted-foreground border-border/40",
    };
  }
  const diff = u.passwordExpiresAt - Date.now();
  if (diff <= 0) {
    return {
      label: "Expired",
      icon: AlertTriangle,
      className: "bg-destructive/10 text-destructive border-destructive/30 font-medium",
    };
  }
  const days = Math.ceil(diff / DAY_MS);
  return {
    label: `Expires in ${days}d`,
    icon: Clock,
    className:
      days <= 7
        ? "bg-amber-500/15 text-amber-400 border-amber-500/30 font-medium"
        : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 font-medium",
  };
}

export default function ClientAccess() {
  const { data: users, isLoading, isError, error, refetch } = useUsers();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();

  const [issueOpen, setIssueOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [noExpiry, setNoExpiry] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [pages, setPages] = useState<ClientPageKey[]>([...CLIENT_PAGE_KEYS]);

  const [expiryTarget, setExpiryTarget] = useState<UserRecord | null>(null);
  const [expiryDraft, setExpiryDraft] = useState("");

  const [accessTarget, setAccessTarget] = useState<UserRecord | null>(null);
  const [accessDraft, setAccessDraft] = useState<ClientPageKey[]>([]);

  const [credential, setCredential] = useState<Credential | null>(null);
  const [signInLink, setSignInLink] = useState<SignInLink | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const clients = useMemo(() => (users ?? []).filter((u) => u.role === "client"), [users]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        (u.company ?? "").toLowerCase().includes(q),
    );
  }, [clients, search]);

  const stats = useMemo(() => {
    const now = Date.now();
    return {
      total: clients.length,
      expired: clients.filter((u) => u.passwordExpiresAt && u.passwordExpiresAt <= now).length,
      expiring: clients.filter(
        (u) => u.passwordExpiresAt && u.passwordExpiresAt > now && u.passwordExpiresAt - now <= 7 * DAY_MS,
      ).length,
      perpetual: clients.filter((u) => !u.passwordExpiresAt).length,
      limited: clients.filter((u) => u.allowedPages != null && u.allowedPages.length < CLIENT_PAGE_KEYS.length)
        .length,
    };
  }, [clients]);

  function openIssue() {
    setName("");
    setEmail("");
    setCompany("");
    setNoExpiry(false);
    setExpiresAt(toDateInput(Date.now() + 30 * DAY_MS));
    setPages([...CLIENT_PAGE_KEYS]);
    setIssueOpen(true);
  }

  function issue() {
    if (!name.trim() || !email.trim()) {
      toast.error("Name and email are required");
      return;
    }
    if (!noExpiry && !expiresAt) {
      toast.error("Pick an expiry date, or choose 'No expiry'");
      return;
    }
    createUser.mutate(
      {
        name,
        email,
        role: "client",
        company: company || null,
        passwordExpiresAt: noExpiry ? null : endOfDay(expiresAt),
        // Everything ticked means "no restriction", so future sections stay visible.
        allowedPages: pages.length === CLIENT_PAGE_KEYS.length ? null : pages,
      },
      {
        onSuccess: (data) => {
          setIssueOpen(false);
          setCredential({ name, email, password: data.temporaryPassword, emailed: Boolean(data.emailed) });
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create the client"),
      },
    );
  }

  function reissue(u: UserRecord) {
    if (
      !window.confirm(
        `Generate a new password for ${u.name}?\n\nTheir current password stops working immediately and any active session is signed out.`,
      )
    )
      return;
    setBusyId(u.id);
    updateUser.mutate(
      { id: u.id, patch: { regeneratePassword: true } },
      {
        onSuccess: (data) => {
          if (data.temporaryPassword) {
            setCredential({
              name: u.name,
              email: u.email,
              password: data.temporaryPassword,
              emailed: Boolean(data.emailed),
            });
          }
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not regenerate the password"),
        onSettled: () => setBusyId(null),
      },
    );
  }

  /**
   * Mint a one-tap sign-in link for this client and show it for handover.
   *
   * The absolute URL is built from the origin this portal is being served from,
   * not from anything the server guesses: in development that is the Vite dev
   * server on :5173, which proxies /api to the backend, so the link a client
   * receives points at the same address the admin is looking at.
   */
  async function issueSignInLink(u: UserRecord) {
    setBusyId(u.id);
    try {
      const d = await api<LoginLinkResponse>("POST", `/auth/login-link/${u.id}`);
      const url = `${window.location.origin}${d.path}`;
      setSignInLink({ name: u.name, email: u.email, url, expiresAt: d.expiresAt });
      try {
        await navigator.clipboard.writeText(url);
        toast.success("Sign-in link copied");
      } catch {
        toast.message("Link ready - copy it from the dialog");
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not create a sign-in link");
    } finally {
      setBusyId(null);
    }
  }

  function openExpiry(u: UserRecord) {
    setExpiryTarget(u);
    setExpiryDraft(toDateInput(u.passwordExpiresAt));
  }

  function saveExpiry() {
    if (!expiryTarget) return;
    setBusyId(expiryTarget.id);
    updateUser.mutate(
      { id: expiryTarget.id, patch: { passwordExpiresAt: expiryDraft ? endOfDay(expiryDraft) : null } },
      {
        onSuccess: () => {
          toast.success("Expiry updated");
          setExpiryTarget(null);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update the expiry"),
        onSettled: () => setBusyId(null),
      },
    );
  }

  function openAccess(u: UserRecord) {
    setAccessTarget(u);
    setAccessDraft(u.allowedPages == null ? [...CLIENT_PAGE_KEYS] : [...u.allowedPages]);
  }

  function saveAccess() {
    if (!accessTarget) return;
    setBusyId(accessTarget.id);
    updateUser.mutate(
      {
        id: accessTarget.id,
        patch: {
          allowedPages: accessDraft.length === CLIENT_PAGE_KEYS.length ? null : accessDraft,
        },
      },
      {
        onSuccess: () => {
          toast.success("Access updated");
          setAccessTarget(null);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update access"),
        onSettled: () => setBusyId(null),
      },
    );
  }

  function revoke(u: UserRecord) {
    if (!window.confirm(`Revoke access for ${u.name}?\n\nTheir account is deleted permanently.`)) return;
    setBusyId(u.id);
    deleteUser.mutate(u.id, {
      onSuccess: () => toast.success("Access revoked"),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not revoke access"),
      onSettled: () => setBusyId(null),
    });
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title="Client Access"
        description="Issue client logins, set when their password expires, and reissue or revoke access."
        actions={
          <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
            <DialogTrigger render={<Button onClick={openIssue} className="h-10 px-4 gap-2 font-medium shadow-xs" />}>
              <Plus className="size-4" /> New Client Login
            </DialogTrigger>
            <DialogContent
              showCloseButton={false}
              className="sm:max-w-3xl p-0 gap-0 overflow-hidden border border-border/60 shadow-2xl rounded-2xl bg-card"
            >
              <div className="relative p-6 pb-4 border-b border-border/40 bg-gradient-to-br from-primary/10 via-background to-background">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-xs">
                      <ShieldCheck className="size-5" />
                    </div>
                    <div>
                      <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
                        New Client Login
                      </DialogTitle>
                      <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                        The password is generated for you and shown once.
                      </DialogDescription>
                    </div>
                  </div>
                  <DialogClose className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors">
                    <X className="size-4" />
                  </DialogClose>
                </div>
              </div>

              {/* Two columns: who they are on the left, what they get on the right. */}
              <div className="no-scrollbar grid max-h-[72svh] gap-5 overflow-y-auto overscroll-contain p-6 md:grid-cols-2">
                <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Full Name *</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Sarah Connor"
                    className="bg-background/50 border-border/60"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Login ID (email) *</Label>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="sarah@acmecorp.com"
                    className="bg-background/50 border-border/60"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Company</Label>
                  <Input
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="e.g. Acme Corp"
                    className="bg-background/50 border-border/60"
                  />
                </div>

                <div className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <CalendarClock className="size-3.5 shrink-0 text-primary" />
                      <span className="text-xs font-medium">Password expires</span>
                    </div>
                    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={noExpiry}
                        onChange={(e) => setNoExpiry(e.target.checked)}
                        className="size-3.5 accent-primary cursor-pointer"
                      />
                      No expiry
                    </label>
                  </div>
                  {!noExpiry && (
                    <>
                      <DatePicker
                        value={expiresAt}
                        onChange={setExpiresAt}
                        min={toDateInput(Date.now())}
                        clearable={false}
                        placeholder="Choose an expiry date"
                      />
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        After this date they can't sign in until you issue a new password.
                      </p>
                    </>
                  )}
                </div>
                </div>

                <PageToggles selected={pages} onChange={setPages} className="md:h-full" />
              </div>

              <DialogFooter className="m-0 px-6 py-4 bg-muted/30 border-t border-border/40 flex flex-row items-center justify-end gap-2.5 rounded-b-2xl">
                <DialogClose render={<Button variant="ghost" className="h-9 text-xs px-3.5 text-muted-foreground hover:text-foreground" />}>
                  Cancel
                </DialogClose>
                <Button
                  onClick={issue}
                  disabled={createUser.isPending || !name.trim() || !email.trim()}
                  className="h-9 px-4 text-xs font-medium gap-1.5 shadow-xs"
                >
                  {createUser.isPending ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      Creating…
                    </>
                  ) : (
                    "Create & generate password"
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <SummaryCard icon={ShieldCheck} value={stats.total} label="Client Logins" tone="primary" />
        <SummaryCard
          icon={AlertTriangle}
          value={stats.expired}
          label="Expired"
          tone={stats.expired > 0 ? "danger" : "muted"}
        />
        <SummaryCard
          icon={Clock}
          value={stats.expiring}
          label="Expiring ≤ 7d"
          tone={stats.expiring > 0 ? "warning" : "muted"}
        />
        <SummaryCard icon={InfinityIcon} value={stats.perpetual} label="No Expiry" />
        <SummaryCard icon={LayoutGrid} value={stats.limited} label="Limited Access" />
      </div>

      <div className="flex items-center gap-3 p-1.5 bg-card/60 border border-border/60 rounded-xl backdrop-blur-xs">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, or company..."
            className="pl-9 h-9 border-none bg-transparent focus-visible:ring-0 text-xs"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-2xl" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={search ? "No matching clients" : "No client logins yet"}
          description={
            search
              ? "Try a different search term."
              : "Click 'New Client Login' to create a client and generate their password."
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((u) => {
            const status = accessStatus(u);
            const busy = busyId === u.id;
            return (
              <div
                key={u.id}
                className="p-4 rounded-2xl border border-border/60 bg-card/80 shadow-xs hover:border-border transition-all duration-150 flex items-center justify-between gap-4 flex-wrap"
                style={busy ? { opacity: 0.55 } : undefined}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar className="size-11 shrink-0 ring-1 ring-border/80 shadow-xs">
                    <AvatarFallback className="bg-muted text-xs font-semibold text-foreground border border-border/40">
                      {initials(u.name)}
                    </AvatarFallback>
                  </Avatar>

                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground truncate">{u.name}</span>
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border ${status.className}`}
                      >
                        <status.icon className="size-2.5" />
                        {status.label}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                      <span className="flex items-center gap-1 truncate">
                        <Mail className="size-3 shrink-0 text-muted-foreground/70" />
                        {u.email}
                      </span>
                      {u.company && (
                        <span className="flex items-center gap-1 truncate text-foreground/80 font-medium">
                          <Building2 className="size-3 shrink-0 text-primary" />
                          {u.company}
                        </span>
                      )}
                      {u.passwordExpiresAt && (
                        <span className="flex items-center gap-1 truncate">
                          <CalendarClock className="size-3 shrink-0 text-muted-foreground/70" />
                          {new Date(u.passwordExpiresAt).toLocaleDateString()}
                        </span>
                      )}
                      <span
                        className="flex items-center gap-1 truncate"
                        title={describeAccess(u.allowedPages)}
                      >
                        <LayoutGrid className="size-3 shrink-0 text-muted-foreground/70" />
                        {describeAccess(u.allowedPages)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Four buttons do not fit beside a name on a phone: let them
                    wrap under it rather than widening the page. */}
                <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => reissue(u)}
                    className="h-8 text-xs gap-1.5"
                  >
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                    New password
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => issueSignInLink(u)}
                    title="Create a one-tap sign-in link to send this client"
                    className="h-8 text-xs gap-1.5"
                  >
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
                    Sign-in link
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => openAccess(u)}
                    className="h-8 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                  >
                    <LayoutGrid className="size-3.5" />
                    Access
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => openExpiry(u)}
                    className="h-8 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                  >
                    <CalendarClock className="size-3.5" />
                    Expiry
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy}
                    aria-label={`Revoke access for ${u.name}`}
                    title="Revoke access"
                    onClick={() => revoke(u)}
                    className="hover:bg-destructive/10 hover:text-destructive text-destructive/80 transition-colors"
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={Boolean(accessTarget)} onOpenChange={(v) => !v && setAccessTarget(null)}>
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-md p-0 gap-0 overflow-hidden border border-border/60 shadow-2xl rounded-2xl bg-card"
        >
          <div className="relative p-6 pb-4 border-b border-border/40 bg-gradient-to-br from-primary/10 via-background to-background">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-xs">
                  <LayoutGrid className="size-5" />
                </div>
                <div>
                  <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
                    Section access
                  </DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                    For {accessTarget?.name}. Takes effect on their next page load.
                  </DialogDescription>
                </div>
              </div>
              <DialogClose className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors">
                <X className="size-4" />
              </DialogClose>
            </div>
          </div>

          <div className="p-6">
            <PageToggles selected={accessDraft} onChange={setAccessDraft} />
          </div>

          <DialogFooter className="m-0 px-6 py-4 bg-muted/30 border-t border-border/40 flex flex-row items-center justify-end gap-2.5 rounded-b-2xl">
            <DialogClose render={<Button variant="ghost" className="h-9 text-xs px-3.5 text-muted-foreground hover:text-foreground" />}>
              Cancel
            </DialogClose>
            <Button onClick={saveAccess} disabled={updateUser.isPending} className="h-9 px-4 text-xs font-medium gap-1.5 shadow-xs">
              {updateUser.isPending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save access"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(expiryTarget)} onOpenChange={(v) => !v && setExpiryTarget(null)}>
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-xl p-0 gap-0 overflow-hidden border border-border/60 shadow-2xl rounded-2xl bg-card"
        >
          <div className="relative p-6 pb-4 border-b border-border/40 bg-gradient-to-br from-primary/10 via-background to-background">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-xs">
                  <CalendarClock className="size-5" />
                </div>
                <div>
                  <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
                    Password expiry
                  </DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                    For {expiryTarget?.name}.
                  </DialogDescription>
                </div>
              </div>
              <DialogClose className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors">
                <X className="size-4" />
              </DialogClose>
            </div>
          </div>

          <div className="grid items-start gap-5 p-6 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Expires on</Label>
              <DatePicker
                value={expiryDraft}
                onChange={setExpiryDraft}
                min={toDateInput(Date.now())}
                placeholder="No expiry - permanent access"
              />
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground md:pt-6">
              Leave the date empty to remove the expiry entirely and give them permanent access.
            </p>
          </div>

          <DialogFooter className="m-0 px-6 py-4 bg-muted/30 border-t border-border/40 flex flex-row items-center justify-end gap-2.5 rounded-b-2xl">
            <DialogClose render={<Button variant="ghost" className="h-9 text-xs px-3.5 text-muted-foreground hover:text-foreground" />}>
              Cancel
            </DialogClose>
            <Button onClick={saveExpiry} disabled={updateUser.isPending} className="h-9 px-4 text-xs font-medium gap-1.5 shadow-xs">
              {updateUser.isPending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save expiry"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(signInLink)} onOpenChange={(v) => !v && setSignInLink(null)}>
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-lg p-0 gap-0 overflow-hidden border border-border/60 shadow-2xl rounded-2xl bg-card"
        >
          <div className="relative p-6 pb-4 border-b border-border/40 bg-gradient-to-br from-primary/10 via-background to-background">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-xs">
                  <Link2 className="size-5" />
                </div>
                <div>
                  <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
                    Sign-in link ready
                  </DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                    For {signInLink?.name}. Send it over WhatsApp, SMS, or email.
                  </DialogDescription>
                </div>
              </div>
              <DialogClose className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors">
                <X className="size-4" />
              </DialogClose>
            </div>
          </div>

          <div className="space-y-4 p-6">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Link</Label>
              <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2.5">
                <span className="flex-1 break-all font-mono text-xs leading-relaxed text-foreground select-all">
                  {signInLink?.url}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Copy sign-in link"
                  onClick={async () => {
                    if (!signInLink) return;
                    try {
                      await navigator.clipboard.writeText(signInLink.url);
                      toast.success("Sign-in link copied");
                    } catch {
                      toast.error("Couldn't copy - select and copy manually");
                    }
                  }}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
            </div>

            <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-warning">
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              <span>
                Anyone who opens this link is signed in as {signInLink?.name} - it works once, and
                only until{" "}
                {signInLink ? new Date(signInLink.expiresAt).toLocaleTimeString() : ""}. Send it
                straight to them, not to a shared channel.
              </span>
            </div>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Creating a link cancels any earlier unused one for this client. Their password keeps
              working either way.
            </p>
          </div>

          <DialogFooter className="m-0 px-6 py-4 bg-muted/30 border-t border-border/40 flex flex-row items-center justify-end gap-2.5 rounded-b-2xl">
            <DialogClose render={<Button className="h-9 text-xs px-4 font-medium" />}>Done</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(credential)} onOpenChange={(v) => !v && setCredential(null)}>
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-md p-0 gap-0 overflow-hidden border border-border/60 shadow-2xl rounded-2xl bg-card"
        >
          <div className="relative p-6 pb-4 border-b border-border/40 bg-gradient-to-br from-primary/10 via-background to-background">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-xs">
                  <KeyRound className="size-5" />
                </div>
                <div>
                  <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
                    Password generated
                  </DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                    Shown once - copy it before closing.
                  </DialogDescription>
                </div>
              </div>
              <DialogClose className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors">
                <X className="size-4" />
              </DialogClose>
            </div>
          </div>

          <div className="grid gap-4 p-6 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Login ID</Label>
              <div className="truncate rounded-lg border border-border/60 bg-background/50 px-3 py-2.5 text-sm text-foreground">
                {credential?.email}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Password</Label>
              <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2.5">
                <span className="flex-1 font-mono text-sm tracking-wide text-foreground select-all">
                  {credential?.password}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Copy password"
                  onClick={async () => {
                    if (!credential) return;
                    try {
                      await navigator.clipboard.writeText(credential.password);
                      toast.success("Password copied");
                    } catch {
                      toast.error("Couldn't copy - select and copy manually");
                    }
                  }}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
            </div>

            <div className="md:col-span-2 space-y-2">
              <div
                className={cn(
                  "flex items-start gap-2 rounded-lg px-3 py-2 text-[11px] leading-relaxed",
                  credential?.emailed
                    ? "bg-success/10 text-success"
                    : "bg-warning/10 text-warning",
                )}
              >
                {credential?.emailed ? (
                  <Check className="mt-px size-3.5 shrink-0" />
                ) : (
                  <AlertTriangle className="mt-px size-3.5 shrink-0" />
                )}
                <span>
                  {credential?.emailed
                    ? `Emailed to ${credential.email} with sign-in instructions.`
                    : "Not emailed - no mail transport is configured, so hand this over yourself."}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                It isn't stored anywhere you can read it again - if it's lost, use “New password” to
                issue another.
              </p>
            </div>
          </div>

          <DialogFooter className="m-0 px-6 py-4 bg-muted/30 border-t border-border/40 flex flex-row items-center justify-end gap-2.5 rounded-b-2xl">
            <DialogClose render={<Button className="h-9 text-xs px-4 font-medium" />}>Done</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
