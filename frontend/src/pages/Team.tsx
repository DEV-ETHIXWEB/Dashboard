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
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useUsers, useCreateUser, useUpdateUser, useDeleteUser } from "@/hooks/useData";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initials } from "@/lib/format";
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
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();

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
          onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to update"),
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
          onSuccess: () => {
            toast.success("Team member added");
            setOpen(false);
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to add member"),
        },
      );
    }
  }

  function remove(u: UserRecord) {
    if (!window.confirm(`Remove ${u.name}? Their assigned tasks/tickets will show as unassigned.`)) return;
    deleteUser.mutate(u.id, {
      onSuccess: () => toast.success("User removed"),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to remove user"),
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
      admins: list.filter((u) => u.role === "admin" || u.role === "project_manager").length,
      staff: list.filter((u) => u.role === "employee" || u.role === "sales").length,
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
              className="sm:max-w-md p-0 gap-0 overflow-hidden border border-border/60 shadow-2xl rounded-2xl bg-card"
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

              <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
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

                <div className="grid grid-cols-2 gap-3">
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
                </div>

                <div className="space-y-1.5">
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
        <div className="p-4 rounded-2xl border border-border/60 bg-card/80 shadow-xs backdrop-blur-xs flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
            <Users className="size-5" />
          </div>
          <div>
            <div className="text-2xl font-bold text-foreground tracking-tight">{stats.total}</div>
            <div className="text-xs text-muted-foreground font-medium">Total Members</div>
          </div>
        </div>

        <div className="p-4 rounded-2xl border border-border/60 bg-card/80 shadow-xs backdrop-blur-xs flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-muted/80 text-foreground border border-border/50">
            <Shield className="size-5" />
          </div>
          <div>
            <div className="text-2xl font-bold text-foreground tracking-tight">{stats.admins}</div>
            <div className="text-xs text-muted-foreground font-medium">Admins & PMs</div>
          </div>
        </div>

        <div className="p-4 rounded-2xl border border-border/60 bg-card/80 shadow-xs backdrop-blur-xs flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-muted/80 text-foreground border border-border/50">
            <Briefcase className="size-5" />
          </div>
          <div>
            <div className="text-2xl font-bold text-foreground tracking-tight">{stats.staff}</div>
            <div className="text-xs text-muted-foreground font-medium">Staff & Sales</div>
          </div>
        </div>

        <div className="p-4 rounded-2xl border border-border/60 bg-card/80 shadow-xs backdrop-blur-xs flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-muted/80 text-foreground border border-border/50">
            <Building2 className="size-5" />
          </div>
          <div>
            <div className="text-2xl font-bold text-foreground tracking-tight">{stats.clients}</div>
            <div className="text-xs text-muted-foreground font-medium">Clients</div>
          </div>
        </div>
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
                className={`text-xs px-3 py-1 rounded-lg transition-all whitespace-nowrap flex items-center gap-1.5 font-medium cursor-pointer ${
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
              className="p-4 rounded-2xl border border-border/60 bg-card/80 shadow-xs hover:border-border transition-all duration-150 flex items-center justify-between gap-4 group"
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
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] border ${roleBadgeStyle(
                        u.role
                      )}`}
                    >
                      {ROLE_LABEL[u.role] ?? u.role}
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
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
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
    </div>
  );
}
