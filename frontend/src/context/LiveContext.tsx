import { createContext, useContext, type ReactNode } from "react";
import { useAuth } from "@/context/AuthContext";
import { useLiveUpdates } from "@/hooks/useLiveUpdates";
import type { LiveStatus } from "@/lib/live";

interface LiveContextValue {
  status: LiveStatus;
  /** Refetch every query currently on screen -- what pull-to-refresh calls. */
  refresh: () => void;
}

const LiveContext = createContext<LiveContextValue>({ status: "connecting", refresh: () => {} });

/**
 * One stream per tab, opened once the user is signed in and closed the moment
 * they are not. Mounted above the router so navigating never drops it.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const { user, refreshUser } = useAuth();
  const { status, refetchEverything } = useLiveUpdates(Boolean(user), refreshUser);

  return (
    <LiveContext.Provider value={{ status, refresh: refetchEverything }}>{children}</LiveContext.Provider>
  );
}

export function useLive() {
  return useContext(LiveContext);
}
