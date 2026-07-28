import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type { LoginResponse } from "@/lib/types";
import * as fb2fa from "@/lib/firebase2fa";

const DEMO_ACCOUNTS = [
  { role: "Admin", pill: "bg-danger/10 text-danger", name: "Admin User", email: "admin@ethixweb.local", pw: "Admin#2026!" },
  { role: "Sales", pill: "bg-warning/10 text-warning", name: "Emily Turner", email: "emily.turner@ethixweb.local", pw: "Sales#2026!" },
  { role: "PM", pill: "bg-info/10 text-info", name: "Ryan Coleman", email: "ryan.coleman@ethixweb.local", pw: "Manager#2026!" },
  { role: "Employee", pill: "bg-success/10 text-success", name: "Jordan Brooks", email: "jordan.brooks@ethixweb.local", pw: "Staff#2026!" },
  { role: "Client", pill: "bg-muted text-muted-foreground", name: "BrightPath Retail Co.", email: "client@brightpath-retail.com", pw: "Client#2026!" },
] as const;

type Step = "credentials" | "2fa";

export default function Login() {
  const navigate = useNavigate();
  const { config, setSession } = useAuth();

  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [twoFactorContact, setTwoFactorContact] = useState("");
  const [isEmailContact, setIsEmailContact] = useState(false);
  const [twofaError, setTwofaError] = useState<string | null>(null);
  const [emailLinkSent, setEmailLinkSent] = useState(false);
  const [code, setCode] = useState(["", "", "", "", "", ""]);
  const codeRefs = useRef<(HTMLInputElement | null)[]>([]);

  const googleBtnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!config?.googleSignInEnabled || !config.googleClientId) return;
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      const google = (window as any).google;
      google.accounts.id.initialize({ client_id: config.googleClientId, callback: handleGoogleCredential });
      if (googleBtnRef.current) {
        google.accounts.id.renderButton(googleBtnRef.current, { theme: "outline", size: "large", width: 360 });
      }
    };
    document.head.appendChild(script);
  }, [config?.googleSignInEnabled]);

  async function handleLoginResponse(d: LoginResponse) {
    if (d.requires2FA) {
      setTwoFactorContact(d.twoFactorContact || "");
      setIsEmailContact((d.twoFactorContact || "").includes("@"));
      setStep("2fa");
      return;
    }
    if (d.user) setSession(d.user, d.csrfToken);
    navigate(d.redirect === "/portal.html" || !d.redirect ? "/portal" : d.redirect);
  }

  async function handleGoogleCredential(response: { credential: string }) {
    setError(null);
    try {
      const d = await api<LoginResponse>("POST", "/auth/google", { idToken: response.credential });
      await handleLoginResponse(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed");
    }
  }

  async function doLogin(e?: React.FormEvent, override?: { email: string; password: string }) {
    e?.preventDefault();
    setError(null);
    const creds = override ?? { email, password };
    if (!creds.email || !creds.password) {
      setError("Please enter email and password.");
      return;
    }
    setBusy(true);
    try {
      const d = await api<LoginResponse>("POST", "/auth/login", creds);
      await handleLoginResponse(d);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Cannot connect to the server. Is it running?");
    } finally {
      setBusy(false);
    }
  }

  function fillDemo(acct: (typeof DEMO_ACCOUNTS)[number]) {
    setEmail(acct.email);
    setPassword(acct.pw);
    doLogin(undefined, { email: acct.email, password: acct.pw });
  }

  async function sendPhoneCode() {
    setTwofaError(null);
    const phone = window.prompt("Enter the phone number on file for this account (e.g. +14155550148):");
    if (!phone || !config?.firebaseConfig) return;
    try {
      await fb2fa.loadFirebase(config.firebaseConfig);
      await fb2fa.sendPhoneCode(phone, "recaptcha-container");
    } catch (err) {
      setTwofaError(err instanceof Error ? err.message : "Could not send code");
    }
  }

  async function confirmPhoneCode() {
    setTwofaError(null);
    const joined = code.join("");
    if (joined.length !== 6) {
      setTwofaError("Enter the full 6-digit code");
      return;
    }
    try {
      const firebaseIdToken = await fb2fa.confirmPhoneCode(joined);
      const d = await api<LoginResponse>("POST", "/auth/verify-2fa", { firebaseIdToken });
      if (d.user) setSession(d.user, d.csrfToken);
      navigate("/portal");
    } catch (err) {
      setTwofaError(err instanceof Error ? err.message : "Verification failed");
    }
  }

  async function sendEmailLink() {
    setTwofaError(null);
    if (!config?.firebaseConfig) return;
    try {
      await fb2fa.loadFirebase(config.firebaseConfig);
      await fb2fa.sendEmailSignInLink(email);
      setEmailLinkSent(true);
    } catch (err) {
      setTwofaError(err instanceof Error ? err.message : "Could not send link");
    }
  }

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden bg-gradient-to-b from-secondary/40 to-background px-4 py-8">
      <div className="absolute inset-0 -z-30 opacity-[0.035] pointer-events-none bg-[linear-gradient(to_right,rgba(220,38,38,0.1)_1px,transparent_1px),linear-gradient(to_bottom,rgba(220,38,38,0.1)_1px,transparent_1px)] bg-[size:32px_32px]" />

      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[80px] bg-primary/25 rounded-full blur-[100px] pointer-events-none -z-10" />

      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,theme(colors.primary/16%),transparent_65%)]" />
      <div
        className="pointer-events-none absolute inset-0 -z-20 bg-cover bg-center opacity-[0.03]"
        style={{ backgroundImage: "url('/spiderweb.svg')" }}
      />

      <div className="w-full max-w-4xl">
        <Card className="overflow-hidden border-primary/20 shadow-xl shadow-primary/5 p-0 py-0">
          <CardContent className="p-0">
            <div className="grid md:grid-cols-12 min-h-[580px]">
              <div className="relative md:col-span-5 flex flex-col justify-between bg-zinc-950 p-8 text-white overflow-hidden border-r border-border/10">
                <div
                  className="absolute inset-0 bg-cover bg-center opacity-[0.25] pointer-events-none"
                  style={{ backgroundImage: "url('/spiderweb.svg')" }}
                />
                <div className="absolute -top-12 -left-12 w-40 h-40 bg-primary/20 rounded-full blur-[50px] pointer-events-none" />
                <div className="absolute inset-0 bg-gradient-to-b from-primary/10 via-transparent to-black/85" />

                <div className="relative z-10 flex items-center gap-3">
                  <img src="/emblem-mark.png" alt="EthixWeb Emblem" className="h-9 w-auto object-contain -ml-2" />
                  <div>
                    <div className="text-sm font-bold leading-tight tracking-wide uppercase">EthixWeb</div>
                    <div className="text-[10px] text-zinc-400 tracking-wider uppercase font-semibold">CRM &amp; Operations</div>
                  </div>
                </div>

                <div className="relative z-10 my-auto py-8">
                  <h2 className="text-2xl font-bold tracking-tight text-white md:text-3xl leading-tight">
                    Powering client collaboration.
                  </h2>
                  <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
                    Track your projects, tickets, and spend in real time with our unified operations environment.
                  </p>
                </div>

                <div className="relative z-10 text-[10px] text-zinc-500">
                  &copy; {new Date().getFullYear()} EthixWeb Solutions. All rights reserved.
                </div>
              </div>

              <div className="relative md:col-span-7 flex flex-col justify-center p-6 sm:p-8 md:p-10 bg-card overflow-hidden">
                <div
                  className="absolute inset-0 bg-cover bg-center opacity-[0.03] pointer-events-none"
                  style={{ backgroundImage: "url('/spiderweb.svg')" }}
                />
                {step === "credentials" ? (
                  <div className="mx-auto w-full max-w-[420px] flex flex-col gap-5 z-10">
                    <div>
                      <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Welcome back</h1>
                      <p className="mt-1 text-xs text-muted-foreground/60 leading-relaxed max-w-[280px]">
                        Sign in to manage projects, tasks, and client tickets.
                      </p>
                    </div>

                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        disabled
                        className="w-full flex items-center justify-center gap-2.5 cursor-not-allowed opacity-60 border-border bg-background hover:bg-background"
                      >
                        <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24">
                          <path
                            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                            fill="#4285F4"
                          />
                          <path
                            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                            fill="#34A853"
                          />
                          <path
                            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                            fill="#FBBC05"
                          />
                          <path
                            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                            fill="#EA4335"
                          />
                        </svg>
                        Sign in with Google
                      </Button>

                      {config?.googleSignInEnabled && <div ref={googleBtnRef} className="hidden" />}
                    </div>

                    <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground/50">
                      <div className="h-[1px] flex-1 bg-gradient-to-r from-transparent to-border/60" />
                      or sign in with email
                      <div className="h-[1px] flex-1 bg-gradient-to-l from-transparent to-border/60" />
                    </div>

                    <form onSubmit={doLogin} className="flex flex-col gap-3.5">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="email">Email</Label>
                        <Input
                          id="email"
                          type="email"
                          placeholder="you@company.com"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          autoComplete="username"
                          className="hover:border-primary/45 focus-visible:border-primary/60 focus-visible:ring-primary/25 transition-colors"
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="password">Password</Label>
                        <Input
                          id="password"
                          type="password"
                          placeholder="••••••••"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          autoComplete="current-password"
                          className="hover:border-primary/45 focus-visible:border-primary/60 focus-visible:ring-primary/25 transition-colors"
                        />
                      </div>

                      {error && (
                        <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                          {error}
                        </div>
                      )}

                      <Button type="submit" disabled={busy} className="mt-1 shadow-md shadow-primary/10">
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        Sign in
                      </Button>
                    </form>

                    {import.meta.env.DEV && (
                      <div className="mt-5 border-t border-border/50 pt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <span className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-wider">
                          Autofill Demo (dev only)
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {DEMO_ACCOUNTS.map((acct) => (
                            <button
                              key={acct.email}
                              type="button"
                              onClick={() => fillDemo(acct)}
                              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition-all duration-150 hover:bg-secondary hover:text-foreground hover:border-primary/45 shadow-sm cursor-pointer"
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${
                                acct.role === "Admin" ? "bg-red-500" :
                                acct.role === "Sales" ? "bg-amber-500" :
                                acct.role === "PM" ? "bg-sky-500" :
                                acct.role === "Employee" ? "bg-emerald-500" :
                                "bg-zinc-400"
                              }`} />
                              {acct.role}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                  </div>
                ) : (
                  <div className="flex flex-col gap-5">
                    <div className="flex items-center gap-2 text-primary">
                      <ShieldCheck className="size-5" />
                      <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Verify it's you</h1>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      We'll verify it's you via <span className="font-semibold text-foreground">{twoFactorContact}</span>.
                    </p>

                    {!isEmailContact ? (
                      <div className="flex flex-col gap-4">
                        <div id="recaptcha-container" />
                        <Button type="button" variant="outline" onClick={sendPhoneCode}>
                          Send SMS code
                        </Button>
                        <div className="flex justify-between gap-2">
                          {code.map((digit, i) => (
                            <Input
                              key={i}
                              ref={(el) => {
                                codeRefs.current[i] = el;
                              }}
                              maxLength={1}
                              inputMode="numeric"
                              className="h-12 w-11 text-center text-lg"
                              value={digit}
                              onChange={(e) => {
                                const v = e.target.value.replace(/\D/g, "");
                                const next = [...code];
                                next[i] = v;
                                setCode(next);
                                if (v && codeRefs.current[i + 1]) codeRefs.current[i + 1]?.focus();
                              }}
                            />
                          ))}
                        </div>
                        <Button type="button" onClick={confirmPhoneCode} className="shadow-md shadow-primary/10">
                          Confirm code
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-4">
                        {!emailLinkSent ? (
                          <Button type="button" onClick={sendEmailLink} className="shadow-md shadow-primary/10">
                            Email me a verification link
                          </Button>
                        ) : (
                          <p className="text-sm text-muted-foreground bg-secondary/40 p-3 rounded-lg border border-border">
                            Check your inbox and click the link. It'll bring you right back here signed in.
                          </p>
                        )}
                      </div>
                    )}

                    {twofaError && (
                      <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {twofaError}
                      </div>
                    )}

                    <Button
                      type="button"
                      variant="ghost"
                      className="mt-2 w-full"
                      onClick={() => {
                        setStep("credentials");
                        setTwofaError(null);
                      }}
                    >
                      Back to sign in
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
