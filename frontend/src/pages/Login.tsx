import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ShieldCheck, Loader2, Lock, Activity, Mail, Sun, Moon, Monitor, Check, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { LoginResponse } from "@/lib/types";
import * as fb2fa from "@/lib/firebase2fa";

const DEMO_ACCOUNTS = [
  { role: "Admin", pill: "bg-danger/10 text-danger", name: "Admin User", email: "admin@ethixweb.local", pw: "Admin#2026!" },
  { role: "Sales", pill: "bg-warning/10 text-warning", name: "Emily Turner", email: "emily.turner@ethixweb.local", pw: "Sales#2026!" },
  { role: "PM", pill: "bg-info/10 text-info", name: "Ryan Coleman", email: "ryan.coleman@ethixweb.local", pw: "Manager#2026!" },
  { role: "Employee", pill: "bg-success/10 text-success", name: "Jordan Brooks", email: "jordan.brooks@ethixweb.local", pw: "Staff#2026!" },
  { role: "Client", pill: "bg-muted text-muted-foreground", name: "BrightPath Retail Co.", email: "client@brightpath-retail.com", pw: "Client#2026!" },
] as const;

type Step = "credentials" | "otp";

/**
 * Why a sign-in link bounced, in words a client can act on. Links are issued by
 * an admin from the portal, so every message points back at them rather than
 * offering a self-service retry.
 */
const LINK_ERRORS: Record<string, string> = {
  used: "That sign-in link was already used. Ask us for a new one, or sign in with your password below.",
  expired: "That sign-in link expired. Ask us for a new one, or sign in with your password below.",
  invalid: "That sign-in link is not valid. Ask us for a new one, or sign in with your password below.",
  access_expired: "This access has expired. Ask your admin to issue you new credentials.",
};

export default function Login() {
  const navigate = useNavigate();
  const { config, setSession } = useAuth();
  const { theme, setTheme } = useTheme();

  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!themeMenuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (themeMenuRef.current && !themeMenuRef.current.contains(e.target as Node)) {
        setThemeMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [themeMenuOpen]);

  const [searchParams, setSearchParams] = useSearchParams();
  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expiredAccess, setExpiredAccess] = useState(false);
  const [busy, setBusy] = useState(false);

  const [otpError, setOtpError] = useState<string | null>(null);
  const [codeDestination, setCodeDestination] = useState<string | null>(null);
  const [otpBusy, setOtpBusy] = useState(false);
  const [code, setCode] = useState(["", "", "", "", "", ""]);
  const [otpExpiresAt, setOtpExpiresAt] = useState<number | null>(null);
  // A backup code is typed as one string, not six boxes, so the code step has
  // two shapes. Administrators fall back to this when email is not reaching
  // them -- see the Security page.
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [backupCode, setBackupCode] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const codeRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    const reason = searchParams.get("linkError");
    if (!reason) return;
    setError(LINK_ERRORS[reason] ?? LINK_ERRORS.invalid);
    searchParams.delete("linkError");
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (step !== "otp" || !otpExpiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [step, otpExpiresAt]);

  const secondsLeft = otpExpiresAt ? Math.max(0, Math.round((otpExpiresAt - now) / 1000)) : null;
  const otpExpired = secondsLeft === 0;

  const googleBtnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fb2fa.loadFirebase(config?.firebaseConfig ?? null).catch((err) => {
      console.warn("Firebase initialization failed:", err);
    });

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
  }, [config?.googleSignInEnabled, config?.googleClientId, config?.firebaseConfig]);

  async function handleGoogleSignIn() {
    setError(null);
    setBusy(true);
    try {
      const idToken = await fb2fa.signInWithGoogleFirebase(config?.firebaseConfig ?? null);
      const d = await api<LoginResponse>("POST", "/auth/google", { idToken });
      await handleLoginResponse(d);
    } catch (err) {
      if (config?.googleSignInEnabled) {
        const google = (window as any).google;
        if (google) {
          google.accounts.id.prompt();
        }
      } else {
        setError("Google sign-in requires Firebase or Google OAuth configuration in .env.");
      }
      setError(err instanceof Error ? err.message : "Google sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleLoginResponse(d: LoginResponse) {
    if (d.requiresOtp) {
      setCode(["", "", "", "", "", ""]);
      setOtpError(null);
      setCodeDestination(d.codeEmailed ? d.codeDestination ?? null : null);
      setOtpExpiresAt(d.otpExpiresAt ?? null);
      setNow(Date.now());
      setStep("otp");
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
    setExpiredAccess(false);
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
      setExpiredAccess(err instanceof ApiError && err.status === 403);
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

  async function submitOtp() {
    setOtpError(null);

    // Two shapes, one endpoint: six digits from an email, or a backup code an
    // admin has kept somewhere. The server decides which it was.
    const submitted = useBackupCode ? backupCode.trim() : code.join("");
    if (useBackupCode) {
      if (submitted.replace(/[^A-Za-z0-9]/g, "").length !== 10) {
        setOtpError("A backup code looks like XXXXX-XXXXX");
        return;
      }
    } else if (submitted.length !== 6) {
      setOtpError("Enter the full 6-digit code");
      return;
    }

    setOtpBusy(true);
    try {
      const d = await api<LoginResponse>("POST", "/auth/verify-otp", { code: submitted });
      if (d.user) setSession(d.user, d.csrfToken);
      if (d.usedRecoveryCode) {
        const left = d.recoveryCodesRemaining ?? 0;
        toast.warning(
          left === 0
            ? "That was your last backup code. Generate a new set on the Security page now."
            : `Backup code used. ${left} left — generate a new set from the Security page.`,
        );
      } else if (d.user?.role === "admin" && d.recoveryCodesRemaining === 0) {
        toast.warning("You have no backup codes. Without them, an email outage locks you out.");
      }
      navigate("/portal");
    } catch (err) {
      setOtpError(err instanceof ApiError ? err.message : "Verification failed");
      setCode(["", "", "", "", "", ""]);
      setBackupCode("");
      if (!useBackupCode) codeRefs.current[0]?.focus();
    } finally {
      setOtpBusy(false);
    }
  }

  // The control opens a light/dark/system picker, so it wears the mode it is
  // currently in rather than a generic glyph -- you can read the theme off the
  // button without opening it.
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const themeLabel = theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System";

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden bg-gradient-to-b from-secondary/50 via-background to-background px-0 py-0 text-foreground sm:px-6 sm:py-10 lg:px-10">
      <div ref={themeMenuRef} className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-50">
        {themeMenuOpen && (
          <div className="absolute bottom-12 right-0 w-44 rounded-xl border border-border/80 bg-card/95 p-2 shadow-2xl backdrop-blur-md animate-in fade-in-0 zoom-in-95 duration-150 z-50">
            <div className="px-2 py-1 t-label text-muted-foreground tracking-wider flex items-center gap-1.5">
              <ThemeIcon className="size-3.5 text-primary shrink-0" />
              <span>Theme options</span>
            </div>
            <div className="my-1.5 h-[1px] bg-border/60" />
            <div className="flex flex-col gap-0.5">
              <button
                type="button"
                onClick={() => {
                  setTheme("light");
                  setThemeMenuOpen(false);
                }}
                className={cn(
                  "w-full flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer",
                  theme === "light"
                    ? "bg-primary/10 text-primary font-semibold"
                    : "text-foreground hover:bg-secondary"
                )}
              >
                <div className="flex items-center gap-2">
                  <Sun className="size-3.5 shrink-0" />
                  <span>Light</span>
                </div>
                {theme === "light" && <Check className="size-3.5 text-primary" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  setTheme("dark");
                  setThemeMenuOpen(false);
                }}
                className={cn(
                  "w-full flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer",
                  theme === "dark"
                    ? "bg-primary/10 text-primary font-semibold"
                    : "text-foreground hover:bg-secondary"
                )}
              >
                <div className="flex items-center gap-2">
                  <Moon className="size-3.5 shrink-0" />
                  <span>Dark</span>
                </div>
                {theme === "dark" && <Check className="size-3.5 text-primary" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  setTheme("system");
                  setThemeMenuOpen(false);
                }}
                className={cn(
                  "w-full flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer",
                  theme === "system"
                    ? "bg-primary/10 text-primary font-semibold"
                    : "text-foreground hover:bg-secondary"
                )}
              >
                <div className="flex items-center gap-2">
                  <Monitor className="size-3.5 shrink-0" />
                  <span>Auto</span>
                </div>
                {theme === "system" && <Check className="size-3.5 text-primary" />}
              </button>
            </div>
          </div>
        )}

        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label={`Theme: ${themeLabel}. Change theme`}
          title={`Theme: ${themeLabel}`}
          onClick={() => setThemeMenuOpen((prev) => !prev)}
          className="size-10 sm:size-11 rounded-full border-border/80 bg-card/90 text-primary shadow-xl backdrop-blur-md hover:bg-card hover:scale-105 active:scale-95 transition-all cursor-pointer ring-1 ring-primary/20"
        >
          <ThemeIcon className="size-5" />
        </Button>
      </div>

      <div className="pointer-events-none absolute inset-0 -z-30 bg-[radial-gradient(circle_at_15%_20%,hsl(var(--primary)/0.16),transparent_45%),radial-gradient(circle_at_85%_15%,rgba(59,130,246,0.14),transparent_45%),radial-gradient(circle_at_50%_100%,rgba(168,85,247,0.12),transparent_50%)]" />
      <div className="absolute inset-0 -z-20 opacity-[0.07] pointer-events-none bg-[linear-gradient(to_right,hsl(var(--foreground)/0.09)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--foreground)/0.09)_1px,transparent_1px)] bg-[size:36px_36px] [mask-image:radial-gradient(ellipse_75%_65%_at_50%_40%,black,transparent)]" />

      <div className="absolute -top-28 -left-20 w-[480px] h-[480px] bg-primary/25 rounded-full blur-[140px] pointer-events-none -z-10 animate-[pulse_10s_ease-in-out_infinite]" />
      <div className="absolute top-12 -right-16 w-[440px] h-[440px] bg-rose-600/20 rounded-full blur-[130px] pointer-events-none -z-10 animate-[pulse_12s_ease-in-out_infinite]" />
      <div className="absolute bottom-8 left-[10%] w-[380px] h-[380px] bg-purple-600/15 rounded-full blur-[120px] pointer-events-none -z-10" />
      <div className="absolute -bottom-32 -right-12 w-[540px] h-[540px] bg-blue-600/15 rounded-full blur-[160px] pointer-events-none -z-10 animate-[pulse_8s_ease-in-out_infinite]" />

      <div
        className="pointer-events-none absolute -top-16 -right-16 w-[580px] h-[580px] bg-contain bg-no-repeat opacity-[0.08] dark:opacity-[0.12] -z-20 rotate-12"
        style={{ backgroundImage: "url('/spiderweb.svg')" }}
      />
      <div
        className="pointer-events-none absolute -bottom-24 -left-24 w-[640px] h-[640px] bg-contain bg-no-repeat opacity-[0.08] dark:opacity-[0.11] -z-20 -rotate-45"
        style={{ backgroundImage: "url('/spiderweb.svg')" }}
      />
      <div
        className="pointer-events-none absolute top-1/4 -left-32 w-[480px] h-[480px] bg-contain bg-no-repeat opacity-[0.06] dark:opacity-[0.09] -z-20 rotate-90"
        style={{ backgroundImage: "url('/spiderweb.svg')" }}
      />
      <div
        className="pointer-events-none absolute bottom-1/4 -right-28 w-[450px] h-[450px] bg-contain bg-no-repeat opacity-[0.06] dark:opacity-[0.09] -z-20 -rotate-15"
        style={{ backgroundImage: "url('/spiderweb.svg')" }}
      />

      {/* Outlined wordmarks at 12vw are wallpaper on a desktop and clutter on a
          phone, where every pixel is competing with the form. */}
      <div className="pointer-events-none absolute inset-0 -z-20 hidden select-none overflow-hidden sm:block">
        <div
          className="absolute top-2 left-3 sm:top-4 sm:left-6 text-[12vw] sm:text-[9.5vw] lg:text-[8vw] font-semibold uppercase tracking-tighter leading-none"
          style={{
            WebkitTextFillColor: "transparent",
            WebkitTextStroke: "2.5px hsl(var(--primary) / 0.45)",
            filter: "drop-shadow(0 0 20px hsl(var(--primary) / 0.2))",
          }}
        >
          POWERING CLIENT
        </div>
        <div
          className="absolute bottom-2 right-3 sm:bottom-4 sm:right-6 text-[12vw] sm:text-[9.5vw] lg:text-[8vw] font-semibold uppercase tracking-tighter leading-none text-right"
          style={{
            WebkitTextFillColor: "transparent",
            WebkitTextStroke: "2.5px hsl(var(--foreground) / 0.25)",
            filter: "drop-shadow(0 0 20px hsl(var(--foreground) / 0.1))",
          }}
        >
          COLLABORATION
        </div>
      </div>

      <div className="w-full max-w-4xl lg:max-w-[980px]">
        <Card className="overflow-hidden rounded-none border-0 bg-card p-0 py-0 text-card-foreground backdrop-blur-md sm:rounded-xl sm:border sm:border-border/70 sm:shadow-2xl sm:shadow-primary/10">
          <CardContent className="p-0">
            {/* No fixed minimum on a phone: the panel beside it is hidden
                there, so the card should be exactly as tall as the form. */}
            <div className="grid md:min-h-[560px] md:grid-cols-12">
              {/* A phone lands on the form, not on the pitch. This panel is the
                  half of the split that has to go: 500px of marketing pushed
                  the email field below the fold on every handset. Its brand and
                  its two trust lines reappear around the form below. */}
              <div className="relative hidden overflow-hidden border-r border-white/10 bg-zinc-950 p-6 text-white md:col-span-5 md:flex md:flex-col md:justify-between lg:p-10">
                <div
                  className="absolute inset-0 bg-cover bg-center opacity-[0.22] pointer-events-none"
                  style={{ backgroundImage: "url('/spiderweb.svg')" }}
                />
                <div className="absolute -top-12 -left-12 w-44 h-44 bg-primary/35 rounded-full blur-[70px] pointer-events-none" />
                <div className="absolute -bottom-16 -right-10 w-56 h-56 bg-blue-500/15 rounded-full blur-[90px] pointer-events-none" />
                <div className="absolute inset-0 bg-gradient-to-b from-primary/15 via-transparent to-black/95" />
                <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:28px_28px] opacity-40 pointer-events-none" />

                <div className="relative z-10 flex items-center gap-3">
                  <img src="/emblem-mark.png" alt="EthixWeb Emblem" className="h-9 w-auto object-contain -ml-1" />
                  <div>
                    <div className="t-label text-sm">EthixWeb</div>
                    <div className="t-label text-zinc-400">CRM &amp; Operations</div>
                  </div>
                </div>

                <div className="relative z-10 my-auto py-6">
                  <h2 className="text-2xl leading-[1.15] font-semibold tracking-[-0.025em] text-white sm:text-3xl lg:text-4xl">
                    Powering client collaboration.
                  </h2>
                  <p className="mt-3 text-xs sm:text-sm text-zinc-400 leading-relaxed max-w-xs">
                    Track your projects, tickets, and spend in real time with our unified operations environment.
                  </p>

                  <div className="mt-6 flex flex-col gap-2.5">
                    <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                      <Lock className="size-3.5 text-primary shrink-0" />
                      Every login is verified with a second step
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                      <Activity className="size-3.5 text-primary shrink-0" />
                      Real-time project & ticket visibility
                    </div>
                  </div>
                </div>

                <div className="relative z-10 text-xs text-zinc-500">
                  &copy; {new Date().getFullYear()} EthixWeb Solutions. All rights reserved.
                </div>
              </div>

              <div className="relative flex flex-col justify-center overflow-hidden bg-card px-5 py-8 sm:p-8 md:col-span-7 lg:p-12">
                <div
                  className="absolute inset-0 bg-cover bg-center opacity-[0.03] pointer-events-none"
                  style={{ backgroundImage: "url('/spiderweb.svg')" }}
                />
                {step === "credentials" ? (
                  <div className="z-10 mx-auto flex w-full max-w-[390px] flex-col gap-5">
                    {/* The brand, at the size a phone can spare for it. */}
                    <div className="flex items-center gap-2.5 md:hidden">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950 p-1.5 ring-1 ring-primary/20">
                        <img src="/emblem-mark.png" alt="" className="size-full object-contain" />
                      </span>
                      <span className="min-w-0">
                        <span className="block t-label text-sm">
                          EthixWeb
                        </span>
                        <span className="block t-label text-muted-foreground">
                          Client portal
                        </span>
                      </span>
                    </div>

                    <div>
                      <h1 className="t-title text-foreground">Welcome back</h1>
                      <p className="mt-1 max-w-[290px] text-sm leading-relaxed text-muted-foreground sm:text-xs">
                        Sign in to manage projects, tasks, and client tickets.
                      </p>
                    </div>

                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={handleGoogleSignIn}
                        className="w-full h-10 py-2 px-4 flex items-center justify-center gap-2.5 border-border bg-background hover:bg-secondary/70 cursor-pointer transition-all shadow-sm text-sm font-medium text-foreground"
                      >
                        {busy ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
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
                        )}
                        Sign in with Google
                      </Button>

                      {config?.googleSignInEnabled && <div ref={googleBtnRef} className="hidden" />}
                    </div>

                    <div className="flex items-center gap-3 text-xs uppercase tracking-wider font-semibold text-muted-foreground/60">
                      <div className="h-[1px] flex-1 bg-gradient-to-r from-transparent to-border/70" />
                      or sign in with email
                      <div className="h-[1px] flex-1 bg-gradient-to-l from-transparent to-border/70" />
                    </div>

                    <form onSubmit={doLogin} className="flex flex-col gap-3.5">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="email" className="t-label tracking-wider text-muted-foreground">Email</Label>
                        <div className="relative">
                          <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground/70 pointer-events-none" />
                          <Input
                            id="email"
                            type="email"
                            placeholder="you@company.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            autoComplete="username"
                            className="h-10 pl-10 pr-3.5 bg-background border-input hover:border-primary/50 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 transition-all text-sm text-foreground placeholder:text-muted-foreground/50"
                          />
                        </div>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="password" className="t-label tracking-wider text-muted-foreground">Password</Label>
                        <div className="relative">
                          <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground/70 pointer-events-none" />
                          <Input
                            id="password"
                            type="password"
                            placeholder="••••••••"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete="current-password"
                            className="h-10 pl-10 pr-3.5 bg-background border-input hover:border-primary/50 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 transition-all text-sm text-foreground placeholder:text-muted-foreground/50"
                          />
                        </div>
                      </div>

                      {error && (
                        <div
                          className={cn(
                            "rounded-md border px-3.5 py-2.5 text-xs font-medium",
                            expiredAccess
                              ? "bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400"
                              : "bg-destructive/10 border-destructive/20 text-destructive",
                          )}
                        >
                          {expiredAccess && (
                            <span className="mb-1 flex items-center gap-1.5 font-semibold">
                              <Clock className="size-3.5 shrink-0" />
                              Access expired
                            </span>
                          )}
                          {error}
                        </div>
                      )}

                      <Button
                        type="submit"
                        disabled={busy}
                        className="mt-1 h-12 cursor-pointer py-2 text-sm font-semibold shadow-md shadow-primary/20 transition-all sm:h-10"
                      >
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        Sign in
                      </Button>
                    </form>

                    {/* The reassurance the side panel used to carry, kept where
                        a phone can still see it without scrolling past a pitch. */}
                    <div className="flex flex-col gap-2 border-t border-border/60 pt-4 md:hidden">
                      <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Lock aria-hidden className="size-3.5 shrink-0 text-primary" />
                        Every login is verified with a second step
                      </span>
                      <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Activity aria-hidden className="size-3.5 shrink-0 text-primary" />
                        Real-time project &amp; ticket visibility
                      </span>
                    </div>

                    {import.meta.env.DEV && (
                      <div className="mt-3 border-t border-border/60 pt-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <span className="t-label text-muted-foreground tracking-wider">
                          Autofill Demo (dev only)
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {DEMO_ACCOUNTS.map((acct) => (
                            <button
                              key={acct.email}
                              type="button"
                              onClick={() => fillDemo(acct)}
                              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-0.5 text-[10px] font-semibold text-muted-foreground shadow-sm transition-all duration-150 hover:border-primary/50 hover:bg-secondary hover:text-foreground coarse:min-h-9 coarse:px-3.5 coarse:text-[11px]"
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
                  <div className="mx-auto w-full max-w-[390px] flex flex-col gap-5 z-10">
                    <div className="flex items-center gap-2.5 text-primary">
                      <ShieldCheck className="size-6" />
                      <h1 className="text-xl sm:t-title text-foreground">Verify it's you</h1>
                    </div>
                    <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
                      {useBackupCode
                        ? "Enter one of the backup codes you saved. Each one works once, and works even if the emailed code has expired."
                        : codeDestination
                          ? `We sent a 6-digit code to ${codeDestination}. Enter it below.`
                          : "We could not email your code. If you saved backup codes, use one below. Otherwise ask your admin for the code generated for this sign-in."}
                    </p>

                    {useBackupCode ? (
                      <div className="my-1 flex flex-col gap-2">
                        <Label htmlFor="backup-code">Backup code</Label>
                        <Input
                          id="backup-code"
                          autoFocus
                          autoComplete="one-time-code"
                          spellCheck={false}
                          placeholder="XXXXX-XXXXX"
                          maxLength={11}
                          className="h-12 text-center font-mono text-lg tracking-[0.25em] uppercase bg-background text-foreground border-input hover:border-primary/50 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 transition-all"
                          value={backupCode}
                          onChange={(e) => setBackupCode(e.target.value.toUpperCase())}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !otpBusy) submitOtp();
                          }}
                        />
                      </div>
                    ) : (
                    <div className="flex justify-between gap-2 my-1">
                      {code.map((digit, i) => (
                        <Input
                          key={i}
                          ref={(el) => {
                            codeRefs.current[i] = el;
                          }}
                          aria-label={`Digit ${i + 1} of 6`}
                          maxLength={1}
                          inputMode="numeric"
                          disabled={otpExpired}
                          className="h-12 w-11 text-center text-lg font-bold bg-background text-foreground border-input hover:border-primary/50 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 transition-all disabled:opacity-50"
                          value={digit}
                          onChange={(e) => {
                            const v = e.target.value.replace(/\D/g, "").slice(-1);
                            const next = [...code];
                            next[i] = v;
                            setCode(next);
                            if (v && codeRefs.current[i + 1]) codeRefs.current[i + 1]?.focus();
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Backspace" && !code[i] && i > 0) {
                              codeRefs.current[i - 1]?.focus();
                            }
                          }}
                          onPaste={(e) => {
                            const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
                            if (!pasted) return;
                            e.preventDefault();
                            const next = ["", "", "", "", "", ""];
                            for (let j = 0; j < pasted.length; j++) next[j] = pasted[j];
                            setCode(next);
                            const lastIndex = Math.min(pasted.length, 6) - 1;
                            codeRefs.current[Math.max(lastIndex, 0)]?.focus();
                          }}
                        />
                      ))}
                    </div>
                    )}

                    {!useBackupCode && secondsLeft !== null && (
                      <p className={`text-xs ${otpExpired ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                        {otpExpired
                          ? "This code has expired. Go back and sign in again for a new one."
                          : `Code expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`}
                      </p>
                    )}

                    {otpError && (
                      <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3.5 py-2.5 text-xs text-destructive font-medium">
                        {otpError}
                      </div>
                    )}

                    <Button
                      type="button"
                      disabled={otpBusy || (otpExpired && !useBackupCode)}
                      onClick={submitOtp}
                      className="h-10 shadow-md shadow-primary/20 hover:shadow-lg hover:shadow-primary/30 transition-all text-sm font-semibold cursor-pointer"
                    >
                      {otpBusy && <Loader2 className="size-4 animate-spin" />}
                      Confirm code
                    </Button>

                    {/* The way back in when email is not working. Administrators
                        hold eight one-time codes for exactly this; a backup code
                        works even after the emailed one has expired. */}
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground cursor-pointer"
                      onClick={() => {
                        setUseBackupCode((v) => !v);
                        setOtpError(null);
                        setBackupCode("");
                        setCode(["", "", "", "", "", ""]);
                      }}
                    >
                      {useBackupCode
                        ? "Enter the emailed code instead"
                        : "Can't get the email? Use a backup code"}
                    </button>

                    <Button
                      type="button"
                      variant="ghost"
                      className="mt-1 w-full text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer"
                      onClick={() => {
                        setStep("credentials");
                        setOtpError(null);
                        setCode(["", "", "", "", "", ""]);
                        setBackupCode("");
                        setUseBackupCode(false);
                        setOtpExpiresAt(null);
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
