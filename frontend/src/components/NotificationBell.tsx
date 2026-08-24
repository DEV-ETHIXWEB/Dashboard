import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useNotifications, useMarkNotificationRead } from "@/hooks/useData";
import { formatRelativeTime } from "@/lib/format";
import { kindOf, lookFor } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import type { Notification } from "@/lib/entities";

/** How many fit in the panel before "View all" is the better answer. */
const PREVIEW = 6;

/**
 * The bell in the desktop header.
 *
 * A phone has the bell in its top bar; a desk had nothing -- the only way to
 * see an alert was to notice a badge in the sidebar and change page for it.
 * This shows the latest few in place, so glancing at them costs one click and
 * keeps whatever you were reading on screen.
 */
export function NotificationBell() {
  const { user } = useAuth();
  const { data: notifications } = useNotifications();
  const markRead = useMarkNotificationRead();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const items = notifications ?? [];
  const unread = items.filter((n) => !n.read).length;
  // Unread first, then newest: the panel is small, so what has not been seen
  // has to be what is in it.
  const preview = [...items]
    .sort((a, b) => {
      if (a.read !== b.read) return a.read ? 1 : -1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
    .slice(0, PREVIEW);

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

  const openItem = (n: Notification) => {
    if (!n.read) markRead.mutate(n.id);
    const to = lookFor(kindOf(n.type), user?.role === "client").to;
    setOpen(false);
    navigate(to ?? "/portal/notifications");
  };

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

          {preview.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-sm text-muted-foreground">
              Nothing has happened yet.
            </p>
          ) : (
            <ul className="max-h-[22rem] overflow-y-auto scrollbar-slim">
              {preview.map((n) => {
                const look = lookFor(kindOf(n.type), user?.role === "client");
                const Icon = look.icon;
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => openItem(n)}
                      className="focus-clear flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-secondary/70"
                    >
                      <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg", look.tone)}>
                        <Icon aria-hidden className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn("block text-[13px] leading-snug", n.read ? "text-muted-foreground" : "font-medium text-foreground")}>
                          {n.message}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {formatRelativeTime(new Date(n.createdAt).getTime())}
                        </span>
                      </span>
                      {!n.read && <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate("/portal/notifications");
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
