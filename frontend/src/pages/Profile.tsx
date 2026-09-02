import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  AtSign,
  Building2,
  CalendarClock,
  Check,
  Clock,
  Fingerprint,
  HelpCircle,
  KeyRound,
  Loader2,
  LogIn,
  type LucideIcon,
  Monitor,
  Pencil,
  Shield,
  ShieldCheck,
  Smartphone,
  Tablet,
  UserRound,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/ErrorState";
import { EmptyState } from "@/components/EmptyState";
import { AvatarUploader } from "@/components/AvatarUploader";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { PasswordStatusBadge } from "@/components/PasswordStatusBadge";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/context/AuthContext";
import { useProfile, useRevokeOtherSessions, useUpdateOwnDetails, type ProfileActivity } from "@/hooks/useProfile";
import { formatDate, formatDateTime, formatRelativeTime } from "@/lib/format";
import { describePassword } from "@/lib/password";
import { impactFeedback } from "@/lib/haptics";

const ROLE_LABEL: Record<string, string> = {
  admin: "Administrator",
  sales: "Sales",
  project_manager: "Project Manager",
  employee: "Team Member",
  client: "Client",
};

/**
 * Plain words for an audit action.
 *
 * The log stores machine names because it is read by administrators looking for
 * a specific thing. On somebody's own profile the same rows are read by a
 * person checking nothing odd has happened to their account, and "password_reset"
 * is not what they are scanning for.
 */
const ACTIVITY_LABEL: Record<string, string> = {
  login: "Signed in",
  logout: "Signed out",
  password_reset: "Password reset using a link",
  password_reset_requested: "A password reset link was requested",
  password_expired: "Password reached the end of its month",
  recovery_codes: "Backup sign-in codes regenerated",
  avatar_updated: "Profile picture updated",
  avatar_removed: "Profile picture removed",
  issue_login_link: "A one-tap sign-in link was created",
  reveal_otp: "A sign-in code was read out to help you sign in",
  credential_delivery_sent: "Account activation email sent",
  credential_delivery_scheduled: "Account activation email scheduled",
  credential_delivery_cancelled: "Scheduled activation email cancelled",
};

function activityLabel(row: ProfileActivity): string {
  return ACTIVITY_LABEL[row.action] ?? row.action.replace(/_/g, " ");
}

/** A glyph per device family, so the list is scannable before it is read. */
const DEVICE_ICON: Record<string, LucideIcon> = {
  phone: Smartphone,
  tablet: Tablet,
  desktop: Monitor,
  unknown: HelpCircle,
};

/** One label-and-value line. Used across all three information cards. */
function Fact({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground">
        <Icon aria-hidden className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="t-label text-muted-foreground">{label}</div>
        <div className="mt-0.5 truncate text-sm font-medium text-foreground">{value}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </div>
    </div>
  );
}

export default function Profile() {
  const { user, can } = useAuth();
  const { data, isLoading, isError, error, refetch } = useProfile();
  const updateDetails = useUpdateOwnDetails();
  const revokeSessions = useRevokeOtherSessions();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const status = data?.passwordStatus ?? user?.passwordStatus;
  const otherSessions = useMemo(
    () => (data?.sessions ?? []).filter((s) => !s.current),
    [data?.sessions],
  );

  function startEditing() {
    setName(user?.name ?? "");
    setEmail(user?.email ?? "");
    setEditing(true);
  }

  async function saveDetails() {
    if (!name.trim()) {
      toast.error("A name is required");
      return;
    }
    try {
      await updateDetails.mutateAsync({ name: name.trim(), email: email.trim() });
      setEditing(false);
      toast.success("Profile updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save those details");
    }
  }

  async function signOutOthers() {
    if (!window.confirm("Sign out every other browser and phone? You will stay signed in here.")) return;
    impactFeedback();
    try {
      const result = await revokeSessions.mutateAsync();
      toast.success(
        result.revoked === 0
          ? "There were no other sessions to sign out"
          : `Signed out ${result.revoked} other ${result.revoked === 1 ? "session" : "sessions"}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sign those out");
    }
  }

  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <PageHeader title="Your profile" description="Your details, your security, and what your account has been doing." />

      {/* The identity block sits above the tabs rather than inside one, so the
          picture and name are on screen whichever section is open. */}
      <Card>
        <CardContent className="flex flex-col gap-5 pt-6 sm:flex-row sm:items-center sm:justify-between">
          {isLoading || !user ? (
            <div className="flex items-center gap-4">
              <Skeleton className="size-20 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <AvatarUploader user={user} canEdit />
                <div className="min-w-0 text-center sm:text-left">
                  <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                    <h2 className="truncate text-lg font-semibold text-foreground">{user.name}</h2>
                    <span className="inline-flex shrink-0 items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                      {ROLE_LABEL[user.role] ?? user.role}
                    </span>
                    <PasswordStatusBadge status={status} />
                  </div>
                  <p className="mt-1 truncate text-sm text-muted-foreground">{user.email}</p>
                </div>
              </div>

              {!editing && (
                <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={startEditing}>
                  <Pencil className="size-3.5" />
                  Edit details
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="personal">
        {/* Four tabs are wider than a phone, and the shell clips horizontal
            overflow rather than letting the whole app scroll sideways -- so the
            last one would simply be unreachable. Scrolls in its own lane
            instead, the same way the role filters on Client Access do. */}
        <div className="no-scrollbar -mx-1 overflow-x-auto px-1 py-1">
          {/* The shared default is a 3px inset around the pills, which is right
              for two short tabs and leaves these four sitting hard against the
              track. Padded here rather than in the primitive so nothing else
              that uses Tabs moves. */}
          <TabsList className="h-9 gap-0.5 p-1">
            <TabsTrigger value="personal" className="px-3">Personal</TabsTrigger>
            <TabsTrigger value="security" className="px-3">Account &amp; security</TabsTrigger>
            <TabsTrigger value="preferences" className="px-3">Preferences</TabsTrigger>
            <TabsTrigger value="activity" className="px-3">Activity</TabsTrigger>
          </TabsList>
        </div>

        {/* --- personal ------------------------------------------------- */}
        <TabsContent value="personal" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Personal information</CardTitle>
              <CardDescription>What the rest of the workspace sees when your name comes up.</CardDescription>
            </CardHeader>
            <CardContent>
              {editing ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="profile-name" className="text-xs font-medium">Full name</Label>
                    <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} className="bg-background/50" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="profile-email" className="text-xs font-medium">Email</Label>
                    <Input id="profile-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="bg-background/50" />
                    <p className="text-xs text-muted-foreground">This is also the address you sign in with.</p>
                  </div>
                  <div className="flex items-center gap-2 sm:col-span-2">
                    <Button size="sm" onClick={saveDetails} disabled={updateDetails.isPending} className="gap-1.5">
                      {updateDetails.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                      Save changes
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={updateDetails.isPending}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="grid gap-5 sm:grid-cols-2">
                  <Fact icon={UserRound} label="Full name" value={user?.name ?? "—"} />
                  <Fact icon={AtSign} label="Email" value={user?.email ?? "—"} />
                  <Fact icon={Shield} label="Role" value={ROLE_LABEL[user?.role ?? ""] ?? user?.role ?? "—"} />
                  {user?.company && <Fact icon={Building2} label="Company" value={user.company} />}
                  <Fact
                    icon={Fingerprint}
                    label="User ID"
                    value={<span className="font-mono text-xs">{user?.id ?? "—"}</span>}
                    hint="Quote this if you ever need support with your account."
                  />
                  {user?.passwordExpiresAt != null && (
                    <Fact
                      icon={CalendarClock}
                      label="Access until"
                      value={formatDate(new Date(user.passwordExpiresAt).toISOString())}
                      hint="After this date your login stops working until an admin renews it."
                    />
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* --- security ------------------------------------------------- */}
        <TabsContent value="security" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="size-4 text-primary" />
                Password
              </CardTitle>
              <CardDescription>{describePassword(status)}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              <Fact
                icon={KeyRound}
                label="Status"
                value={<PasswordStatusBadge status={status} className="text-[11px]" />}
              />
              <Fact
                icon={Clock}
                label="Last changed"
                value={status?.changedAt ? formatDateTime(status.changedAt) : "Not recorded"}
                hint={status?.changedAt ? formatRelativeTime(status.changedAt) : undefined}
              />
              <Fact
                icon={CalendarClock}
                label="Expires"
                value={status?.expiresAt ? formatDateTime(status.expiresAt) : "Not enforced"}
                hint={
                  status?.policyEnabled
                    ? `This workspace replaces passwords every ${status.maxAgeDays} days.`
                    : "Password rotation is switched off for this workspace."
                }
              />
              <Fact
                icon={LogIn}
                label="Last sign-in"
                value={data?.lastLoginAt ? formatDateTime(new Date(data.lastLoginAt).getTime()) : "—"}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Change your password</CardTitle>
              <CardDescription>
                We never email you a password. Nobody here, including administrators, can read the one you pick.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChangePasswordForm />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Monitor className="size-4 text-primary" />
                Where you are signed in
              </CardTitle>
              <CardDescription>
                Every browser and phone holding a live session for your account.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {isLoading ? (
                <Skeleton className="h-16 w-full rounded-xl" />
              ) : (
                <>
                  <ul className="space-y-2">
                    {(data?.sessions ?? []).map((session) => {
                      const DeviceIcon = DEVICE_ICON[session.deviceKind] ?? Monitor;
                      return (
                        <li
                          key={session.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/60 text-muted-foreground">
                              <DeviceIcon aria-hidden className="size-4" />
                            </div>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                                {/* The browser and platform it signed in from, so an
                                    unfamiliar row is actually recognisable as one. */}
                                {session.device}
                                {session.current && (
                                  <span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">
                                    This device
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {session.ipAddress && (
                                  <span className="numeric">{session.ipAddress} · </span>
                                )}
                                Signed in {formatRelativeTime(session.createdAt)} · expires{" "}
                                {formatRelativeTime(session.expiresAt)}
                              </div>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  <Button
                    variant="outline"
                    size="sm"
                    disabled={otherSessions.length === 0 || revokeSessions.isPending}
                    onClick={signOutOthers}
                    className="gap-1.5"
                  >
                    {revokeSessions.isPending && <Loader2 className="size-3.5 animate-spin" />}
                    {otherSessions.length === 0
                      ? "No other sessions"
                      : `Sign out ${otherSessions.length} other ${otherSessions.length === 1 ? "session" : "sessions"}`}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          {/* Backup codes are an administrator's recovery path and live on their
              own page. Pointed at rather than duplicated here. */}
          {can.isSuperAdmin || user?.role === "admin" ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Backup sign-in codes</CardTitle>
                <CardDescription>
                  Administrators sign in with a password and an emailed code. Backup codes stand in when email is
                  not reaching you — they live on the Security page.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : null}
        </TabsContent>

        {/* --- preferences ---------------------------------------------- */}
        <TabsContent value="preferences" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Appearance</CardTitle>
              <CardDescription>How the dashboard looks on this device. Remembered per browser.</CardDescription>
            </CardHeader>
            <CardContent>
              <ThemeSwitch />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Notifications</CardTitle>
              <CardDescription>
                You are notified in the dashboard about work assigned to you and about anything that touches your
                account's security. Those alerts cannot be switched off — they are the record that something
                happened.
              </CardDescription>
            </CardHeader>
          </Card>
        </TabsContent>

        {/* --- activity ------------------------------------------------- */}
        <TabsContent value="activity" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="size-4 text-primary" />
                Recent account activity
              </CardTitle>
              <CardDescription>
                Sign-ins and security events on your own account. If something here is not you, tell an
                administrator.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-2">
                  {[...Array(4)].map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full rounded-xl" />
                  ))}
                </div>
              ) : (data?.activity ?? []).length === 0 ? (
                <EmptyState
                  icon={Activity}
                  title="Nothing recorded yet"
                  description="Sign-ins and security events on your account will appear here."
                />
              ) : (
                <ul className="space-y-2">
                  {(data?.activity ?? []).map((row) => (
                    <li
                      key={row.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground">{activityLabel(row)}</div>
                        <div className="text-xs text-muted-foreground">{row.actor}</div>
                      </div>
                      <div
                        className="shrink-0 text-xs text-muted-foreground"
                        title={formatDateTime(new Date(row.createdAt).getTime())}
                      >
                        {formatRelativeTime(new Date(row.createdAt).getTime())}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
