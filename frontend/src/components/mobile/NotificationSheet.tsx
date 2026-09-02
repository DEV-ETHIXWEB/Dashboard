import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { NotificationRows } from "@/components/NotificationList";
import {
  NOTIFICATIONS_ROUTE,
  useNotificationPreview,
  useOpenNotification,
} from "@/hooks/useNotificationPanel";
import { successFeedback } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/** Long enough to read as a movement, short enough not to be waited on. */
const CLOSE_MS = 260;

/**
 * Notifications on a phone, as a sheet rather than a page.
 *
 * Tapping the bell used to be a navigation: it left whatever you were reading,
 * pushed a route, and made "back" the price of a glance. A glance should cost
 * a tap and give the page back on the next one -- so this rises from the bar
 * the bell lives in, dims the page behind it, and goes away when you tap off
 * it, flick it down, or press Escape.
 *
 * The mount/unmount dance is MoreSheet's, for MoreSheet's reason: a sheet that
 * animates away but never unmounts leaves an invisible full-screen layer over
 * the app, swallowing every tap. The list inside is the desktop popover's --
 * see components/NotificationList.tsx.
 */
export function NotificationSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const { items, unread, preview } = useNotificationPreview();
  const openItem = useOpenNotification(onClose);

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
        aria-label="Close notifications"
        onClick={onClose}
        className={cn(
          "absolute inset-0 h-full w-full bg-black/50 backdrop-blur-[2px] transition-opacity duration-200",
          shown ? "opacity-100" : "opacity-0",
        )}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        className={cn(
          "absolute inset-x-0 bottom-0 flex max-h-[85svh] flex-col overflow-hidden rounded-t-[26px] border-t border-border bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl",
          // The curve iOS uses for sheets: quick off the mark, long settle.
          "transition-transform duration-[260ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          shown ? "translate-y-0" : "translate-y-full",
        )}
      >
        {/* Drag lives on an inner layer so the gesture and the open/close
            movement never fight over the same transform. Only the grabber and
            the header carry it -- dragging the list itself has to scroll. */}
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
          className="shrink-0"
        >
          <div className="flex cursor-grab justify-center pt-2.5 pb-1 active:cursor-grabbing">
            <span aria-hidden className="h-1 w-9 rounded-full bg-border" />
          </div>

          <div className="flex items-baseline justify-between gap-2 px-5 pt-1 pb-3">
            <h2 className="text-[17px] leading-tight font-semibold tracking-tight">Notifications</h2>
            <p className="text-xs text-muted-foreground">
              {unread > 0 ? `${unread} unread` : "All caught up"}
            </p>
          </div>
        </motion.div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border/70">
          <NotificationRows preview={preview} onOpen={openItem} touch />
        </div>

        {items.length > 0 && (
          <button
            type="button"
            onClick={() => {
              onClose();
              navigate(NOTIFICATIONS_ROUTE);
            }}
            className="focus-clear w-full shrink-0 touch-manipulation border-t border-border/70 px-5 py-3.5 text-center text-sm font-medium text-primary active:bg-secondary"
          >
            View all notifications
          </button>
        )}
      </div>
    </div>
  );
}
