import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/AppShell";
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
  if (roles && user && !roles.includes(user.role)) return <Navigate to="/portal" replace />;
  return <>{children}</>;
}
