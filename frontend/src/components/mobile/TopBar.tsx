import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, LogOut } from "lucide-react";
import { LiveIndicator } from "@/components/LiveIndicator";
import { NotificationSheet } from "@/components/mobile/NotificationSheet";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/context/AuthContext";
import { impactFeedback, tapFeedback } from "@/lib/haptics";
import { clearOfflineCaches } from "@/lib/pwa";
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
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const { logout } = useAuth();
  const navigate = useNavigate();

  function signOut() {
    // The caches go before the session does: dropping them afterwards can
    // leave the next person on this phone reading the last one's data.
    clearOfflineCaches();
    logout();
    navigate("/login");
  }

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
      {/* The wordmark itself, the same asset the sidebar uses on a desk, so the
          phone and the desk open with the identical mark instead of the phone
          getting a cropped stand-in. `ethixweb.png` is white on transparency:
          inverted to black in the light theme, left alone in the dark one.

          The page name sits beside it in muted weight -- the brand is the
          constant, the title is the part that changes. */}
      <div className="flex min-w-0 items-center gap-2.5">
        <img
          src="/ethixweb.png"
          alt="EthixWeb"
          width={422}
          height={63}
          // Decoded off the main thread and never lazily: it is the first thing
          // in the viewport, so a deferred load would show an empty header.
          decoding="async"
          className="h-[18px] w-auto shrink-0 object-contain invert dark:invert-0"
        />
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        <h2 className="min-w-0 truncate text-[15px] leading-tight font-medium tracking-tight text-muted-foreground">
          {title}
        </h2>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <LiveIndicator compact />
        {/* The two controls sit in their own group with no gap between them.
            Full 44px-wide hit boxes left a 30px trench between the glyphs and
            the pair stopped reading as one cluster. They keep the 44px height
            a thumb needs and give up width instead: 36 wide, touching, which
            puts 16px of air between the glyphs and none to spare. */}
        <div className="flex items-center">
          {/* Sign out, inboard of the bell. It stays the quieter of the two --
              muted where the bell is full-strength -- because it is the more
              final, and the corner a thumb lands on by reflex should not be
              the one that ends the session. It asks before it acts, for the
              same reason: on a phone this button sits a few millimetres from
              the one people actually meant to press. */}
          <button
            type="button"
            aria-label="Sign out"
            title="Sign out"
            aria-haspopup="dialog"
            onClick={() => {
              tapFeedback();
              setConfirmingSignOut(true);
            }}
            className="focus-clear relative inline-flex h-11 w-9 touch-manipulation items-center justify-center rounded-xl text-muted-foreground active:bg-secondary active:text-foreground"
          >
            <LogOut aria-hidden className="size-[19px]" strokeWidth={1.9} />
          </button>
          {/* A sheet, not a route. Glancing at alerts should not cost the page
              you were on, and should not make "back" the way out of a glance. */}
          <button
            type="button"
            aria-label={unread > 0 ? `Alerts, ${unread} unread` : "Alerts"}
            aria-haspopup="dialog"
            aria-expanded={alertsOpen}
            onClick={() => {
              tapFeedback();
              setAlertsOpen((v) => !v);
            }}
            className="focus-clear relative -mr-1.5 inline-flex h-11 w-9 touch-manipulation items-center justify-center rounded-xl text-foreground active:bg-secondary"
          >
            <Bell aria-hidden className="size-[21px]" strokeWidth={1.9} />
            {unread > 0 && (
              <span className="absolute top-2.5 right-0.5 flex min-w-[15px] items-center justify-center rounded-full bg-primary px-1 text-[9.5px] leading-[15px] font-semibold text-primary-foreground">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>
        </div>
      </div>

      <NotificationSheet open={alertsOpen} onClose={() => setAlertsOpen(false)} />

      {/* Cancel is the wide, plain one and sits first in the DOM, so on a phone
          -- where DialogFooter stacks column-reverse -- the destructive action
          is the one furthest from the thumb's resting position. */}
      <Dialog open={confirmingSignOut} onOpenChange={setConfirmingSignOut}>
        {/* No width or radius override: on a phone DialogContent is already a
            full-width sheet rising from the bottom edge, and capping its width
            here left it pinned to the left with a strip of overlay beside it. */}
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Sign out?</DialogTitle>
            <DialogDescription>
              You will need your password and a fresh sign-in code to get back in.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="lg"
              onClick={() => setConfirmingSignOut(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="lg"
              // The heavy one. Opening the dialog was a tap; ending the session
              // should not feel like the same event.
              onClick={() => {
                impactFeedback();
                setConfirmingSignOut(false);
                signOut();
              }}
            >
              <LogOut aria-hidden />
              Sign out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}
