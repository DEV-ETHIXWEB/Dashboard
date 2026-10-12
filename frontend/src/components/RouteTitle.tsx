import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * The name of each route, for the browser tab.
 *
 * Nothing ever set `document.title`, so every tab in the application read
 * "EthixWeb CRM" -- which on a phone is a row of identical entries in the app
 * switcher, and in the history is a list of pages you cannot tell apart.
 *
 * Done here, from the path, rather than with a hook in each of the thirty-odd
 * pages. A title is a property of the route, every page would have written the
 * same three lines, and the ones that forgot would have been the ones nobody
 * noticed.
 *
 * Longest match wins, so `/portal/billing/plans` beats `/portal/billing`.
 */
const TITLES: Array<[string, string]> = [
  ["/login", "Sign in"],
  ["/set-password", "Set your password"],
  ["/confirm-email", "Confirm your email"],
  ["/sign-in-link", "Sign in"],
  ["/terms", "Terms of service"],
  ["/privacy", "Privacy policy"],
  ["/portal/billing/plans", "Plans"],
  ["/portal/billing/cancel", "Cancel your plan"],
  ["/portal/billing", "Billing"],
  ["/portal/projects", "Projects"],
  ["/portal/tasks", "Tasks"],
  ["/portal/progress", "Progress"],
  ["/portal/tickets", "Requests"],
  ["/portal/messages", "Messages"],
  ["/portal/domains", "Websites"],
  ["/portal/reports", "Documents"],
  ["/portal/budget", "Budget"],
  ["/portal/team", "Team"],
  ["/portal/client-access", "Client access"],
  ["/portal/otp-monitor", "Sign-in codes"],
  ["/portal/clickup", "ClickUp"],
  ["/portal/profile", "Your profile"],
  ["/portal", "Dashboard"],
];

function titleFor(pathname: string): string | null {
  const match = TITLES.filter(([path]) => pathname === path || pathname.startsWith(`${path}/`))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return match ? match[1] : null;
}

/**
 * Mounted once inside the router. Sets the tab title on every navigation, and
 * lets the two public legal pages out of the shell's `noindex` -- they are
 * linked from the footer of every email we send and are meant to be found.
 */
export function RouteTitle() {
  const { pathname } = useLocation();

  useEffect(() => {
    const name = titleFor(pathname);
    document.title = name ? `${name} · EthixWeb` : "EthixWeb CRM";
  }, [pathname]);

  useEffect(() => {
    const publicPage = pathname === "/terms" || pathname === "/privacy";
    const tag = document.querySelector('meta[name="robots"]');
    if (!tag) return undefined;
    tag.setAttribute("content", publicPage ? "index, follow" : "noindex, nofollow");
    return () => tag.setAttribute("content", "noindex, nofollow");
  }, [pathname]);

  return null;
}
