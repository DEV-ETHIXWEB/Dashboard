import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, Loader2, LogIn } from "lucide-react";
import { api, ApiError, setCsrfToken } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { BrandBackdrop } from "@/components/BrandBackdrop";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The page a one-tap sign-in link opens.
 *
 * It exists because the link used to sign people in on the GET, and a
 * single-use GET is spent by whoever fetches it first. In a corporate inbox
 * that is not the client: Outlook Safe Links and its equivalents follow every
 * URL in a message seconds after it arrives, to check it. By the time the
 * person tapped, the only honest thing the application could say was "already
 * used" -- which is useless to somebody holding the email that contains it.
 *
 * A scanner loads this page and stops. The button is what spends the link, and
 * a scanner does not press buttons.
 *
 * The token arrives in the fragment, which no browser sends to a server, so it
 * stays out of access logs and out of the `Referer` header on any onward
 * click. Same bargain as /set-password.
 */
function readToken(): string | null {
  if (typeof window === "undefined") return null;
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
  if (fromHash) return fromHash;
  return new URLSearchParams(window.location.search).get("token");
}

const FAILURE_COPY: Record<string, string> = {
  used: "This link has already been used. Ask for a new one and it will be in your inbox in a moment.",
  expired: "This link has expired. They are short-lived on purpose -- ask for a new one.",
  invalid: "This link is not one of ours, or part of it was lost on the way. Open it straight from the email.",
  access_expired: "Your access has expired. Your account manager can turn it back on.",
  two_factor:
    "This account uses two-step verification, so it signs in with a code rather than a link. Use the sign-in page.",
};

export default function SignInLink() {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const token = useRef(readToken());

  // The token is single-use and the address bar is the one place it can be
  // read back from. Cleared as soon as the page has it in memory.
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  async function signIn() {
    if (!token.current) {
      setProblem(FAILURE_COPY.invalid);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await api<{ csrfToken: string; redirect: string }>(
        "POST",
        "/auth/magic-link/consume",
        { token: token.current },
      );
      setCsrfToken(res.csrfToken);
      await refreshUser();
      navigate(res.redirect || "/portal", { replace: true });
    } catch (err) {
      const reason =
        err instanceof ApiError && typeof (err.payload as { linkError?: string })?.linkError === "string"
          ? (err.payload as { linkError: string }).linkError
          : "invalid";
      setProblem(FAILURE_COPY[reason] ?? FAILURE_COPY.invalid);
      setBusy(false);
    }
  }

  return (
    <div className="dark relative flex min-h-svh items-center justify-center overflow-hidden bg-background p-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-secondary/50 via-background to-background"
      />
      <BrandBackdrop />

      <Card className="relative z-10 w-full max-w-md shadow-2xl">
        <CardHeader className="items-center text-center">
          <div
            className={cn(
              "mb-2 flex size-11 items-center justify-center rounded-xl ring-1",
              problem
                ? "bg-destructive/10 text-destructive ring-destructive/20"
                : "bg-primary/10 text-primary ring-primary/20",
            )}
          >
            {problem ? <AlertTriangle className="size-5" /> : <LogIn className="size-5" />}
          </div>
          <CardTitle>{problem ? "That link did not work" : "Sign in to your dashboard"}</CardTitle>
          <CardDescription>
            {problem ?? "One tap and you are in. No password to remember."}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-2">
          {!problem && (
            <Button className="h-11 w-full gap-1.5" onClick={signIn} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
              {busy ? "Signing you in" : "Sign in"}
            </Button>
          )}
          <Link
            to="/login"
            className={cn(
              buttonVariants({ variant: problem ? "default" : "outline" }),
              "h-11 w-full",
            )}
          >
            {problem ? "Go to sign in" : "Use a password instead"}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
