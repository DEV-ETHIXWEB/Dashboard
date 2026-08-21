import { useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { useReducedMotion } from "framer-motion";
import { successFeedback } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/** How far the thumb has to travel before the release counts. */
const THRESHOLD = 72;

/** Past this the pull stops following the finger, so it never feels unbounded. */
const MAX_PULL = 120;

/**
 * Drag down at the top of a page to refetch it.
 *
 * This is the gesture people try first on a phone, and its absence is most of
 * what makes a web app feel like a web page. Touch only: a mouse has a refresh
 * button and a keyboard.
 *
 * It only engages when the page is already scrolled to the top and the finger
 * moves down, so it never steals a normal scroll.
 */
export function PullToRefresh({
  onRefresh,
  scrollRef,
  children,
}: {
  onRefresh: () => void | Promise<void>;
  scrollRef: React.RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const armed = useRef(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof window !== "undefined" && !window.matchMedia("(pointer: coarse)").matches) return;

    const onTouchStart = (e: TouchEvent) => {
      if (refreshing || e.touches.length !== 1) return;
      armed.current = el.scrollTop <= 0;
      startY.current = armed.current ? e.touches[0].clientY : null;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!armed.current || startY.current == null || refreshing) return;
      const delta = e.touches[0].clientY - startY.current;
      if (delta <= 0) {
        setPull(0);
        return;
      }
      if (el.scrollTop > 0) {
        armed.current = false;
        setPull(0);
        return;
      }
      // Resistance: the further you go, the less you get.
      const eased = Math.min(MAX_PULL, delta ** 0.85);
      setPull(eased);
    };

    const onTouchEnd = async () => {
      if (!armed.current) return;
      armed.current = false;
      startY.current = null;

      if (pull < THRESHOLD) {
        setPull(0);
        return;
      }

      successFeedback();
      setRefreshing(true);
      setPull(THRESHOLD * 0.7);
      try {
        await onRefresh();
        // Long enough to read as an action rather than a flicker.
        await new Promise((resolve) => setTimeout(resolve, 450));
      } finally {
        setRefreshing(false);
        setPull(0);
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [onRefresh, pull, refreshing, scrollRef]);

  const ready = pull >= THRESHOLD;

  return (
    <>
      <div
        aria-hidden={!refreshing}
        role={refreshing ? "status" : undefined}
        className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center md:hidden"
        style={{
          transform: `translateY(${Math.max(0, pull - 34)}px)`,
          opacity: pull > 6 ? 1 : 0,
          transition: pull === 0 || refreshing ? "transform 220ms var(--ease-standard), opacity 160ms" : "none",
        }}
      >
        <span
          className={cn(
            "mt-2 flex size-9 items-center justify-center rounded-full bg-card shadow-md ring-1 ring-foreground/10",
            ready || refreshing ? "text-primary" : "text-muted-foreground",
          )}
        >
          <RefreshCw
            aria-hidden
            className={cn("size-4", refreshing && !reduceMotion && "animate-spin")}
            style={
              refreshing || reduceMotion ? undefined : { transform: `rotate(${Math.round(pull * 2.6)}deg)` }
            }
          />
        </span>
      </div>

      <div
        style={{
          transform: pull > 0 ? `translateY(${pull * 0.35}px)` : undefined,
          transition: pull === 0 ? "transform 260ms var(--ease-standard)" : "none",
        }}
      >
        {children}
      </div>
    </>
  );
}
