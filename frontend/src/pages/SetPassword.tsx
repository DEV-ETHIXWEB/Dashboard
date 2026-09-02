import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AlertTriangle, Check, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { BrandBackdrop } from "@/components/BrandBackdrop";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { localPasswordProblem } from "@/lib/password";
import { successFeedback } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/**
 * The page an activation or reset link opens.
 *
 * The token arrives in the URL **fragment**, not the query string. That is not
 * cosmetic: a fragment is never sent to a server, so the token stays out of
 * access logs, out of the `Referer` header on any onward navigation, and out of
 * whatever sits in front of this app in production. It also means a link
 * scanner that follows the URL cannot burn the single use before the person
 * gets there.
 *
 * A query-string token is still accepted, because a mail client that rewrites
 * links may have moved it -- but nothing this app sends ever puts it there.
 */
function readToken(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  const fromHash = new URLSearchParams(hash).get("token");
  if (fromHash) return fromHash;
  return new URLSearchParams(window.location.search).get("token");
}

interface TokenCheck {
  ok: true;
  purpose: "activation" | "reset";
  name: string;
  emailHint: string | null;
  expiresAt: number;
  policy: { minLength: number; maxAgeDays: number };
}

const FAILURE_COPY: Record<string, { title: string; body: string }> = {
  expired: {
    title: "That link has expired",
    body: "Links are short-lived on purpose. Ask for a new one and it will be in your inbox in a moment.",
  },
  used: {
    title: "That link has already been used",
    body: "Each link works exactly once. If you did not use it, ask an administrator — somebody else may have.",
  },
  invalid: {
    title: "That link is not valid",
    body: "It may have been cut short by your email app. Try copying the whole address, or ask for a new link.",
  },
};

export default function SetPassword() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const token = useMemo(readToken, []);

  const [check, setCheck] = useState<TokenCheck | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setFailure("invalid");
        setChecking(false);
        return;
      }
      try {
        const result = await api<TokenCheck>("POST", "/auth/password/verify", { token });
        if (!cancelled) setCheck(result);
      } catch (err) {
        if (cancelled) return;
        // The server answers with a coarse reason so that guessing at links
        // learns nothing; whatever it says, the person needs a new one.
        const reason = err instanceof ApiError ? err.payload.reason : null;
        setFailure(typeof reason === "string" ? reason : "invalid");
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const minLength = check?.policy.minLength ?? 12;
  const problem = localPasswordProblem(password, { minLength, name: check?.name });
  const mismatch = confirm.length > 0 && password !== confirm;
  const ready = Boolean(password && confirm) && !problem && !mismatch && !saving;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || !token) return;
    setSaving(true);
    try {
      await api<{ ok: boolean; message: string }>("POST", "/auth/password/reset", { token, password });
      successFeedback();
      setDone(true);
      // The token is spent; leaving it in the address bar means a refresh
      // shows a "already used" screen for no reason.
      window.history.replaceState(null, "", "/set-password");
      toast.success("Your password is set. Sign in with it now.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That password could not be set");
      // A refused link cannot be retried, so send them to the failure screen
      // rather than leaving them typing into a form that will never work.
      if (err instanceof ApiError && err.status === 400) setFailure("used");
    } finally {
      setSaving(false);
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
        {checking ? (
          <CardContent className="space-y-3 pt-6">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </CardContent>
        ) : done ? (
          <>
            <CardHeader>
              <div className="mb-1 flex size-10 items-center justify-center rounded-xl border border-success/20 bg-success/10 text-success">
                <Check className="size-5" />
              </div>
              <CardTitle className="text-lg">Your password is set</CardTitle>
              <CardDescription>
                Sign in with it now. Every other session on this account was signed out, which is what a password
                change is supposed to do.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button className="w-full" onClick={() => navigate("/login")}>
                Go to sign in
              </Button>
            </CardContent>
          </>
        ) : failure ? (
          <>
            <CardHeader>
              <div className="mb-1 flex size-10 items-center justify-center rounded-xl border border-destructive/20 bg-destructive/10 text-destructive">
                <AlertTriangle className="size-5" />
              </div>
              <CardTitle className="text-lg">{(FAILURE_COPY[failure] ?? FAILURE_COPY.invalid).title}</CardTitle>
              <CardDescription>{(FAILURE_COPY[failure] ?? FAILURE_COPY.invalid).body}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Button variant="outline" className="w-full" render={<Link to="/login" />}>
                Back to sign in
              </Button>
            </CardContent>
          </>
        ) : (
          <>
            <CardHeader>
              <div className="mb-1 flex size-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                <KeyRound className="size-5" />
              </div>
              <CardTitle className="text-lg">
                {check?.purpose === "activation" ? "Set up your password" : "Choose a new password"}
              </CardTitle>
              <CardDescription>
                {check?.name ? `${check.name} — ` : ""}
                {check?.emailHint ? `for ${check.emailHint}. ` : ""}
                Nobody here will ever see what you pick.
              </CardDescription>
            </CardHeader>

            <CardContent>
              <form onSubmit={submit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="set-password" className="text-xs font-medium">New password</Label>
                  <div className="relative">
                    <Input
                      id="set-password"
                      type={reveal ? "text" : "password"}
                      autoComplete="new-password"
                      autoFocus
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={`At least ${minLength} characters`}
                      aria-invalid={problem ? true : undefined}
                      aria-describedby="set-password-hint"
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setReveal((v) => !v)}
                      aria-label={reveal ? "Hide password" : "Show password"}
                      className="focus-clear absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:text-foreground"
                    >
                      {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                  <p
                    id="set-password-hint"
                    className={cn("text-xs", problem ? "text-destructive" : "text-muted-foreground")}
                  >
                    {problem ?? `At least ${minLength} characters.`}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="set-password-confirm" className="text-xs font-medium">Confirm password</Label>
                  <Input
                    id="set-password-confirm"
                    type={reveal ? "text" : "password"}
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Type it again"
                    aria-invalid={mismatch ? true : undefined}
                  />
                  {mismatch && <p className="text-xs text-destructive">Those two do not match.</p>}
                </div>

                <Button type="submit" className="w-full gap-1.5" disabled={!ready}>
                  {saving ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Setting it…
                    </>
                  ) : (
                    "Set password"
                  )}
                </Button>

                {user && (
                  <p className="text-xs text-muted-foreground">
                    You are currently signed in as {user.email}. Setting this password will sign you out
                    everywhere.
                  </p>
                )}
              </form>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
