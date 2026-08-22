import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, setCsrfToken } from "@/lib/api";
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
    staleTime: Infinity,
  });

  useEffect(() => {
    (async () => {
      try {
        const res = await api<{ user: User; capabilities?: Capabilities; csrfToken: string }>("GET", "/auth/me");
        setCsrfToken(res.csrfToken);
        setUser(res.user);
        setCan(res.capabilities ?? NO_CAPABILITIES);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) console.error(err);
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
        queryClient.clear();
      }
    }
  }

  function setSession(nextUser: User, csrfToken?: string) {
    if (csrfToken) setCsrfToken(csrfToken);
    setUser(nextUser);
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
      queryClient.clear();
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
