import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/AppShell";
import { PasswordResetRequired } from "@/components/PasswordResetRequired";
import { canSeePage, pageKeyForPath } from "@/lib/permissions";
import type { Role } from "@/lib/types";

export function RoleRoute({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  return (
    <ProtectedRoute>
      <PasswordGate>
        <AppShell>
          <RoleGate roles={roles}>{children}</RoleGate>
        </AppShell>
      </PasswordGate>
    </ProtectedRoute>
  );
}

/**
 * An expired password stands in front of every screen, not beside one.
 *
 * Outside AppShell on purpose: the server is already refusing every endpoint
 * the shell reads from -- notifications, approvals, the live stream -- so
 * rendering the dashboard around a notice would fill it with error states and
 * make a policy look like an outage. One screen, one thing to do.
 *
 * The server enforces this independently (middleware/auth.js). This is what
 * makes the enforcement legible rather than what performs it.
 */
function PasswordGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.passwordStatus?.resetRequired) return <PasswordResetRequired />;
  return <>{children}</>;
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
