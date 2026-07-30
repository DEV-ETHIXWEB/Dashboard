import { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { RoleRoute } from "@/components/RoleRoute";
import { GuestRoute } from "@/components/GuestRoute";

const Login = lazy(() => import("@/pages/Login"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Projects = lazy(() => import("@/pages/Projects"));
const Tasks = lazy(() => import("@/pages/Tasks"));
const Tickets = lazy(() => import("@/pages/Tickets"));
const Domains = lazy(() => import("@/pages/Domains"));
const Reports = lazy(() => import("@/pages/Reports"));
const Budget = lazy(() => import("@/pages/Budget"));
const Billing = lazy(() => import("@/pages/Billing"));
const Team = lazy(() => import("@/pages/Team"));
const OtpMonitor = lazy(() => import("@/pages/OtpMonitor"));
const Settings = lazy(() => import("@/pages/Settings"));
const Notifications = lazy(() => import("@/pages/Notifications"));

function RouteFallback() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function App() {
  return (
    <>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route
            path="/login"
            element={
              <GuestRoute>
                <Login />
              </GuestRoute>
            }
          />
          <Route path="/portal" element={<RoleRoute><Dashboard /></RoleRoute>} />
          <Route
            path="/portal/projects"
            element={
              <RoleRoute roles={["admin", "sales", "project_manager", "client"]}>
                <Projects />
              </RoleRoute>
            }
          />
          <Route
            path="/portal/tasks"
            element={
              <RoleRoute roles={["admin", "project_manager", "employee"]}>
                <Tasks />
              </RoleRoute>
            }
          />
          <Route path="/portal/tickets" element={<RoleRoute><Tickets /></RoleRoute>} />
          <Route
            path="/portal/domains"
            element={
              <RoleRoute roles={["admin", "sales", "project_manager", "client"]}>
                <Domains />
              </RoleRoute>
            }
          />
          <Route
            path="/portal/reports"
            element={
              <RoleRoute roles={["admin", "sales", "project_manager", "client"]}>
                <Reports />
              </RoleRoute>
            }
          />
          <Route
            path="/portal/budget"
            element={
              <RoleRoute roles={["admin", "project_manager", "client"]}>
                <Budget />
              </RoleRoute>
            }
          />
          <Route
            path="/portal/billing"
            element={
              <RoleRoute roles={["admin", "client"]}>
                <Billing />
              </RoleRoute>
            }
          />
          <Route
            path="/portal/team"
            element={
              <RoleRoute roles={["admin"]}>
                <Team />
              </RoleRoute>
            }
          />
          <Route
            path="/portal/otp-monitor"
            element={
              <RoleRoute roles={["admin"]}>
                <OtpMonitor />
              </RoleRoute>
            }
          />
          <Route path="/portal/settings" element={<RoleRoute><Settings /></RoleRoute>} />
          <Route path="/portal/notifications" element={<RoleRoute><Notifications /></RoleRoute>} />

          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
      <Toaster position="top-right" />
    </>
  );
}

export default App;
