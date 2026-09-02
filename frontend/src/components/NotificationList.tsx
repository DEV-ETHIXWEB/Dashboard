import { useAuth } from "@/context/AuthContext";
import { formatRelativeTime } from "@/lib/format";
import { kindOf, lookFor } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import type { Notification } from "@/lib/entities";

/**
 * The notification panel, minus the box it sits in.
 *
 * Two surfaces show the same short list: the popover under the bell on a desk,
 * and the sheet that rises from the bell on a phone. They differ in how they
 * arrive and in how big a thumb needs the rows to be -- and in nothing else.
 * Keeping the rendering here means a change lands on both surfaces rather than
 * on whichever one the next person happens to open. The ordering and the
 * "where does this one lead" decision they also share live in
 * hooks/useNotificationPanel.ts.
 */

/**
 * The rows.
 *
 * `touch` is the phone's version: taller rows, larger type, and a hit box that
 * clears the 44px a thumb needs. The desk keeps the compact one, where a
 * pointer is precise and vertical space in a popover is scarce.
 */
export function NotificationRows({
  preview,
  onOpen,
  touch = false,
}: {
  preview: Notification[];
  onOpen: (n: Notification) => void;
  touch?: boolean;
}) {
  const { user } = useAuth();

  if (preview.length === 0) {
    return (
      <p className={cn("text-center text-sm text-muted-foreground", touch ? "px-5 py-10" : "px-3.5 py-6")}>
        Nothing has happened yet.
      </p>
    );
  }

  return (
    <ul>
      {preview.map((n) => {
        const look = lookFor(kindOf(n.type), user?.role === "client");
        const Icon = look.icon;
        return (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => onOpen(n)}
              className={cn(
                "focus-clear flex w-full items-start gap-2.5 text-left transition-colors",
                touch
                  ? "min-h-11 touch-manipulation gap-3 px-5 py-3.5 active:bg-secondary"
                  : "px-3.5 py-2.5 hover:bg-secondary/70",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex shrink-0 items-center justify-center rounded-lg",
                  touch ? "size-9" : "size-7",
                  look.tone,
                )}
              >
                <Icon aria-hidden className={touch ? "size-4" : "size-3.5"} />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block leading-snug",
                    touch ? "text-sm" : "text-[13px]",
                    n.read ? "text-muted-foreground" : "font-medium text-foreground",
                  )}
                >
                  {n.message}
                </span>
                <span className={cn("mt-0.5 block text-muted-foreground", touch ? "text-xs" : "text-[11px]")}>
                  {formatRelativeTime(new Date(n.createdAt).getTime())}
                </span>
              </span>
              {!n.read && (
                <span
                  aria-hidden
                  className={cn("shrink-0 rounded-full bg-primary", touch ? "mt-2 size-2" : "mt-1.5 size-1.5")}
                />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
