import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { LogOut } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useLive } from "@/context/LiveContext";
import { useNotifications } from "@/hooks/useData";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { LiveIndicator } from "@/components/LiveIndicator";
import { BottomTabs } from "@/components/mobile/BottomTabs";
import { MoreSheet } from "@/components/mobile/MoreSheet";
import { PullToRefresh } from "@/components/mobile/PullToRefresh";
import { TopBar } from "@/components/mobile/TopBar";
import { InstallCard } from "@/components/mobile/InstallCard";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { initials } from "@/lib/format";
import { isClientNav, navFor, type NavGroup, type NavItem } from "@/lib/nav";
import { clearOfflineCaches } from "@/lib/pwa";
import { cn } from "@/lib/utils";

export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { refresh } = useLive();
  const { data: notifications } = useNotifications();
  const { pathname } = useLocation();
  const reduceMotion = useReducedMotion();

  const [moreOpen, setMoreOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  const unread = notifications?.filter((n) => !n.read).length ?? 0;
  const nav = useMemo(() => navFor(user), [user]);
  const client = isClientNav(user);

  const secondary = useMemo(
    () =>
      nav.secondary.map((i) => (i.to === "/portal/notifications" ? { ...i, badge: unread } : i)),
    [nav.secondary, unread],
  );

  const title = useMemo(
    () => titleFor(pathname, [...nav.primary, ...nav.secondary]),
    [pathname, nav.primary, nav.secondary],
  );

  // A new screen starts at its own top, the way a pushed view does on a phone.
  useEffect(() => {
    setMoreOpen(false);
    mainRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div className="flex h-svh overflow-hidden bg-secondary/30">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:ring-2 focus:ring-primary"
      >
        Skip to main content
      </a>

      <aside className="sticky top-0 hidden h-svh w-[248px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <SidebarContent primary={nav.primary} secondary={secondary} groups={nav.groups} flat={client} />
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <TopBar title={title} unread={unread} scrollRef={mainRef} />

        <main
          id="main"
          ref={mainRef}
          // overflow-x-hidden is the guard the body used to provide: one
          // stray wide element must never turn the whole app into a
          // sideways-scrolling page.
          className="relative flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain p-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
        >
          <PullToRefresh onRefresh={refresh} scrollRef={mainRef}>
            <motion.div
              key={pathname}
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.4, 0, 0.2, 1] }}
            >
              {children}
            </motion.div>
            <InstallCard />
          </PullToRefresh>
        </main>
      </div>

      <BottomTabs
        items={nav.primary}
        moreCount={secondary.length}
        moreOpen={moreOpen}
        onOpenMore={() => setMoreOpen(true)}
      />
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} items={secondary} unread={unread} />
    </div>
  );
}

/** The name of the screen you are on, for the phone's top bar. */
function titleFor(pathname: string, items: NavItem[]): string {
  const exact = items.find((i) => i.to === pathname);
  if (exact) return exact.label;
  const nested = items
    .filter((i) => i.to !== "/portal" && pathname.startsWith(i.to))
    .sort((a, b) => b.to.length - a.to.length)[0];
  return nested?.label ?? "EthixWeb";
}

function Brand() {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div
        className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950 p-1 shadow-sm ring-1 ring-primary/20"
      >
        <img src="/emblem-mark.png" alt="EthixWeb Emblem" className="size-full object-contain" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm leading-tight font-semibold tracking-tight text-sidebar-foreground">
          EthixWeb
        </div>
        <div className="truncate text-xs text-muted-foreground">Client portal</div>
      </div>
    </div>
  );
}

function NavRow({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === "/portal"}
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

/**
 * Two sidebars in one component, because they differ only in how much index
 * they need. Staff get headed groups over the whole workspace; a client gets a
 * flat, unlabelled list -- four places they go, then everything else, with no
 * section headings to read past.
 */
function SidebarContent({
  primary,
  secondary,
  groups,
  flat,
}: {
  primary: NavItem[];
  secondary: NavItem[];
  groups: NavGroup[];
  flat: boolean;
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <img
          src="/spiderweb.svg"
          alt=""
          className="absolute -top-8 -left-24 w-[540px] max-w-none opacity-30 select-none dark:opacity-45"
        />
      </div>

      <div className="relative z-10 flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border/60 px-4">
        <Brand />
      </div>

      <nav aria-label="Sections" className="no-scrollbar relative z-10 min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        {flat ? (
          <>
            <div className="space-y-0.5">
              {primary.map((item) => (
                <NavRow key={item.to} item={item} />
              ))}
            </div>
            {secondary.length > 0 && (
              <>
                <hr className="my-3 border-sidebar-border/60" />
                <div className="space-y-0.5">
                  {secondary.map((item) => (
                    <NavRow key={item.to} item={item} />
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          groups.map((group) => (
            <div key={group.heading} className="mb-4 last:mb-0">
              <div className="px-3 pb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {group.heading}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavRow key={item.to} item={item} />
                ))}
              </div>
            </div>
          ))
        )}
      </nav>

      <div className="relative z-10 shrink-0 border-t border-sidebar-border/60 px-4 py-3">
        <div className="flex items-center justify-between pb-1.5">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Appearance</span>
          <LiveIndicator />
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
              clearOfflineCaches();
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
