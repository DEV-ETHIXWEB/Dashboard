import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import { NotificationRows } from "@/components/NotificationList";
import {
  NOTIFICATIONS_ROUTE,
  useNotificationPreview,
  useOpenNotification,
} from "@/hooks/useNotificationPanel";
import { cn } from "@/lib/utils";

/**
 * The bell in the desktop header.
 *
 * A phone has the bell in its top bar; a desk had nothing -- the only way to
 * see an alert was to notice a badge in the sidebar and change page for it.
 * This shows the latest few in place, so glancing at them costs one click and
 * keeps whatever you were reading on screen.
 *
 * The phone's equivalent is components/mobile/NotificationSheet.tsx. The list
 * inside both comes from components/NotificationList.tsx.
 */
export function NotificationBell() {
  const navigate = useNavigate();
  const { unread, preview } = useNotificationPreview();

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const openItem = useOpenNotification(() => setOpen(false));

  // Click-away and Escape, the two ways anyone expects a popover to close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className={cn(
          "focus-clear relative inline-flex size-9 items-center justify-center rounded-xl border border-border/70 bg-card text-foreground transition-colors hover:bg-secondary",
          open && "bg-secondary",
        )}
      >
        <Bell aria-hidden className="size-[18px]" strokeWidth={1.9} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 flex min-w-[17px] items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-[17px] font-semibold text-primary-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute top-11 right-0 z-50 w-80 overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3.5 py-2.5">
            <p className="text-sm font-semibold tracking-tight">Notifications</p>
            <p className="text-xs text-muted-foreground">
              {unread > 0 ? `${unread} unread` : "All caught up"}
            </p>
          </div>

          <div className="max-h-[22rem] overflow-y-auto scrollbar-slim">
            <NotificationRows preview={preview} onOpen={openItem} />
          </div>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate(NOTIFICATIONS_ROUTE);
            }}
            className="focus-clear w-full border-t border-border/70 px-3.5 py-2.5 text-center text-xs font-medium text-primary transition-colors hover:bg-secondary/70"
          >
            View all notifications
          </button>
        </div>
      )}
    </div>
  );
}
