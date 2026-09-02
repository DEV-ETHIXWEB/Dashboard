import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { prefetchRoute } from "@/lib/routeChunks";
import { motion, useReducedMotion } from "framer-motion";
import { useAuth } from "@/context/AuthContext";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { LiveIndicator } from "@/components/LiveIndicator";
import { UserAvatar } from "@/components/UserAvatar";
import { successFeedback, tapFeedback } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import type { NavItem } from "@/lib/nav";

/** Long enough to read as a movement, short enough not to be waited on. */
const CLOSE_MS = 260;

/**
 * The rest of the app, as a sheet that comes up from the bar it was tapped on.
 *
 * A drawer that flies in from the left is a website's idea of a menu. This one
 * behaves the way a phone does: it rises from the bottom, it can be thrown back
 * down with a flick, and the page behind it stays put and visibly dims.
 *
 * Mounting is driven by a timer rather than by an animation library's exit
 * hook. A sheet that animates away but never unmounts leaves an invisible
 * full-screen layer over the app, swallowing every tap -- much worse than a
 * close that is a frame early.
 */
export function MoreSheet({
  open,
  onClose,
  items,
  unread,
}: {
  open: boolean;
  onClose: () => void;
  items: NavItem[];
  unread: number;
}) {
  const { user } = useAuth();
  const reduceMotion = useReducedMotion();

  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // One frame at the closed position, so the browser has something to
      // animate away from.
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), reduceMotion ? 0 : CLOSE_MS);
    return () => clearTimeout(timer);
  }, [open, reduceMotion]);

  // A sheet over a scrolling page is the classic way to lose your place.
  useEffect(() => {
    if (!mounted) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mounted]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className={cn(
          "absolute inset-0 h-full w-full bg-black/50 backdrop-blur-[2px] transition-opacity duration-200",
          shown ? "opacity-100" : "opacity-0",
        )}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="More"
        className={cn(
          "absolute inset-x-0 bottom-0 max-h-[85svh] overflow-hidden rounded-t-[26px] border-t border-border bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl",
          // The curve iOS uses for sheets: quick off the mark, long settle.
          "transition-transform duration-[260ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          shown ? "translate-y-0" : "translate-y-full",
        )}
      >
        {/* Drag lives on an inner layer so the gesture and the open/close
            movement never fight over the same transform. */}
        <motion.div
          drag={reduceMotion ? false : "y"}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 0.4 }}
          dragMomentum={false}
          onDragEnd={(_, info) => {
            // Distance or speed, whichever the thumb offered.
            if (info.offset.y > 120 || info.velocity.y > 650) {
              successFeedback();
              onClose();
            }
          }}
        >
          <div className="flex cursor-grab justify-center pt-2.5 pb-1 active:cursor-grabbing">
            <span aria-hidden className="h-1 w-9 rounded-full bg-border" />
          </div>

          <div className="flex items-center gap-3 px-5 pt-1 pb-3">
            <UserAvatar user={user} size="lg" className="size-10" fallbackClassName="text-sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] leading-tight font-semibold">{user?.name}</div>
              <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
            </div>
            <LiveIndicator />
          </div>

          <nav className="max-h-[52svh] overflow-y-auto overscroll-contain px-3 pb-2">
            <ul className="grid grid-cols-2 gap-2">
              {items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    onPointerDown={() => prefetchRoute(item.to)}
                    onClick={() => {
                      tapFeedback();
                      onClose();
                    }}
                    className={({ isActive }) =>
                      cn(
                        "focus-clear flex h-[4.5rem] touch-manipulation flex-col justify-between rounded-2xl border p-3 transition-colors active:scale-[0.98]",
                        isActive
                          ? "border-primary/30 bg-primary/10 text-primary"
                          : "border-border bg-card text-foreground",
                      )
                    }
                  >
                    <span className="flex w-full items-start justify-between">
                      <item.icon aria-hidden className="size-5 shrink-0" strokeWidth={1.9} />
                      {item.label === "Alerts" && unread > 0 && (
                        <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none font-semibold text-primary-foreground">
                          {unread > 9 ? "9+" : unread}
                        </span>
                      )}
                    </span>
                    <span className="text-sm leading-tight font-medium">{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>

          {/* Sign out used to close the sheet. It lives in the top bar now, one
              tap from anywhere instead of two from here, so the theme switch is
              the last row.
              Even padding, not the lopsided 12/20 it inherited when the button
              below it went away: this is the only thing in its own band, so any
              difference between the space above and below it reads as a
              mistake. The device's own bottom inset is added by the sheet, so
              16 here is 16 of actual air on every phone. */}
          <div className="border-t border-border px-5 py-4">
            <ThemeSwitch />
          </div>
        </motion.div>
      </div>
    </div>
  );
}
