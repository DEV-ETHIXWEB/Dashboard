import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { useNotifications, useMarkNotificationRead } from "@/hooks/useData";
import { kindOf, lookFor } from "@/lib/notifications";
import type { Notification } from "@/lib/entities";

/**
 * What the two notification panels agree on.
 *
 * The popover under the bell on a desk and the sheet that rises from the bell
 * on a phone show the same short list, in the same order, leading to the same
 * places. Only the box around them differs. This is the part that must not
 * drift; the rendering lives in components/NotificationList.tsx.
 */

/** How many fit in a panel before "View all" is the better answer. */
export const PREVIEW = 6;

/** Everyone lands on the same full list; only the panels are per-surface. */
export const NOTIFICATIONS_ROUTE = "/portal/notifications";

/**
 * The few worth previewing, unread first and then newest.
 *
 * The panel is small, so what has not been seen has to be what is in it.
 */
export function useNotificationPreview() {
  const { data } = useNotifications();
  const items = data ?? [];
  const unread = items.filter((n) => !n.read).length;
  const preview = [...items]
    .sort((a, b) => {
      if (a.read !== b.read) return a.read ? 1 : -1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
    .slice(0, PREVIEW);
  return { items, unread, preview };
}

/**
 * Opening one: mark it read, close whatever it was shown in, then go.
 *
 * `close` runs before `navigate` deliberately. Leaving a popover or a sheet
 * mounted across a route change means the new page arrives underneath a layer
 * that is still swallowing taps.
 */
export function useOpenNotification(close: () => void) {
  const { user } = useAuth();
  const markRead = useMarkNotificationRead();
  const navigate = useNavigate();

  return (n: Notification) => {
    if (!n.read) markRead.mutate(n.id);
    const to = lookFor(kindOf(n.type), user?.role === "client").to;
    close();
    navigate(to ?? NOTIFICATIONS_ROUTE);
  };
}
