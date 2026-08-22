import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/AppShell";
import { canSeePage, pageKeyForPath } from "@/lib/permissions";
import type { Role } from "@/lib/types";

export function RoleRoute({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  return (
    <ProtectedRoute>
      <AppShell>
        <RoleGate roles={roles}>{children}</RoleGate>
      </AppShell>
    </ProtectedRoute>
  );
}

function RoleGate({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { user } = useAuth();
  const { pathname } = useLocation();

  if (roles && user && !roles.includes(user.role)) return <Navigate to="/portal" replace />;
  // A client whose admin switched this section off never reaches the page; the
  // API refuses it too, so this is purely to avoid a dead-end screen.
  if (user && !canSeePage(user, pageKeyForPath(pathname))) return <Navigate to="/portal" replace />;
  return <>{children}</>;
}
