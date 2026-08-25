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
        // min-h, not h. `height` is border-box here, so a fixed 3.25rem with
        // a safe-area top pad meant the inset ate the bar rather than sitting
        // above it -- on a notched phone in standalone the inset is larger
        // than the bar itself, and the emblem and the bell were pushed clean
        // out of their own header.
        "sticky top-0 z-30 flex min-h-13 shrink-0 items-center justify-between gap-2 px-4 pt-[env(safe-area-inset-top)] transition-[background-color,border-color,backdrop-filter] duration-200 md:hidden",
        raised ? "app-chrome border-b border-border/70" : "border-b border-transparent bg-background",
      )}
    >
      {/* The full wordmark, not the emblem in a plate: a phone header is the one
          place the brand gets to be read rather than inferred from a glyph.
          The artwork is white on transparency, so the light theme drives it to
          black instead of standing it on a dark tile -- the mark reads as
          itself either way, with nothing boxed around it. */}
      <div className="flex min-w-0 items-center gap-2.5">
        <img
          src="/ethixweb.png"
          alt="EthixWeb"
          className="h-[15px] w-auto shrink-0 brightness-0 dark:brightness-100"
        />
        <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />
        <h2 className="min-w-0 truncate text-[15px] leading-tight font-medium tracking-tight text-muted-foreground">
          {title}
        </h2>
      </div>

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
