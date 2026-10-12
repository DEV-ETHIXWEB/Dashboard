import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, setCsrfToken } from "@/lib/api";
import { clearOfflineCaches } from "@/lib/pwa";
import { clearPersistedCache } from "@/lib/queryPersist";
import { prefetchHome } from "@/lib/routeChunks";
import { clearSessionHint, rememberSessionHint } from "@/lib/sessionHint";
import { NO_CAPABILITIES, type Capabilities, type PublicConfig, type User } from "@/lib/types";

interface AuthContextValue {
  user: User | null;
  /** What the server says this account may do. Never widened on the client. */
  can: Capabilities;
  config: PublicConfig | null;
  isLoading: boolean;
  setSession: (user: User, csrfToken?: string) => void;
  /** Re-read the account after an admin changed its role or section access. */
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [can, setCan] = useState<Capabilities>(NO_CAPABILITIES);
  const [ready, setReady] = useState(false);

  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: () => api<PublicConfig>("GET", "/config"),
  });

  useEffect(() => {
    let cancelled = false;

    /**
     * Who this is, with a retry for everything that is not a 401.
     *
     * Only a 401 means "not signed in". Every other failure -- a 429 from the
     * rate limiter, a 502 while a deploy swaps over, a network that dropped on
     * a train -- says nothing about whether this person has a session, and the
     * route guard read "no user" as "signed out" and showed the login screen.
     * Somebody who was signed in a second ago then sees a sign-in form with no
     * message and no retry, which looks exactly like having been logged out.
     *
     * So the transient cases back off and try again, and `ready` is only set
     * once there is an answer worth acting on. Four attempts over about eight
     * seconds, which outlasts a rate-limit window reset and a deploy.
     */
    (async () => {
      const BACKOFF_MS = [500, 1500, 4000];

      for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
        if (cancelled) return;
        try {
          const res = await api<{ user: User; capabilities?: Capabilities; csrfToken: string }>("GET", "/auth/me");
          if (cancelled) return;
          setCsrfToken(res.csrfToken);
          setUser(res.user);
          setCan(res.capabilities ?? NO_CAPABILITIES);
          rememberSessionHint();
          break;
        } catch (err) {
          // A 401 is the server saying there is no session on this browser,
          // which is the one thing that can retire the hint honestly, and the
          // one answer there is no point retrying.
          if (err instanceof ApiError && err.status === 401) {
            clearSessionHint();
            break;
          }
          console.error(err);
          if (attempt === BACKOFF_MS.length) break;
          await new Promise((resolve) => { setTimeout(resolve, BACKOFF_MS[attempt]); });
        }
      }

      if (!cancelled) setReady(true);
    })();

    return () => { cancelled = true; };
  }, []);

  async function refreshUser() {
    try {
      const res = await api<{ user: User; capabilities?: Capabilities; csrfToken: string }>("GET", "/auth/me");
      setCsrfToken(res.csrfToken);
      setUser(res.user);
      setCan(res.capabilities ?? NO_CAPABILITIES);
    } catch (err) {
      // A 401 here means the session went away; the route guards handle it.
      if (err instanceof ApiError && err.status === 401) {
        setCsrfToken(null);
        setUser(null);
        setCan(NO_CAPABILITIES);
        clearSessionHint();
        queryClient.clear();
        clearPersistedCache();
      }
    }
  }

  function setSession(nextUser: User, csrfToken?: string) {
    if (csrfToken) setCsrfToken(csrfToken);
    setUser(nextUser);
    // From here on this browser can be assumed to have had a session, which is
    // what lets the next visit tell "probably signed in, hold for the answer"
    // apart from "nobody has ever signed in here, show the form now".
    rememberSessionHint();
    // The redirect to the portal is the next thing that happens, and the home
    // screen's code is a separate chunk. Start it now rather than after the
    // route swaps and finds it missing.
    prefetchHome(nextUser.role === "admin");
    // Sign-in does not carry the capability set; read it straight after so the
    // navigation is right on the first paint rather than the second.
    void refreshUser();
  }

  async function logout() {
    try {
      await api("POST", "/auth/logout");
    } finally {
      setCsrfToken(null);
      setUser(null);
      setCan(NO_CAPABILITIES);
      clearSessionHint();
      queryClient.clear();
      // `queryClient.clear()` empties this tab's memory; the session-storage
      // copy of the cacheable-by-policy answers has to be told separately.
      clearPersistedCache();
      // The offline shell outlives the session otherwise. Nothing private is in
      // it -- the worker never caches /api/ -- but the next person on a shared
      // phone should not inherit a warm app either, and sw.js has always had
      // the handler for this. Nothing had ever called it.
      clearOfflineCaches();
    }
  }

  return (
    <AuthContext.Provider value={{ user, can, config: config ?? null, isLoading: !ready, setSession, refreshUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
