import {
  Activity, Bell, CreditCard, FileText, FolderKanban, Globe, Home, KeyRound, LayoutDashboard,
  LifeBuoy, ListChecks, ListTodo, Mail, MessageSquare, PieChart, ShieldCheck, Ticket,
  Users, type LucideIcon,
} from "lucide-react";
import { canSeePage, pageKeyForPath } from "@/lib/permissions";
import type { Role, User } from "@/lib/types";

export interface NavItem {
  to: string;
  label: string;
  /** Shorter wording for the phone's tab bar, where a slot is 75px wide. */
  short?: string;
  icon: LucideIcon;
  roles?: Role[];
  badge?: number;
}

export interface NavGroup {
  heading: string;
  items: NavItem[];
}

/**
 * Staff run the whole workspace, so their sidebar stays a full, grouped index.
 * Seventeen destinations is a lot, but every one of them is a job somebody on
 * the team does daily, and hiding them behind a menu costs more than it saves.
 */
const STAFF_NAV: NavItem[] = [
  { to: "/portal", label: "Dashboard", short: "Home", icon: LayoutDashboard },
  { to: "/portal/projects", label: "Projects", icon: FolderKanban, roles: ["admin", "sales", "project_manager"] },
  { to: "/portal/tasks", label: "Tasks", icon: ListChecks, roles: ["admin", "project_manager", "employee"] },
  { to: "/portal/domains", label: "Domains", icon: Globe, roles: ["admin", "sales", "project_manager"] },
  { to: "/portal/progress", label: "Work progress", short: "Progress", icon: Activity, roles: ["admin", "sales", "project_manager"] },
  { to: "/portal/tickets", label: "Tickets", icon: Ticket },
  { to: "/portal/reports", label: "Reports", icon: FileText, roles: ["admin", "sales", "project_manager"] },
  { to: "/portal/budget", label: "Budget", icon: PieChart, roles: ["admin", "project_manager"] },
  { to: "/portal/billing", label: "Billing", icon: CreditCard, roles: ["admin"] },
  { to: "/portal/clickup", label: "ClickUp", icon: ListTodo, roles: ["admin"] },
  { to: "/portal/slack", label: "Slack", icon: MessageSquare, roles: ["admin"] },
  { to: "/portal/team", label: "Team", icon: Users, roles: ["admin"] },
  { to: "/portal/client-access", label: "Client Access", icon: ShieldCheck, roles: ["admin"] },
  { to: "/portal/otp-monitor", label: "Login Codes", icon: KeyRound, roles: ["admin"] },
  { to: "/portal/mail", label: "Mail", icon: Mail, roles: ["admin"] },
  { to: "/portal/notifications", label: "Notifications", icon: Bell },
];

const STAFF_GROUPS: { heading: string; labels: string[] }[] = [
  { heading: "Workspace", labels: ["Dashboard", "Projects", "Tasks", "Domains"] },
  { heading: "Operations & Finance", labels: ["Work progress", "Tickets", "Reports", "Budget", "Billing"] },
  { heading: "Integrations", labels: ["ClickUp", "Slack"] },
  { heading: "Administration", labels: ["Team", "Client Access", "Login Codes", "Mail"] },
  { heading: "Account", labels: ["Notifications"] },
];

/**
 * A client has one question -- "where is my thing up to?" -- and four ways to
 * ask it. These are the tabs across the bottom of a phone and the top of the
 * sidebar, in the order people reach for them.
 *
 * The words are the ones a client would use, not the ones the database uses:
 * nobody outside this office calls an invoice a billing record.
 */
const CLIENT_PRIMARY: NavItem[] = [
  { to: "/portal", label: "Home", icon: Home },
  { to: "/portal/progress", label: "Work", icon: Activity },
  { to: "/portal/tickets", label: "Requests", icon: LifeBuoy },
  { to: "/portal/billing", label: "Money", icon: CreditCard },
];

/** Everything else a client owns, one tap away behind More. */
const CLIENT_SECONDARY: NavItem[] = [
  { to: "/portal/projects", label: "Projects", icon: FolderKanban },
  { to: "/portal/domains", label: "Websites", icon: Globe },
  { to: "/portal/reports", label: "Documents", icon: FileText },
  { to: "/portal/budget", label: "Spending", icon: PieChart },
  { to: "/portal/notifications", label: "Alerts", icon: Bell },
];

type Viewer = Pick<User, "role"> & { allowedPages?: User["allowedPages"] };

/** Role allows it and the admin left the section switched on. */
function visibleTo(user: Viewer | null | undefined, item: NavItem): boolean {
  if (!user) return false;
  if (item.roles && !item.roles.includes(user.role)) return false;
  return canSeePage(user, pageKeyForPath(item.to));
}

export function isClientNav(user: Viewer | null | undefined): boolean {
  return user?.role === "client";
}

/**
 * The navigation for one account.
 *
 * `primary` is at most four destinations -- the bottom bar on a phone, the top
 * of the sidebar on a desktop. `secondary` is the rest. When an admin switches
 * a client's section off, the tab disappears and the next-best destination
 * moves up, so the bar is never short and never has a dead tab in it.
 */
export function navFor(user: Viewer | null | undefined): {
  primary: NavItem[];
  secondary: NavItem[];
  groups: NavGroup[];
} {
  if (!user) return { primary: [], secondary: [], groups: [] };

  if (isClientNav(user)) {
    const primary = CLIENT_PRIMARY.filter((i) => visibleTo(user, i));
    const secondary = CLIENT_SECONDARY.filter((i) => visibleTo(user, i));

    // Promote from the More list until the bar is full again.
    while (primary.length < 4 && secondary.length > 0) {
      const next = secondary.shift();
      if (next) primary.push(next);
    }

    return { primary, secondary, groups: [] };
  }

  const items = STAFF_NAV.filter((i) => visibleTo(user, i));
  const byLabel = new Map(items.map((i) => [i.label, i]));
  const groups = STAFF_GROUPS.map((g) => ({
    heading: g.heading,
    items: g.labels.map((l) => byLabel.get(l)).filter((i): i is NavItem => i != null),
  })).filter((g) => g.items.length > 0);

  // Staff phones get the four screens they actually work from.
  const preferred = ["Dashboard", "Tickets", "Tasks", "Work progress", "Projects"];
  const primary = preferred
    .map((l) => byLabel.get(l))
    .filter((i): i is NavItem => i != null)
    .slice(0, 4);
  const chosen = new Set(primary.map((i) => i.to));

  return { primary, secondary: items.filter((i) => !chosen.has(i.to)), groups };
}
