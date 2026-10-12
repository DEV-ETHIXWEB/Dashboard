import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Check, Loader2, Mail } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { BrandBackdrop } from "@/components/BrandBackdrop";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The page the "confirm your new email address" link opens.
 *
 * The token arrives in the URL fragment for the same reason it does on
 * /set-password: a fragment is never sent to a server, so it stays out of
 * access logs, out of the `Referer` header on any onward click, and out of
 * whatever sits in front of this app in production.
 *
 * Deliberately outside every guard. Somebody confirming a new address is as
 * likely to be reading the email on a phone that has never signed in, and the
 * address they would have to sign in with is the one that is about to change.
 */
function readToken(): string | null {
  if (typeof window === "undefined") return null;
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
  if (fromHash) return fromHash;
  return new URLSearchParams(window.location.search).get("token");
}

export default function ConfirmEmail() {
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [email, setEmail] = useState<string | null>(null);
  const [problem, setProblem] = useState<string>("");

  // React runs effects twice in development. Confirming is a one-shot action
  // against a single-use token, so the second run would always report the
  // link as already used.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const token = readToken();
    if (!token) {
      setState("failed");
      setProblem("That link is missing its token. Open it straight from the email rather than copying part of it.");
      return;
    }

    api<{ ok: true; email: string }>("POST", "/users/me/email/confirm", { token })
      .then((res) => {
        setEmail(res.email);
        setState("done");
        // The token is single-use and the address has moved; leaving it in the
        // address bar only risks it being shared from the history.
        window.history.replaceState(null, "", window.location.pathname);
      })
      .catch((err) => {
        setState("failed");
        setProblem(
          err instanceof ApiError
            ? err.message
            : "That link could not be checked. Try again in a moment.",
        );
      });
  }, []);

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
              state === "done" && "bg-success-surface text-success ring-success-border",
              state === "failed" && "bg-destructive/10 text-destructive ring-destructive/20",
              state === "working" && "bg-primary/10 text-primary ring-primary/20",
            )}
          >
            {state === "working" && <Loader2 className="size-5 animate-spin" />}
            {state === "done" && <Check className="size-5" />}
            {state === "failed" && <AlertTriangle className="size-5" />}
          </div>
          <CardTitle>
            {state === "working" && "Confirming your address"}
            {state === "done" && "Your email address is confirmed"}
            {state === "failed" && "That link did not work"}
          </CardTitle>
          <CardDescription>
            {state === "working" && "One moment."}
            {state === "done" && (
              <>
                Your account now signs in with{" "}
                <span className="font-medium text-foreground">{email}</span>. Every other
                signed-in session was ended, so sign in again with the new address.
              </>
            )}
            {state === "failed" && problem}
          </CardDescription>
        </CardHeader>

        {state !== "working" && (
          <CardContent className="flex flex-col gap-2">
            <Link to="/login" className={cn(buttonVariants(), "h-11 w-full")}>
              <Mail className="size-4" />
              {state === "done" ? "Sign in with your new address" : "Back to sign in"}
            </Link>
            {state === "failed" && (
              <p className="t-caption text-center text-muted-foreground">
                Links expire after an hour. Ask for the change again from your profile, or tell
                an administrator.
              </p>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
