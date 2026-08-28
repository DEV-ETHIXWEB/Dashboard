import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { LogoBuildAnimation } from "@/components/LogoBuildAnimation";

export function GuestRoute({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <LogoBuildAnimation />
      </div>
    );
  }

  if (user) {
    return <Navigate to="/portal" replace />;
  }

  return <>{children}</>;
}
