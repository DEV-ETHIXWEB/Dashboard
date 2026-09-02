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
  Send,
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
import { DateTimePicker } from "@/components/ui/date-time-picker";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
  DialogClose,
  DialogHeader,
} from "@/components/ui/dialog";
import { UserAvatar } from "@/components/UserAvatar";
import { PasswordStatusBadge } from "@/components/PasswordStatusBadge";
import { SummaryCard } from "@/components/SummaryCard";
import { formatRelativeTime, toLocalISO, parseLocalISO } from "@/lib/format";
import { DELIVERY_LABEL, DELIVERY_TONE, describeDelivery } from "@/lib/password";
import {
  useCancelDelivery, useCredentialDeliveries, useRetryDelivery, useScheduleDelivery,
} from "@/hooks/useCredentials";
import { impactFeedback } from "@/lib/haptics";
import { CLIENT_PAGES, CLIENT_PAGE_KEYS, describeAccess } from "@/lib/permissions";
import { LINK_LIFETIMES } from "@/lib/types";
import { useSlackChannels } from "@/hooks/useIntegrations";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { UserRecord } from "@/lib/entities";
import type { ClientPageKey, CredentialDelivery, LoginLinkResponse } from "@/lib/types";

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

/**
 * The status of a scheduled credential hand-over, as one pill.
 *
 * Nothing at all when there is no delivery on record, which is most rows most
 * of the time -- a badge that says "none" on every line teaches people to stop
 * reading the column.
 */
function DeliveryBadge({ delivery }: { delivery?: CredentialDelivery | null }) {
  if (!delivery) return null;
  const explanation = describeDelivery(delivery);
  return (
    <span
      title={explanation ?? undefined}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold ${DELIVERY_TONE[delivery.status]}`}
    >
      <Send aria-hidden className="size-2.5" />
      {DELIVERY_LABEL[delivery.status]}
      {delivery.status === "scheduled" && delivery.scheduledAt
        ? ` ${formatRelativeTime(delivery.scheduledAt)}`
        : ""}
    </span>
  );
}

/**
 * The moments an admin reaches for most, so the common case is one tap.
 *
 * Nine in the morning rather than the current time of day: a credential email
 * is something the recipient should find at the start of their day, not at
 * 11pm when it was convenient to schedule it.
 */
const DELIVERY_PRESETS = [
  { label: "In an hour", at: () => Date.now() + 60 * 60 * 1000 },
  {
    label: "Tomorrow, 9am",
    at: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    },
  },
  {
    label: "Next Monday, 9am",
    at: () => {
      const d = new Date();
      // 1 is Monday; the modulo lands on the next one even when today is Monday.
      d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    },
  },
];

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
  const [slackChannelId, setSlackChannelId] = useState("");
  // How long the next sign-in link should live. Remembered between links so
  // an admin handing out several does not re-pick every time.
  const [linkMinutes, setLinkMinutes] = useState(15);
  const [linkTarget, setLinkTarget] = useState<UserRecord | null>(null);
  const { data: slackChannels } = useSlackChannels();

  const [expiryTarget, setExpiryTarget] = useState<UserRecord | null>(null);
  const [expiryDraft, setExpiryDraft] = useState("");

  const [accessTarget, setAccessTarget] = useState<UserRecord | null>(null);
  const [accessDraft, setAccessDraft] = useState<ClientPageKey[]>([]);

  const [deliveryTarget, setDeliveryTarget] = useState<UserRecord | null>(null);
  const [deliveryDraft, setDeliveryDraft] = useState<number | null>(null);
  const deliveryConfig = useCredentialDeliveries();
  const scheduleDelivery = useScheduleDelivery();
  const cancelDelivery = useCancelDelivery();
  const retryDelivery = useRetryDelivery();

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
        slackChannelId: slackChannelId || null,
        slackChannelName: slackChannelId
          ? (slackChannels ?? []).find((c) => c.id === slackChannelId)?.name ?? null
          : null,
      },
      {
        onSuccess: (data) => {
          setIssueOpen(false);
          setCredential({ name, email, password: data.temporaryPassword, emailed: Boolean(data.emailed) });
          // The bot adds itself to public channels; a private one needs a human.
          if (data.slackChannel && !data.slackChannel.joined) {
            toast.warning(data.slackChannel.message ?? "The bot could not join that channel.", { duration: 9000 });
          }
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
    // Confirmed, and this one does not come back. The heavy tap marks the
    // moment the decision was actually taken.
    impactFeedback();
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
  async function issueSignInLink(u: UserRecord, minutes = linkMinutes) {
    setBusyId(u.id);
    // Close the chooser before the round trip, not after it succeeds: leaving
    // it up means two dialogs stacked on screen for as long as Slack, the
    // database, and the network take between them.
    setLinkTarget(null);
    try {
      const d = await api<LoginLinkResponse>("POST", `/auth/login-link/${u.id}`, {
        expiresInMinutes: minutes,
      });
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

  function openDelivery(u: UserRecord) {
    setDeliveryTarget(u);
    // An existing schedule opens on its own moment, so "reschedule" starts
    // from what was booked rather than from a blank field.
    setDeliveryDraft(u.credentialDelivery?.scheduledAt ?? Date.now() + 60 * 60 * 1000);
  }

  async function saveDelivery() {
    if (!deliveryTarget) return;
    const scheduledAt = deliveryDraft;
    if (!scheduledAt) {
      toast.error("Pick a date and time");
      return;
    }
    try {
      const result = await scheduleDelivery.mutateAsync({ userId: deliveryTarget.id, scheduledAt });
      setDeliveryTarget(null);
      toast.success(
        result.rescheduled
          ? `Moved to ${new Date(scheduledAt).toLocaleString()}`
          : `Scheduled for ${new Date(scheduledAt).toLocaleString()}`,
      );
      // Worth saying once, at the moment somebody books one: a schedule with no
      // transport behind it fails silently later, which is the worst time to
      // find out.
      if (result.emailConfigured === false) {
        toast.warning("No email transport is configured, so this will fail when it comes due.", {
          duration: 9000,
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not schedule that");
    }
  }

  async function callOffDelivery() {
    if (!deliveryTarget) return;
    if (!window.confirm(`Cancel the scheduled login email for ${deliveryTarget.name}?`)) return;
    impactFeedback();
    try {
      await cancelDelivery.mutateAsync(deliveryTarget.id);
      setDeliveryTarget(null);
      toast.success("Delivery cancelled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not cancel that");
    }
  }

  async function sendAgain() {
    const delivery = deliveryTarget?.credentialDelivery;
    if (!delivery) return;
    try {
      const result = await retryDelivery.mutateAsync(delivery.id);
      if (result.sent) {
        setDeliveryTarget(null);
        toast.success("Sent");
      } else {
        toast.error(result.error ?? "It failed again. Check the Mail page for the reason.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not retry that");
    }
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

    // Confirmed, and this one does not come back. The heavy tap marks the

    // moment the decision was actually taken.

    impactFeedback();
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

                {/* One channel, chosen here, is the only Slack this client can
                    ever reach. The warning is not decoration: designating a
                    channel makes everything already in it visible to them. */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Their Slack channel</Label>
                  {slackChannels && slackChannels.length > 0 ? (
                    <>
                      <Select
                        items={{
                          "": "No channel — no Messages page",
                          ...Object.fromEntries(slackChannels.map((c) => [c.id, `#${c.name}`])),
                        }}
                        value={slackChannelId}
                        onValueChange={(v: string | null) => setSlackChannelId(v ?? "")}
                      >
                        <SelectTrigger className="w-full border-border/60 bg-background/50">
                          <SelectValue placeholder="No channel — no Messages page" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">No channel — no Messages page</SelectItem>
                          {slackChannels.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              #{c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        They can read <span className="font-medium text-foreground">everything</span> in
                        this channel and write into it. Pick one shared with them, not an internal room.
                      </p>
                    </>
                  ) : (
                    <p className="rounded-lg bg-secondary px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                      Connect Slack on the Integrations page to give this client a direct line to the team.
                    </p>
                  )}
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
                  <UserAvatar
                    user={u}
                    className="size-11 ring-1 ring-border/80 shadow-xs"
                    fallbackClassName="bg-muted text-xs text-foreground border border-border/40"
                  />

                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground truncate">{u.name}</span>
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border ${status.className}`}
                      >
                        <status.icon className="size-2.5" />
                        {status.label}
                      </span>
                      {/* Two different clocks, side by side on purpose. The pill
                          above is when the *account* lapses; this one is the age
                          of the password. They answer different questions and an
                          admin needs both. */}
                      <PasswordStatusBadge status={u.passwordStatus} />
                      <DeliveryBadge delivery={u.credentialDelivery} />
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
                    onClick={() => setLinkTarget(u)}
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
                    size="sm"
                    disabled={busy}
                    onClick={() => openDelivery(u)}
                    title="Schedule when this client is emailed a link to set their own password"
                    className="h-8 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                  >
                    <Send className="size-3.5" />
                    Delivery
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

      {/* Credential delivery: schedule, reschedule, cancel, retry -- and the
          status of whatever is currently booked. Never shows a link or a
          password, because the server never produces one for anybody to see:
          what is scheduled is an email carrying a single-use link that the
          client redeems to set a password nobody here will know. */}
      <Dialog open={Boolean(deliveryTarget)} onOpenChange={(v) => !v && setDeliveryTarget(null)}>
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-md p-0 gap-0 overflow-hidden border border-border/60 shadow-2xl rounded-2xl bg-card"
        >
          <div className="relative p-6 pb-4 border-b border-border/40 bg-gradient-to-br from-primary/10 via-background to-background">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-xs">
                  <Send className="size-5" />
                </div>
                <div>
                  <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
                    Credential delivery
                  </DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                    When {deliveryTarget?.name} is emailed a link to set their own password.
                  </DialogDescription>
                </div>
              </div>
              <DialogClose className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors">
                <X className="size-4" />
              </DialogClose>
            </div>
          </div>

          <div className="space-y-4 p-6">
            {/* A delivery needs two things the server may not have: something to
                send with, and a public address to point the link at. Without
                either, scheduling one books a failure for later -- so it is said
                here, before the date is picked, rather than discovered when the
                client never receives anything. */}
            {deliveryConfig.data && !deliveryConfig.data.linkBaseConfigured && (
              <div className="flex gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3">
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0 text-xs leading-relaxed text-destructive">
                  <strong className="font-semibold">This will fail.</strong> The server has no public address
                  configured, so it cannot build the activation link. Set <code className="font-mono">APP_BASE_URL</code>
                  {" "}in the environment and restart.
                </div>
              </div>
            )}
            {deliveryConfig.data && !deliveryConfig.data.emailConfigured && (
              <div className="flex gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3">
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                <div className="min-w-0 text-xs leading-relaxed text-warning">
                  No email transport is configured, so nothing can actually be delivered. Check the Mail page.
                </div>
              </div>
            )}

            {deliveryTarget?.credentialDelivery && (
              <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
                <div className="flex items-center gap-2">
                  <DeliveryBadge delivery={deliveryTarget.credentialDelivery} />
                  {deliveryTarget.credentialDelivery.attempts > 0 && (
                    <span className="text-[11px] text-muted-foreground">
                      {deliveryTarget.credentialDelivery.attempts}{" "}
                      {deliveryTarget.credentialDelivery.attempts === 1 ? "attempt" : "attempts"}
                    </span>
                  )}
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {describeDelivery(deliveryTarget.credentialDelivery)}
                </p>
                {deliveryTarget.credentialDelivery.canRetry && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2.5 h-8 gap-1.5 text-xs"
                    disabled={retryDelivery.isPending}
                    onClick={sendAgain}
                  >
                    {retryDelivery.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    Send it now
                  </Button>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="delivery-when" className="text-xs font-medium">
                Send at
              </Label>
              <DateTimePicker
                id="delivery-when"
                value={deliveryDraft}
                onChange={setDeliveryDraft}
                minDate={new Date()}
                presets={DELIVERY_PRESETS}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Your own time zone. The email carries a single-use link that expires on its own — no password
                is ever sent, and nobody here can see the one they choose.
              </p>
            </div>
          </div>

          <DialogFooter className="m-0 px-6 py-4 bg-muted/30 border-t border-border/40 flex flex-row items-center justify-between gap-2.5 rounded-b-2xl">
            {deliveryTarget?.credentialDelivery?.status === "scheduled" ? (
              <Button
                variant="ghost"
                className="h-9 px-3.5 text-xs text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
                disabled={cancelDelivery.isPending}
                onClick={callOffDelivery}
              >
                {cancelDelivery.isPending ? <Loader2 className="size-3.5 animate-spin" /> : "Cancel delivery"}
              </Button>
            ) : (
              <span />
            )}

            <span className="flex items-center gap-2.5">
              <DialogClose render={<Button variant="ghost" className="h-9 text-xs px-3.5 text-muted-foreground hover:text-foreground" />}>
                Close
              </DialogClose>
              <Button
                onClick={saveDelivery}
                disabled={scheduleDelivery.isPending || !deliveryDraft}
                className="h-9 px-4 text-xs font-medium gap-1.5 shadow-xs"
              >
                {scheduleDelivery.isPending ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Saving…
                  </>
                ) : deliveryTarget?.credentialDelivery?.status === "scheduled" ? (
                  "Reschedule"
                ) : (
                  "Schedule"
                )}
              </Button>
            </span>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {/* How long should this link live?
          A sign-in link is a bearer credential -- whoever opens it is the
          client -- so the answer is a deliberate choice rather than one fixed
          number. Handing it over on a call wants five minutes; emailing it to
          somebody in another timezone wants a day. The server clamps whatever
          arrives to between 5 minutes and 7 days regardless. */}
      {/* Rendered only while there is a target, rather than mounted with
          `open={false}`. One modal closing as another opens in the same commit
          left this one mounted and fully visible -- two dialogs stacked, the
          dead one still taking clicks. Unmounting with the state cannot do
          that. */}
      {linkTarget && (
      <Dialog open onOpenChange={(v) => !v && setLinkTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sign-in link for {linkTarget?.name}</DialogTitle>
            <DialogDescription>
              They are signed straight in when they open it. It works once.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 px-1">
            <Label className="text-xs font-medium">Stops working after</Label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {LINK_LIFETIMES.map((option) => {
                const on = linkMinutes === option.minutes;
                return (
                  <button
                    key={option.minutes}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setLinkMinutes(option.minutes)}
                    className={`focus-clear touch-control h-10 rounded-lg border text-sm transition-colors coarse:h-11 ${
                      on
                        ? "border-primary/40 bg-primary/10 font-medium text-primary"
                        : "border-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="t-caption text-muted-foreground">
              Shorter is safer. Anyone holding the link can sign in as{" "}
              {linkTarget?.name ?? "them"} until it expires or is used.
            </p>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setLinkTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={busyId === linkTarget?.id}
              onClick={() => linkTarget && issueSignInLink(linkTarget, linkMinutes)}
            >
              {busyId === linkTarget?.id ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Link2 className="size-4" />
              )}
              Create the link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      )}

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
