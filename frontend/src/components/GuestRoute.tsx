import { useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { hadSessionHint } from "@/lib/sessionHint";
import { Loader2 } from "lucide-react";

/**
 * The login screen, and the decision about whether the person looking at it is
 * already signed in.
 *
 * This used to hold everything behind a spinner until `/auth/me` answered,
 * which is the right shape for a route that has to know who you are and
 * exactly the wrong shape for the one route that does not. The login form is
 * the same form whether or not you have a session; the answer only decides
 * whether you get bounced to the portal instead. So waiting for it before
 * drawing anything meant a cold API -- fifteen-odd seconds on a serverless
 * boot -- was fifteen seconds of spinner in front of a form that had been
 * ready the whole time.
 *
 * `hadSessionHint()` splits the two cases apart. A browser that has never
 * signed in here cannot be holding a session, so it gets the form immediately
 * and the answer changes nothing when it lands. A browser that has signed in
 * before is probably about to be redirected, and showing it the form first
 * would be a flash of the wrong screen, so that one still waits.
 *
 * Read once, at mount: the hint is cleared the moment a 401 comes back, and
 * re-reading it would swap a waiting screen for a login form a frame before
 * the router was going to render the login form anyway.
 */
export function GuestRoute({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const [mayBeSignedIn] = useState(hadSessionHint);

  if (isLoading && mayBeSignedIn) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (user) {
    return <Navigate to="/portal" replace />;
  }

  return <>{children}</>;
}
