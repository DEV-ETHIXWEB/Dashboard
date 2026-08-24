import { Radio, RefreshCw, WifiOff } from "lucide-react";
import { useLive } from "@/context/LiveContext";
import { cn } from "@/lib/utils";

/**
 * Whether this screen is still hearing from the office.
 *
 * "Live" is the quiet state and stays quiet -- a small dot, no words on a
 * phone. The loud states are the ones worth a person's attention: a client
 * reading a number needs to know when it stopped being current.
 */
export function LiveIndicator({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { status } = useLive();

  const look = {
    live: {
      label: "Live",
      title: "Updating as things change",
      icon: Radio,
      tone: "text-success",
      dot: "bg-success",
    },
    connecting: {
      label: "Connecting",
      title: "Reconnecting to the live feed",
      icon: RefreshCw,
      tone: "text-muted-foreground",
      dot: "bg-muted-foreground",
    },
    polling: {
      label: "Checking",
      title: "Live feed unavailable, checking every 30 seconds",
      icon: RefreshCw,
      tone: "text-muted-foreground",
      dot: "bg-warning",
    },
    offline: {
      label: "Offline",
      title: "No connection. Showing the last thing we loaded.",
      icon: WifiOff,
      tone: "text-warning",
      dot: "bg-warning",
    },
  }[status];

  const Icon = look.icon;

  if (compact) {
    return (
      <span
        role="status"
        aria-label={look.title}
        title={look.title}
        className={cn("relative inline-flex size-2 shrink-0", className)}
      >
        {status === "live" && (
          <span aria-hidden className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", look.dot)} />
        )}
        <span aria-hidden className={cn("relative inline-flex size-2 rounded-full", look.dot)} />
      </span>
    );
  }

  return (
    <span
      role="status"
      title={look.title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-secondary/70 px-2 py-1 text-[11px] font-medium whitespace-nowrap",
        look.tone,
        className,
      )}
    >
      <Icon aria-hidden className={cn("size-3", status === "connecting" && "animate-spin")} />
      {look.label}
    </span>
  );
}
