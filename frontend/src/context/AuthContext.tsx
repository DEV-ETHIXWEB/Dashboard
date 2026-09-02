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
    (async () => {
      try {
        const res = await api<{ user: User; capabilities?: Capabilities; csrfToken: string }>("GET", "/auth/me");
        setCsrfToken(res.csrfToken);
        setUser(res.user);
        setCan(res.capabilities ?? NO_CAPABILITIES);
        rememberSessionHint();
      } catch (err) {
        // A 401 is the server saying there is no session on this browser, which
        // is the one thing that can retire the hint honestly. Anything else --
        // the API being down, a network that dropped -- says nothing about
        // whether this person is signed in, so the hint stands.
        if (err instanceof ApiError && err.status === 401) clearSessionHint();
        else console.error(err);
      } finally {
        setReady(true);
      }
    })();
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
