import { type ReactNode, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard, FolderKanban, ListChecks, Ticket, Globe, FileText, PieChart, CreditCard,
  Settings, Bell, LogOut, Menu, X, Users, Home, LifeBuoy, KeyRound, ShieldCheck,
  ListTodo, MessageSquare, Activity, Mail,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useNotifications } from "@/hooks/useData";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { initials } from "@/lib/format";
import { canSeePage, pageKeyForPath } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import type { Role } from "@/lib/types";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  roles?: Role[];

  badge?: number;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/portal", label: "Dashboard", icon: LayoutDashboard },
  { to: "/portal/projects", label: "Projects", icon: FolderKanban, roles: ["admin", "sales", "project_manager", "client"] },
  { to: "/portal/tasks", label: "Tasks", icon: ListChecks, roles: ["admin", "project_manager", "employee"] },
  { to: "/portal/progress", label: "Work progress", icon: Activity, roles: ["admin", "sales", "project_manager", "client"] },
  { to: "/portal/tickets", label: "Tickets", icon: Ticket },
  { to: "/portal/domains", label: "Domains", icon: Globe, roles: ["admin", "sales", "project_manager", "client"] },
  { to: "/portal/reports", label: "Reports", icon: FileText, roles: ["admin", "sales", "project_manager", "client"] },
  { to: "/portal/budget", label: "Budget", icon: PieChart, roles: ["admin", "project_manager", "client"] },
  { to: "/portal/billing", label: "Billing", icon: CreditCard, roles: ["admin", "client"] },
  { to: "/portal/team", label: "Team", icon: Users, roles: ["admin"] },
  { to: "/portal/client-access", label: "Client Access", icon: ShieldCheck, roles: ["admin"] },
  { to: "/portal/otp-monitor", label: "Login Codes", icon: KeyRound, roles: ["admin"] },
  { to: "/portal/clickup", label: "ClickUp", icon: ListTodo, roles: ["admin"] },
  { to: "/portal/slack", label: "Slack", icon: MessageSquare, roles: ["admin"] },
  { to: "/portal/mail", label: "Mail", icon: Mail, roles: ["admin"] },
  { to: "/portal/notifications", label: "Notifications", icon: Bell },
  { to: "/portal/settings", label: "Settings", icon: Settings },
];

const GROUPS: { heading: string; labels: string[] }[] = [
  { heading: "Workspace", labels: ["Dashboard", "Projects", "Tasks", "Domains"] },
  { heading: "Operations & Finance", labels: ["Work progress", "Tickets", "Reports", "Budget", "Billing"] },
  { heading: "Integrations", labels: ["ClickUp", "Slack"] },
  { heading: "Administration", labels: ["Team", "Client Access", "Login Codes", "Mail"] },
  { heading: "Account", labels: ["Notifications", "Settings"] },
];

const MOBILE_NAV: NavItem[] = [
  { to: "/portal", label: "Home", icon: Home },
  { to: "/portal/budget", label: "Spending", icon: PieChart, roles: ["admin", "project_manager", "client"] },
  { to: "/portal/billing", label: "Payments", icon: CreditCard, roles: ["admin", "client"] },
  { to: "/portal/tickets", label: "Help", icon: LifeBuoy },
  { to: "/portal/tasks", label: "Tasks", icon: ListChecks, roles: ["admin", "project_manager", "employee"] },
  { to: "/portal/projects", label: "Projects", icon: FolderKanban, roles: ["admin", "sales", "project_manager", "client"] },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { data: notifications } = useNotifications();
  const [menuOpen, setMenuOpen] = useState(false);

  const unread = notifications?.filter((n) => !n.read).length ?? 0;
  const visible = (item: NavItem) =>
    (!item.roles || (user != null && item.roles.includes(user.role))) &&
    canSeePage(user, pageKeyForPath(item.to));
  const items = NAV_ITEMS.filter(visible).map((i) =>
    i.label === "Notifications" ? { ...i, badge: unread } : i,
  );
  const mobileItems = MOBILE_NAV.filter(visible).slice(0, 4);

  return (
    <div className="flex min-h-svh bg-secondary/30">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:ring-2 focus:ring-primary"
      >
        Skip to main content
      </a>

      <aside className="sticky top-0 hidden h-svh w-[248px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <SidebarContent items={items} />
      </aside>

      {menuOpen && (
        <div className="fixed inset-0 z-50 animate-in fade-in-0 duration-200 md:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-xs" onClick={() => setMenuOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-[280px] max-w-[calc(100vw-3rem)] flex-col bg-sidebar border-r border-sidebar-border/60 shadow-2xl animate-in slide-in-from-left duration-200">
            <SidebarContent items={items} onNavigate={() => setMenuOpen(false)} onClose={() => setMenuOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-2 md:hidden">
          <div className="flex min-w-0 items-center gap-1">
            <Button variant="ghost" size="icon" className="tap-target" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
              <Menu className="size-5" />
            </Button>
            <Brand compact />
          </div>

          {user && (
            <NavLink
              to="/portal/notifications"
              aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
              className="tap-target focus-clear relative inline-flex items-center justify-center rounded-lg text-foreground hover:bg-secondary"
            >
              <Bell className="size-5" />
              {unread > 0 && (
                <span className="absolute top-1.5 right-1.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </NavLink>
          )}
        </header>

        <main id="main" className="flex-1 overflow-y-auto p-4 pb-[calc(5rem+env(safe-area-inset-bottom))] md:p-6 md:pb-6">
          {children}
        </main>
      </div>

      <BottomNav items={mobileItems} />
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-xl bg-zinc-950 border border-zinc-800 p-1 shadow-sm ring-1 ring-primary/20",
          compact ? "size-7" : "size-8"
        )}
      >
        <img
          src="/emblem-mark.png"
          alt="EthixWeb Emblem"
          className="size-full object-contain"
        />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm leading-tight font-semibold tracking-tight text-sidebar-foreground">
          EthixWeb
        </div>
        {!compact && <div className="truncate text-xs text-muted-foreground">Client portal</div>}
      </div>
    </div>
  );
}

function NavRow({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === "/portal"}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "focus-clear relative flex h-10 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors",
          isActive
            ? "bg-primary/10 font-medium text-primary shadow-xs"
            : "font-normal text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span aria-hidden className="absolute left-0 h-5 w-0.5 rounded-r-full bg-primary" />}
          <item.icon aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.badge != null && item.badge > 0 && (
            <span className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
              {item.badge > 9 ? "9+" : item.badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

function SidebarContent({
  items,
  onNavigate,
  onClose,
}: {
  items: NavItem[];
  onNavigate?: () => void;
  onClose?: () => void;
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const byLabel = new Map(items.map((i) => [i.label, i]));

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <img
          src="/spiderweb.svg"
          alt=""
          className="absolute -top-8 -left-24 w-[540px] max-w-none opacity-30 dark:opacity-45 select-none"
        />
      </div>

      <div className="relative z-10 flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border/60 px-4">
        <Brand />
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground hover:bg-sidebar-accent md:hidden"
            aria-label="Close menu"
            onClick={onClose}
          >
            <X className="size-5" />
          </Button>
        )}
      </div>

      <nav aria-label="Sections" className="relative z-10 flex-1 min-h-0 overflow-y-auto no-scrollbar px-2.5 py-3">
        {GROUPS.map((group) => {
          const groupItems = group.labels.map((l) => byLabel.get(l)).filter((i): i is NavItem => i != null);
          if (groupItems.length === 0) return null;
          return (
            <div key={group.heading} className="mb-4 last:mb-0">
              <div className="px-3 pb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {group.heading}
              </div>
              <div className="space-y-0.5">
                {groupItems.map((item) => (
                  <NavRow key={item.to} item={item} onNavigate={onNavigate} />
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="relative z-10 shrink-0 border-t border-sidebar-border/60 px-4 py-3">
        <div className="pb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Appearance
        </div>
        <ThemeSwitch />
      </div>

      <div className="relative z-10 shrink-0 border-t border-sidebar-border/60 p-3">
        <div className="flex items-center gap-2.5 rounded-lg bg-card px-2.5 py-2 ring-1 ring-foreground/10">
          <Avatar className="size-8 shrink-0">
            <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
              {user ? initials(user.name) : "?"}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-sidebar-foreground">{user?.name}</div>
            <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Sign out"
            title="Sign out"
            className="tap-target shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
            onClick={() => {
              onNavigate?.();
              logout();
              navigate("/login");
            }}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function BottomNav({ items }: { items: NavItem[] }) {
  if (items.length === 0) return null;

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="flex">
        {items.map((item) => (
          <li key={item.to} className="flex-1">
            <NavLink
              to={item.to}
              end={item.to === "/portal"}
              className={({ isActive }) =>
                cn(
                  "focus-clear relative flex h-14 w-full flex-col items-center justify-center gap-0.5 px-1",
                  isActive ? "text-primary" : "text-muted-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && <span aria-hidden className="absolute inset-x-3 top-0 h-0.5 rounded-b-full bg-primary" />}
                  <item.icon aria-hidden className="size-5 shrink-0" strokeWidth={isActive ? 2.4 : 1.9} />
                  <span className={cn("text-xs leading-none", isActive ? "font-semibold" : "font-normal")}>
                    {item.label}
                  </span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
