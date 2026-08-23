import { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { RoleRoute } from "@/components/RoleRoute";
import { GuestRoute } from "@/components/GuestRoute";
import { useAuth } from "@/context/AuthContext";

const Login = lazy(() => import("@/pages/Login"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Projects = lazy(() => import("@/pages/Projects"));
const Tasks = lazy(() => import("@/pages/Tasks"));
const Tickets = lazy(() => import("@/pages/Tickets"));
const Domains = lazy(() => import("@/pages/Domains"));
const Reports = lazy(() => import("@/pages/Reports"));
const DocumentView = lazy(() => import("@/pages/DocumentView"));
const Budget = lazy(() => import("@/pages/Budget"));
const Billing = lazy(() => import("@/pages/Billing"));
const Team = lazy(() => import("@/pages/Team"));
const ClientAccess = lazy(() => import("@/pages/ClientAccess"));
const OtpMonitor = lazy(() => import("@/pages/OtpMonitor"));
const AdminHome = lazy(() => import("@/pages/AdminHome"));
const ClickUpTasks = lazy(() => import("@/pages/ClickUpTasks"));
const WorkProgress = lazy(() => import("@/pages/WorkProgress"));
const Messages = lazy(() => import("@/pages/Messages"));
const MailCenter = lazy(() => import("@/pages/MailCenter"));
const SlackMessages = lazy(() => import("@/pages/SlackMessages"));
const Notifications = lazy(() => import("@/pages/Notifications"));
const Approvals = lazy(() => import("@/pages/Approvals"));
const AuditLog = lazy(() => import("@/pages/AuditLog"));
const Security = lazy(() => import("@/pages/Security"));

function RouteFallback() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * Admins get the operations overview at /portal; everyone else keeps the
 * client-facing dashboard. Same URL either way, so nothing else has to change.
 */
function PortalHome() {
  const { user } = useAuth();
  return user?.role === "admin" ? <AdminHome /> : <Dashboard />;
}

/** Bounces an admin who is not a super admin away from a super-admin screen. */
function SuperAdminOnly({ children }: { children: React.ReactNode }) {
  const { can } = useAuth();
  if (!can.canReadAuditLog) return <Navigate to="/portal" replace />;
  return <>{children}</>;
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
          <Route path="/portal" element={<RoleRoute><PortalHome /></RoleRoute>} />
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
          <Route
            path="/portal/progress"
            element={
              <RoleRoute roles={["admin", "sales", "project_manager", "client"]}>
                <WorkProgress />
              </RoleRoute>
            }
          />
          <Route path="/portal/tickets" element={<RoleRoute><Tickets /></RoleRoute>} />
          <Route
            path="/portal/messages"
            element={
              <RoleRoute roles={["admin", "sales", "project_manager", "client"]}>
                <Messages />
              </RoleRoute>
            }
          />
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
          {/* One document, on its own page. Same guard as the list it came from. */}
          <Route
            path="/portal/reports/:id"
            element={
              <RoleRoute roles={["admin", "sales", "project_manager", "client"]}>
                <DocumentView />
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
            path="/portal/client-access"
            element={
              <RoleRoute roles={["admin"]}>
                <ClientAccess />
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
          <Route
            path="/portal/clickup"
            element={
              <RoleRoute roles={["admin"]}>
                <ClickUpTasks />
              </RoleRoute>
            }
          />
          <Route
            path="/portal/mail"
            element={
              <RoleRoute roles={["admin"]}>
                <MailCenter />
              </RoleRoute>
            }
          />
          <Route
            path="/portal/slack"
            element={
              <RoleRoute roles={["admin"]}>
                <SlackMessages />
              </RoleRoute>
            }
          />
          <Route path="/portal/notifications" element={<RoleRoute><Notifications /></RoleRoute>} />
          {/* Backup sign-in codes. Admin-only, and the API refuses everyone else too. */}
          <Route
            path="/portal/security"
            element={
              <RoleRoute roles={["admin"]}>
                <Security />
              </RoleRoute>
            }
          />
          <Route
            path="/portal/approvals"
            element={
              <RoleRoute roles={["admin"]}>
                <Approvals />
              </RoleRoute>
            }
          />
          {/* The log is super-admin only. RoleRoute lets any admin through, so
              the page itself refuses the rest -- and so does the API. */}
          <Route
            path="/portal/audit"
            element={
              <RoleRoute roles={["admin"]}>
                <SuperAdminOnly>
                  <AuditLog />
                </SuperAdminOnly>
              </RoleRoute>
            }
          />

          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
      <Toaster position="top-right" />
    </>
  );
}

export default App;
