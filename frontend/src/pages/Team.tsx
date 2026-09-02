import { useState, useMemo } from "react";
import { toast } from "sonner";
import {
  Users,
  Plus,
  Pencil,
  Trash2,
  Search,
  Shield,
  Briefcase,
  Building2,
  Mail,
  X,
  Loader2,
  LayoutGrid,
  Crown,
  ShieldQuestion,
  ShieldCheck,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { useUsers, useCreateUser, useUpdateUser, useDeleteUser } from "@/hooks/useData";
import { useSetStanding } from "@/hooks/useApprovals";
import { isHeldForApproval } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { UserAvatar } from "@/components/UserAvatar";
import { PasswordStatusBadge } from "@/components/PasswordStatusBadge";
import { SummaryCard } from "@/components/SummaryCard";
import { describeAccess } from "@/lib/permissions";
import { impactFeedback } from "@/lib/haptics";
import type { UserRecord } from "@/lib/entities";

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  sales: "Sales",
  project_manager: "Project Manager",
  employee: "Employee",
  client: "Client",
};

const STAFF_ROLES: Record<string, string> = {
  admin: "Admin",
  sales: "Sales",
  project_manager: "Project Manager",
  employee: "Employee",
};

export default function Team() {
  const { user: currentUser } = useAuth();
  const { data: users, isLoading, isError, error, refetch } = useUsers();
  const createUser = useCreateUser();
  const [newAdminCodes, setNewAdminCodes] = useState<{ name: string; codes: string[] } | null>(null);
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const setStanding = useSetStanding();
  const { can } = useAuth();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<UserRecord | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("employee");
  const [company, setCompany] = useState("");
  const [password, setPassword] = useState("");

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("All");

  function openCreate() {
    setEditing(null);
    setName("");
    setEmail("");
    setRole("employee");
    setCompany("");
    setPassword("");
    setOpen(true);
  }

  function openEdit(u: UserRecord) {
    setEditing(u);
    setName(u.name);
    setEmail(u.email);
    setRole(u.role);
    setCompany(u.company ?? "");
    setPassword("");
    setOpen(true);
  }

  function submit() {
    if (!name.trim() || !email.trim()) {
      toast.error("Name and email are required");
      return;
    }
    if (editing) {
      const patch: Record<string, unknown> = { name, company: company || null };
      if (password) patch.password = password;
      updateUser.mutate(
        { id: editing.id, patch },
        {
          onSuccess: () => {
            toast.success("Team member updated");
            setOpen(false);
          },
          // A 202 is parked for a second signature, not applied. Saying
          // "updated" would send them away believing it landed.
          onError: (err) => {
            if (isHeldForApproval(err)) {
              toast.success(err.message, { duration: 6000 });
              setOpen(false);
              return;
            }
            toast.error(err instanceof Error ? err.message : "Failed to update");
          },
        },
      );
    } else {
      if (!password) {
        toast.error("Password is required");
        return;
      }
      createUser.mutate(
        { name, email, role, company: company || null, password },
        {
          onSuccess: (result) => {
            toast.success("Team member added");
            // A new administrator is issued backup sign-in codes with their
            // password, and this is the only moment either is visible. Hand
            // both over together; the new admin can replace the codes from
            // their own Security page afterwards.
            if (result.recoveryCodes?.length) setNewAdminCodes({ name, codes: result.recoveryCodes });
            setOpen(false);
          },
          // Held for approval: no account exists yet, so there are no codes to
          // hand over and nothing to show but the queue's own message.
          onError: (err) => {
            if (isHeldForApproval(err)) {
              toast.success(err.message, { duration: 6000 });
              setOpen(false);
              return;
            }
            toast.error(err instanceof Error ? err.message : "Failed to add member");
          },
        },
      );
    }
  }

  function changeStanding(u: UserRecord, patch: { superAdmin?: boolean; trusted?: boolean }) {
    const what = patch.superAdmin === true
      ? `Make ${u.name} a super admin? They will be able to appoint other admins and act without approval.`
      : patch.superAdmin === false
        ? `Step ${u.name} down to an ordinary admin?`
        : patch.trusted
          ? `Let ${u.name} make sensitive changes without a second signature?`
          : `Send ${u.name}'s sensitive changes for approval again?`;
    if (!window.confirm(what)) return;

    // Confirmed, and this one does not come back. The heavy tap marks the

    // moment the decision was actually taken.

    impactFeedback();

    setStanding.mutate(
      { id: u.id, ...patch },
      {
        onSuccess: () => toast.success("Standing updated"),
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not change that"),
      },
    );
  }

  function remove(u: UserRecord) {
    if (!window.confirm(`Remove ${u.name}? Their assigned tasks/tickets will show as unassigned.`)) return;

    // Confirmed, and this one does not come back. The heavy tap marks the

    // moment the decision was actually taken.

    impactFeedback();
    deleteUser.mutate(u.id, {
      onSuccess: () => toast.success("User removed"),
      onError: (err) =>
        isHeldForApproval(err)
          ? toast.success(err.message, { duration: 6000 })
          : toast.error(err instanceof Error ? err.message : "Failed to remove user"),
    });
  }

  const roleBadgeStyle = (r: string) => {
    switch (r) {
      case "admin":
        return "bg-primary/15 text-primary border-primary/30 font-medium";
      case "project_manager":
        return "bg-purple-500/15 text-purple-400 border-purple-500/30 font-medium";
      case "sales":
        return "bg-amber-500/15 text-amber-400 border-amber-500/30 font-medium";
      case "employee":
        return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 font-medium";
      case "client":
        return "bg-cyan-500/15 text-cyan-400 border-cyan-500/30 font-medium";
      default:
        return "bg-muted text-muted-foreground border-border/40 font-medium";
    }
  };

  const filteredUsers = useMemo(() => {
    return (users ?? []).filter((u) => {
      const matchesSearch =
        u.name.toLowerCase().includes(search.toLowerCase()) ||
        u.email.toLowerCase().includes(search.toLowerCase()) ||
        (u.company && u.company.toLowerCase().includes(search.toLowerCase()));
      const matchesRole = roleFilter === "All" || u.role === roleFilter;
      return matchesSearch && matchesRole;
    });
  }, [users, search, roleFilter]);

  const stats = useMemo(() => {
    const list = users ?? [];
    return {
      total: list.length,
      // Administrators are counted on their own: this workspace supports any
      // number of them, and the last one cannot be removed, so the number is
      // something an admin needs to see rather than infer.
      admins: list.filter((u) => u.role === "admin").length,
      staff: list.filter((u) => ["project_manager", "employee", "sales"].includes(u.role)).length,
      clients: list.filter((u) => u.role === "client").length,
    };
  }, [users]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title="Team"
        description="Manage workspace users, roles, and client portal permissions."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button onClick={openCreate} className="h-10 px-4 gap-2 font-medium shadow-xs" />}>
              <Plus className="size-4" /> Add Team Member
            </DialogTrigger>
            <DialogContent
              showCloseButton={false}
              className="sm:max-w-2xl p-0 gap-0 overflow-hidden border border-border/60 shadow-2xl rounded-2xl bg-card"
            >
              <div className="relative p-6 pb-4 border-b border-border/40 bg-gradient-to-br from-primary/10 via-background to-background">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-xs">
                      <Users className="size-5" />
                    </div>
                    <div>
                      <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
                        {editing ? "Edit Team Member" : "Add Team Member"}
                      </DialogTitle>
                      <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                        {editing ? "Update details for this team member." : "Grant new access to the workspace CRM."}
                      </DialogDescription>
                    </div>
                  </div>
                  <DialogClose className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors">
                    <X className="size-4" />
                  </DialogClose>
                </div>
              </div>

              {/* Side by side: identity on the left, access on the right. */}
              <div className="no-scrollbar grid max-h-[72svh] gap-x-5 gap-y-4 overflow-y-auto overscroll-contain p-6 md:grid-cols-2">
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
                  <Label className="text-xs font-medium">Email *</Label>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={Boolean(editing)}
                    placeholder="sarah@ethixweb.local"
                    className="bg-background/50 border-border/60"
                  />
                </div>

                <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Role</Label>
                    <Select
                      items={STAFF_ROLES}
                      value={role}
                      onValueChange={(v) => setRole(v ?? "employee")}
                      disabled={Boolean(editing)}
                    >
                      <SelectTrigger className="w-full bg-background/50 border-border/60">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(STAFF_ROLES).map(([v, l]) => (
                          <SelectItem key={v} value={v}>
                            {l}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Company (Client)</Label>
                  <Input
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="e.g. Acme Corp"
                    className="bg-background/50 border-border/60"
                  />
                </div>

                <div className="space-y-1.5 md:col-span-2">
                  <Label className="text-xs font-medium">
                    {editing ? "New Password (leave blank to keep current)" : "Password *"}
                  </Label>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={editing ? "••••••••" : "Create password"}
                    className="bg-background/50 border-border/60"
                  />
                </div>
              </div>

              <DialogFooter className="m-0 px-6 py-4 bg-muted/30 border-t border-border/40 flex flex-row items-center justify-end gap-2.5 rounded-b-2xl">
                <DialogClose render={<Button variant="ghost" className="h-9 text-xs px-3.5 text-muted-foreground hover:text-foreground" />}>
                  Cancel
                </DialogClose>
                <Button
                  onClick={submit}
                  disabled={createUser.isPending || updateUser.isPending || !name.trim() || !email.trim()}
                  className="h-9 px-4 text-xs font-medium gap-1.5 shadow-xs"
                >
                  {createUser.isPending || updateUser.isPending ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      Saving…
                    </>
                  ) : editing ? (
                    "Save changes"
                  ) : (
                    "Add member"
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard icon={Users} value={stats.total} label="Total Members" tone="primary" />
        <SummaryCard
          icon={Shield}
          value={stats.admins}
          label={stats.admins === 1 ? "Administrator (only one)" : "Administrators"}
          tone={stats.admins === 1 ? "warning" : "muted"}
        />
        <SummaryCard icon={Briefcase} value={stats.staff} label="Staff & Managers" />
        <SummaryCard icon={Building2} value={stats.clients} label="Clients" />
      </div>

      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-1.5 bg-card/60 border border-border/60 rounded-xl backdrop-blur-xs">
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
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 w-full sm:w-auto overflow-x-auto no-scrollbar">
          {["All", ...Object.keys(ROLE_LABEL)].map((r) => {
            const isSelected = roleFilter === r;
            const label = r === "All" ? "All Roles" : ROLE_LABEL[r];
            const count = (users ?? []).filter((u) => r === "All" || u.role === r).length;
            return (
              <button
                key={r}
                onClick={() => setRoleFilter(r)}
                className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium whitespace-nowrap transition-all coarse:min-h-9 coarse:px-3.5 ${
                  isSelected
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                }`}
              >
                <span>{label}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                    isSelected ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-2xl" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : filteredUsers.length === 0 ? (
        <EmptyState
          icon={Users}
          title={search || roleFilter !== "All" ? "No matching members" : "No team members yet"}
          description={
            search || roleFilter !== "All"
              ? "Try adjusting your search query or role filter."
              : "Click 'Add Team Member' to invite staff or clients to the CRM."
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredUsers.map((u) => (
            <div
              key={u.id}
              // One row at every width. The control cluster is four uniform
              // icon buttons at its widest, so it stays narrow enough to sit
              // beside the identity instead of on top of it -- and every card
              // in the grid ends up the same height, which the old mix of text
              // buttons and icons did not.
              className="group flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-card/80 p-4 shadow-xs transition-all duration-150 hover:border-border"
            >
              <div className="flex min-w-0 items-center gap-3">
                <UserAvatar
                  user={u}
                  className="size-11 ring-1 ring-border/80 shadow-xs"
                  fallbackClassName="bg-muted text-xs text-foreground border border-border/40"
                />

                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {/* max-w-full, not just truncate: inside a wrapping flex
                        line the name sizes itself to its content first, so a
                        long one pushes the badges out of the card before the
                        ellipsis ever gets a chance to appear. */}
                    <span className="max-w-full truncate text-sm font-semibold text-foreground">{u.name}</span>
                    <span
                      className={`inline-flex shrink-0 items-center whitespace-nowrap px-2 py-0.5 rounded-full text-[10px] border ${roleBadgeStyle(
                        u.role
                      )}`}
                    >
                      {ROLE_LABEL[u.role] ?? u.role}
                    </span>

                    {/* Standing, at a glance. An admin whose changes are held is
                        the thing another admin most needs to know about them. */}
                    {u.isSuperAdmin && (
                      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                        <Crown aria-hidden className="size-3" />
                        Super admin
                      </span>
                    )}
                    {u.role === "admin" && !u.isSuperAdmin && !u.adminTrusted && (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning"
                        title="Their sensitive changes wait for a second signature"
                      >
                        <ShieldQuestion aria-hidden className="size-3" />
                        Needs approval
                      </span>
                    )}

                    {/* Where this account stands on the monthly password
                        policy. Silent for an account with no password to
                        rotate, and for the whole roster when the workspace has
                        rotation switched off -- there is no point telling an
                        admin the same non-fact on every row. */}
                    <PasswordStatusBadge status={u.passwordStatus} />
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {/* One line, truncated. Breaking an address at any character
                        (wrap-anywhere) split the domain mid-word -- "ethixweb.l"
                        then "ocal" -- which reads as a bug. A directory row wants
                        the address on one line; the full value is on hover and in
                        the edit dialog. min-w-0 lets the truncation actually fire
                        inside the flex row. */}
                    <span className="flex min-w-0 items-center gap-1" title={u.email}>
                      <Mail className="size-3 shrink-0 text-muted-foreground/70" />
                      <span className="truncate">{u.email}</span>
                    </span>
                    {u.company && (
                      <span className="flex min-w-0 items-center gap-1 text-foreground/80 font-medium" title={u.company}>
                        <Building2 className="size-3 shrink-0 text-primary" />
                        <span className="truncate">{u.company}</span>
                      </span>
                    )}
                    {u.role === "client" && (
                      <Link
                        to="/portal/client-access"
                        className="focus-clear -mx-2 flex max-w-full items-center gap-1 truncate rounded-lg px-2 hover:text-foreground coarse:min-h-11"
                        title="Change what this client can see"
                      >
                        <LayoutGrid className="size-3 shrink-0 text-muted-foreground/70" />
                        {describeAccess(u.allowedPages)}
                      </Link>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-0.5">
                {/* Only a super admin can change standing, and only for another
                    admin. The server refuses everyone else regardless. */}
                {can.canManageAdmins && u.role === "admin" && u.id !== currentUser?.id && (
                  <>
                    {/* Icons, not words. "Untrust" and "Make super" set side
                        by side were wider than the name they sat next to, and
                        every card carried a different number of them, so no
                        two rows in the grid lined up. The sentence each one
                        used to spell out now lives in its label, where a
                        screen reader and a hover both still reach it. */}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={setStanding.isPending}
                      aria-label={
                        u.adminTrusted
                          ? `Send ${u.name}'s changes for approval again`
                          : `Let ${u.name} act without approval`
                      }
                      title={u.adminTrusted ? "Send their changes for approval again" : "Let them act without approval"}
                      className="text-muted-foreground transition-colors hover:bg-warning/10 hover:text-warning"
                      onClick={() => changeStanding(u, { trusted: !u.adminTrusted })}
                    >
                      {u.adminTrusted ? (
                        <ShieldQuestion aria-hidden className="size-3.5" />
                      ) : (
                        <ShieldCheck aria-hidden className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={setStanding.isPending}
                      aria-label={
                        u.isSuperAdmin
                          ? `Step ${u.name} down to an ordinary admin`
                          : `Give ${u.name} full control`
                      }
                      title={u.isSuperAdmin ? "Step them down to an ordinary admin" : "Give them full control"}
                      className={
                        u.isSuperAdmin
                          ? "text-primary transition-colors hover:bg-primary/10"
                          : "text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                      }
                      onClick={() => changeStanding(u, { superAdmin: !u.isSuperAdmin })}
                    >
                      <Crown aria-hidden className="size-3.5" />
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Edit ${u.name}`}
                  className="hover:bg-primary/10 hover:text-primary transition-colors"
                  onClick={() => openEdit(u)}
                >
                  <Pencil aria-hidden className="size-3.5" />
                </Button>
                {u.id !== currentUser?.id && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${u.name}`}
                    className="hover:bg-destructive/10 hover:text-destructive text-destructive/80 transition-colors"
                    onClick={() => remove(u)}
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* A new administrator's backup sign-in codes. The only time they exist
          outside the new admin's own head -- the server keeps hashes and cannot
          reproduce them. Hand them over with the password. */}
      <Dialog open={newAdminCodes != null} onOpenChange={(v) => !v && setNewAdminCodes(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>Backup sign-in codes for {newAdminCodes?.name}</DialogTitle>
          <DialogDescription>
            Administrators sign in with a password and an emailed code. These eight one-time codes stand in for
            that emailed code when email is not reaching them. Give them to {newAdminCodes?.name} along with the
            password — this is the only time they are shown.
          </DialogDescription>
          <ul className="my-2 grid grid-cols-2 gap-2">
            {(newAdminCodes?.codes ?? []).map((c) => (
              <li
                key={c}
                className="rounded-md border border-border/70 bg-secondary/40 px-3 py-2 text-center font-mono text-sm tracking-widest"
              >
                {c}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            They can replace this set at any time from their own Security page, which is what they should do if
            anyone else has seen it.
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                navigator.clipboard
                  .writeText((newAdminCodes?.codes ?? []).join("\n"))
                  .then(() => toast.success("Copied to the clipboard"), () => toast.error("Could not copy"));
              }}
            >
              Copy all
            </Button>
            <Button type="button" onClick={() => setNewAdminCodes(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
