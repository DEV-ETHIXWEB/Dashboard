import { Suspense, lazy, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { RoleRoute } from "@/components/RoleRoute";
import { GuestRoute } from "@/components/GuestRoute";
import { LogoBuildAnimation } from "@/components/LogoBuildAnimation";
import { BrandBackdrop } from "@/components/BrandBackdrop";
import { useAuth } from "@/context/AuthContext";
import { ROUTE_CHUNKS } from "@/lib/routeChunks";

const Login = lazy(ROUTE_CHUNKS.login);
const Dashboard = lazy(ROUTE_CHUNKS.dashboard);
const Projects = lazy(ROUTE_CHUNKS.projects);
const Tasks = lazy(ROUTE_CHUNKS.tasks);
const Tickets = lazy(ROUTE_CHUNKS.tickets);
const Domains = lazy(ROUTE_CHUNKS.domains);
const Reports = lazy(ROUTE_CHUNKS.reports);
const DocumentView = lazy(ROUTE_CHUNKS.documentView);
const Budget = lazy(ROUTE_CHUNKS.budget);
const Billing = lazy(ROUTE_CHUNKS.billing);
const Team = lazy(ROUTE_CHUNKS.team);
const ClientAccess = lazy(ROUTE_CHUNKS.clientAccess);
const OtpMonitor = lazy(ROUTE_CHUNKS.otpMonitor);
const AdminHome = lazy(ROUTE_CHUNKS.adminHome);
const ClickUpTasks = lazy(ROUTE_CHUNKS.clickup);
const WorkProgress = lazy(ROUTE_CHUNKS.progress);
const Messages = lazy(ROUTE_CHUNKS.messages);
const MailCenter = lazy(ROUTE_CHUNKS.mail);
const SlackMessages = lazy(ROUTE_CHUNKS.slack);
const Notifications = lazy(ROUTE_CHUNKS.notifications);
const Approvals = lazy(ROUTE_CHUNKS.approvals);
const AuditLog = lazy(ROUTE_CHUNKS.audit);
const Security = lazy(ROUTE_CHUNKS.security);

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

/** Set for the lifetime of a tab once the build has played there. */
const SPLASH_SEEN_KEY = "ew:splash-seen";

/**
 * Whether the wordmark build still owes this viewer a performance.
 *
 * It used to play on every full page load, which meant a refresh cost three
 * seconds of watching a logo assemble -- and a refresh is usually somebody in
 * a hurry, or somebody who thinks the page is stuck. Once per tab is the rule
 * now: sessionStorage survives a reload but not a new tab, so the brand still
 * opens a genuine visit and never stands between someone and their own data
 * twice.
 *
 * Read during the initialiser rather than in an effect, so the very first
 * render already knows. Storage can throw outright -- a locked-down browser,
 * a private window -- and the honest fallback there is to play it: a splash
 * shown once too often is a smaller failure than a blank first paint.
 */
function splashPending(): boolean {
  try {
    return window.sessionStorage.getItem(SPLASH_SEEN_KEY) === null;
  } catch {
    return true;
  }
}

function rememberSplashSeen() {
  try {
    window.sessionStorage.setItem(SPLASH_SEEN_KEY, "1");
  } catch {
    /* Nothing to do: the splash simply plays again next load. */
  }
}

/**
 * Plays once per tab -- state initialised from storage, so it is whatever
 * renders first, before the router or auth check have shown anything else.
 * Never revisited on a client-side route change, since that never re-mounts
 * App.
 */
function BootSplash() {
  const [booting, setBooting] = useState(splashPending);
  if (!booting) return null;
  return (
    // The same wash the Login page stands on, so the app does not open on a
    // flat fill and then cut to a designed screen.
    //
    // Pinned to `dark` rather than following the theme: the wordmark draws in
    // white, and this backdrop resolves to a pale gradient under a light
    // theme, which would leave the animation invisible for those viewers.
    <div className="dark fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-background">
      {/* The wash itself, on its own layer. It cannot go on the container:
          the gradient opens at secondary/50, so painting it directly would
          leave the splash half-transparent and show the app behind it. The
          opaque bg-background above is what makes this a screen, not a veil. */}
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-secondary/50 via-background to-background"
        style={{ zIndex: -40 }}
      />
      <BrandBackdrop />
      {/* Knocks the wash back. At full strength the blobs are Login's, where
          they carry a whole page; behind one wordmark they just shout. Sits
          above every backdrop layer and below the mark. */}
      <div className="pointer-events-none absolute inset-0 bg-black/55" style={{ zIndex: -5 }} />
      <LogoBuildAnimation
        onComplete={() => {
          rememberSplashSeen();
          setBooting(false);
        }}
      />
    </div>
  );
}

function App() {
  return (
    <>
      <BootSplash />
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
