import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { LogOut } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useLive } from "@/context/LiveContext";
import { useNotifications } from "@/hooks/useData";
import { usePendingApprovalCount } from "@/hooks/useApprovals";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { LiveIndicator } from "@/components/LiveIndicator";
import { BottomTabs } from "@/components/mobile/BottomTabs";
import { MoreSheet } from "@/components/mobile/MoreSheet";
import { PullToRefresh } from "@/components/mobile/PullToRefresh";
import { TopBar } from "@/components/mobile/TopBar";
import { NotificationBell } from "@/components/NotificationBell";
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
  const pendingApprovals = usePendingApprovalCount();
  const nav = useMemo(() => navFor(user), [user]);
  const client = isClientNav(user);

  const secondary = useMemo(
    () =>
      nav.secondary.map((i) => {
        if (i.to === "/portal/notifications") return { ...i, badge: unread };
        // A proposal nobody looks at is the failure mode this whole feature has,
        // so the count sits in the navigation rather than only on the page.
        if (i.to === "/portal/approvals") return { ...i, badge: pendingApprovals };
        return i;
      }),
    [nav.secondary, unread, pendingApprovals],
  );

  // Staff read the grouped sidebar rather than `secondary`, so the counts have
  // to be threaded through the groups too or the badge is invisible to exactly
  // the people who need it.
  const badgeFor = (to: string) =>
    to === "/portal/notifications" ? unread : to === "/portal/approvals" ? pendingApprovals : undefined;

  const groups = useMemo(
    () =>
      nav.groups.map((g) => ({
        ...g,
        items: g.items.map((i) => {
          const badge = badgeFor(i.to);
          return badge == null ? i : { ...i, badge };
        }),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nav.groups, unread, pendingApprovals],
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
        <SidebarContent primary={nav.primary} secondary={secondary} groups={groups} flat={client} />
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <TopBar title={title} unread={unread} scrollRef={mainRef} />

        {/* The desk equivalent of the phone's top bar. A phone has always had
            the bell up here; a desk only had a badge in the sidebar, which
            meant reading an alert cost a page change. Sits above the scroll
            container rather than over it, so nothing slides underneath. */}
        <header className="hidden shrink-0 items-center justify-end gap-2 px-6 pt-4 md:flex">
          <NotificationBell />
        </header>

        <main
          id="main"
          ref={mainRef}
          // overflow-x-hidden is the guard the body used to provide: one
          // stray wide element must never turn the whole app into a
          // sideways-scrolling page.
          className="relative flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain p-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:p-6 md:pt-3 md:pb-6"
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

/**
 * The emblem on its plate, with the product name set beside it.
 *
 * The mark ships in two files -- greyscale and brand red -- and the plate holds
 * both so hovering cross-fades between them at identical size. `ethixweb.png`,
 * the flat wordmark, is deliberately not used here: it is a white mark on
 * transparency and disappears against the light sidebar.
 */
function Brand() {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div
        className="group flex size-[2.1rem] shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950/40 p-1 shadow-sm ring-1 ring-primary/20 transition-colors duration-200 hover:border-primary/40 hover:ring-primary/40"
      >
        {/* Both marks share one box, so the greyscale and red versions render
            at exactly the same size; hovering cross-fades between them. */}
        <div className="relative size-full">
          <img
            src="/emblem-mark.png"
            alt="EthixWeb Emblem"
            className="absolute inset-0 size-full object-contain transition-opacity duration-200 group-hover:opacity-0"
          />
          <img
            src="/emblem-mark-red.png"
            alt=""
            aria-hidden="true"
            className="absolute inset-0 size-full object-contain opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          />
        </div>
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

/**
 * The icon language is lifted from ethixweb.com, which builds every icon
 * affordance the same way: a lucide glyph at stroke-width 2 inside a fully
 * rounded chip with a hairline white border and a blurred, saturated
 * backdrop -- never a solid fill. The active row here IS that chip, so the
 * sidebar and the marketing site read as one product.
 *
 * The glyph still sits in a fixed 28px cell so a wide icon and a narrow one
 * occupy identical space and the labels stay on one optical line.
 */
const NAV_ICON_CELL = "relative grid size-7 shrink-0 place-items-center";

function NavIcon({ icon: Icon, active }: { icon: NavItem["icon"]; active: boolean }) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.span
      aria-hidden
      className={NAV_ICON_CELL}
      variants={reduceMotion ? undefined : { tap: { scale: 0.82 } }}
      transition={{ type: "spring", stiffness: 520, damping: 20 }}
    >
      <motion.span
        className="relative"
        animate={reduceMotion || !active ? { scale: 1 } : { scale: [1, 1.18, 1] }}
        transition={{ duration: 0.32, ease: "easeOut" }}
      >
        {/* Stroke 2 on every glyph, active or not -- the site never varies it;
            selection is carried by the chip and the colour instead. */}
        <Icon className="size-[1.05rem]" strokeWidth={2} />
      </motion.span>
    </motion.span>
  );
}

function NavRow({ item }: { item: NavItem }) {
  const reduceMotion = useReducedMotion();

  return (
    <NavLink
      to={item.to}
      end={item.to === "/portal"}
      className={({ isActive }) =>
        cn(
          "focus-clear relative flex h-10 items-center rounded-full px-3 text-sm transition-colors",
          isActive
            ? "font-medium text-primary"
            : "font-normal text-sidebar-foreground/80 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground",
        )
      }
    >
      {({ isActive }) => (
        <motion.span
          className="flex w-full items-center gap-2.5"
          whileTap={reduceMotion ? undefined : "tap"}
        >
          {isActive && (
            <motion.span
              aria-hidden
              layoutId="nav-active-chip"
              // Tinted from --primary rather than --accent: in the light theme
              // --accent is near-white, so the chip vanished against the
              // sidebar. A wash of the brand red reads on both grounds.
              className="absolute inset-0 rounded-full border border-primary/25 bg-primary/12 backdrop-blur-md backdrop-saturate-150"
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
            />
          )}
          <NavIcon icon={item.icon} active={isActive} />
          <span className="relative min-w-0 flex-1 truncate">{item.label}</span>
          {item.badge != null && item.badge > 0 && (
            <span className="relative shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
              {item.badge > 9 ? "9+" : item.badge}
            </span>
          )}
        </motion.span>
      )}
    </NavLink>
  );
}

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

      {/* 22px, not 16: the nav rows below inset by px-2.5 + px-3 and the
          account block by p-3 + px-2.5, both landing on 22. The emblem starts
          on that same line rather than six pixels to its left. */}
      <div className="relative z-10 flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border/60 px-[22px]">
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
              <div className="px-3 pb-1.5 t-label text-muted-foreground">
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
          <span className="t-label text-muted-foreground">Appearance</span>
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
