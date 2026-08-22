import { NavLink, useLocation } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { MoreHorizontal } from "lucide-react";
import { tapFeedback } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import type { NavItem } from "@/lib/nav";

/**
 * The bar a thumb lives on.
 *
 * Five slots, never more: four destinations and More. The active tab is marked
 * by a pill that slides between slots rather than appearing in place, which is
 * the single cue that separates an app from a website with buttons at the
 * bottom. `layoutId` does the sliding; anyone who has asked their phone for
 * less motion gets the same pill without the travel.
 */
export function BottomTabs({
  items,
  moreCount,
  onOpenMore,
  moreOpen,
}: {
  items: NavItem[];
  moreCount: number;
  onOpenMore: () => void;
  moreOpen: boolean;
}) {
  const { pathname } = useLocation();
  const reduceMotion = useReducedMotion();

  if (items.length === 0) return null;

  const isActive = (to: string) => (to === "/portal" ? pathname === to : pathname.startsWith(to));

  return (
    <nav
      aria-label="Main"
      className="app-chrome fixed inset-x-0 bottom-0 z-40 border-t border-border/70 pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="mx-auto flex max-w-lg items-stretch">
        {items.map((item) => {
          const active = isActive(item.to) && !moreOpen;
          return (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.to === "/portal"}
                onClick={tapFeedback}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "focus-clear touch-control relative flex h-[3.75rem] w-full flex-col items-center justify-center gap-1",
                  active ? "text-primary" : "text-muted-foreground active:text-foreground",
                )}
              >
                {active && (
                  <motion.span
                    aria-hidden
                    layoutId="tab-pill"
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : { type: "spring", stiffness: 520, damping: 38, mass: 0.7 }
                    }
                    className="absolute inset-x-2 inset-y-1.5 -z-10 rounded-2xl bg-primary/10"
                  />
                )}
                <item.icon aria-hidden className="size-[22px] shrink-0" strokeWidth={active ? 2.3 : 1.8} />
                <span className={cn("max-w-full truncate text-[10.5px] leading-none tracking-tight", active ? "font-semibold" : "font-medium")}>
                  {item.short ?? item.label}
                </span>
              </NavLink>
            </li>
          );
        })}

        {moreCount > 0 && (
          <li className="flex-1">
            <button
              type="button"
              onClick={() => {
                tapFeedback();
                onOpenMore();
              }}
              aria-expanded={moreOpen}
              aria-haspopup="dialog"
              className={cn(
                "focus-clear touch-control relative flex h-[3.75rem] w-full flex-col items-center justify-center gap-1",
                moreOpen ? "text-primary" : "text-muted-foreground active:text-foreground",
              )}
            >
              {moreOpen && (
                <motion.span
                  aria-hidden
                  layoutId="tab-pill"
                  transition={
                    reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 38, mass: 0.7 }
                  }
                  className="absolute inset-x-2 inset-y-1.5 -z-10 rounded-2xl bg-primary/10"
                />
              )}
              <MoreHorizontal aria-hidden className="size-[22px] shrink-0" strokeWidth={moreOpen ? 2.3 : 1.8} />
              <span className={cn("text-[10.5px] leading-none tracking-tight", moreOpen ? "font-semibold" : "font-medium")}>
                More
              </span>
            </button>
          </li>
        )}
      </ul>
    </nav>
  );
}
