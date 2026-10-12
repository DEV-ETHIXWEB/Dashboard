import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A page for an address that is not one of ours.
 *
 * Unknown routes used to redirect to /login, which is wrong in both
 * directions: somebody already signed in is shown a sign-in form, which reads
 * as having been logged out, and somebody following a stale link never finds
 * out that the link was the problem.
 *
 * Where "back" goes depends on whether there is a session, because that is the
 * only honest answer to "where should this person be instead".
 */
export default function NotFound() {
  const { user } = useAuth();

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-5 bg-secondary/30 p-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
        <Compass className="size-6" />
      </div>

      <div className="max-w-md space-y-2">
        <p className="t-label text-muted-foreground">404</p>
        <h1 className="t-title">We cannot find that page</h1>
        <p className="t-body text-muted-foreground">
          The link may be out of date, or the page may have moved. Nothing is wrong with
          your account.
        </p>
      </div>

      <Link
        to={user ? "/portal" : "/login"}
        className={cn(buttonVariants(), "h-11 px-5")}
      >
        {user ? "Back to your dashboard" : "Go to sign in"}
      </Link>
    </div>
  );
}
