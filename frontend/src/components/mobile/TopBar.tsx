import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { Bell } from "lucide-react";
import { LiveIndicator } from "@/components/LiveIndicator";
import { cn } from "@/lib/utils";

/**
 * The strip along the top of a phone.
 *
 * Flat and borderless while the page is at rest, with a hairline and a frosted
 * backdrop that fade in once content slides under it. That is the whole trick:
 * the chrome only appears when there is something to separate.
 */
export function TopBar({
  title,
  unread,
  scrollRef,
}: {
  title: string;
  unread: number;
  scrollRef: React.RefObject<HTMLElement | null>;
}) {
  const [raised, setRaised] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setRaised(el.scrollTop > 4);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef]);

  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex h-13 shrink-0 items-center justify-between gap-2 px-4 pt-[env(safe-area-inset-top)] transition-[background-color,border-color,backdrop-filter] duration-200 md:hidden",
        raised ? "app-chrome border-b border-border/70" : "border-b border-transparent bg-background",
      )}
    >
      <h2 className="min-w-0 truncate text-[17px] leading-tight font-semibold tracking-tight">{title}</h2>

      <div className="flex shrink-0 items-center gap-1.5">
        <LiveIndicator compact />
        <NavLink
          to="/portal/notifications"
          aria-label={unread > 0 ? `Alerts, ${unread} unread` : "Alerts"}
          className="tap-target focus-clear relative -mr-2 inline-flex touch-manipulation items-center justify-center rounded-xl text-foreground active:bg-secondary"
        >
          <Bell aria-hidden className="size-[21px]" strokeWidth={1.9} />
          {unread > 0 && (
            <span className="absolute top-2 right-2 flex min-w-[15px] items-center justify-center rounded-full bg-primary px-1 text-[9.5px] leading-[15px] font-semibold text-primary-foreground">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </NavLink>
      </div>
    </header>
  );
}
