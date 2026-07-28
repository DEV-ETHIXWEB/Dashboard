import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, setCsrfToken } from "@/lib/api";
import type { PublicConfig, User } from "@/lib/types";

interface AuthContextValue {
  user: User | null;
  config: PublicConfig | null;
  isLoading: boolean;
  setSession: (user: User, csrfToken?: string) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: () => api<PublicConfig>("GET", "/config"),
    staleTime: Infinity,
  });

  useEffect(() => {
    (async () => {
      try {
        const res = await api<{ user: User; csrfToken: string }>("GET", "/auth/me");
        setCsrfToken(res.csrfToken);
        setUser(res.user);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) console.error(err);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  function setSession(nextUser: User, csrfToken?: string) {
    if (csrfToken) setCsrfToken(csrfToken);
    setUser(nextUser);
  }

  async function logout() {
    try {
      await api("POST", "/auth/logout");
    } finally {
      setCsrfToken(null);
      setUser(null);
      queryClient.clear();
    }
  }

  return (
    <AuthContext.Provider value={{ user, config: config ?? null, isLoading: !ready, setSession, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
