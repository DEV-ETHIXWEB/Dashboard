import { useState } from "react";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { MoneyPanel, BentoGrid, bento } from "@/components/money/Money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { User } from "@/lib/types";

export default function Settings() {
  const { user, setSession } = useAuth();

  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");

  const updateProfile = useMutation({
    mutationFn: () =>
      api<{ user: User }>("PUT", "/users/me", {
        name,
        email,
        password: password || undefined,
        // Only sent when actually changing the password; the server insists on it.
        currentPassword: password ? currentPassword : undefined,
      }),
    onSuccess: (d) => {
      setSession(d.user, "");
      toast.success("Profile updated");
      setPassword("");
      setCurrentPassword("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to update profile"),
  });

  const disable2fa = useMutation({
    mutationFn: () => api<{ user: User }>("POST", "/users/me/2fa/disable"),
    onSuccess: (d) => {
      setSession(d.user, "");
      toast.success("Two-factor authentication disabled");
    },
  });

  return (
    <BentoGrid className="mx-auto w-full max-w-6xl">
      <div className={bento(4)}>
        <PageHeader title="Settings" description="Your details, security, and how the app looks." />
      </div>

      <MoneyPanel className={bento(4)} title="Your details" subtitle="Used for signing in and for anything we send you">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" className="h-10" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              className="h-10"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              className="h-10"
              placeholder="Leave blank to keep your current password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              className="h-10"
              placeholder={password ? "Required to change your password" : "Only needed for a password change"}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={!password}
            />
          </div>
        </div>
        <div className="mt-4">
          <Button
            onClick={() => updateProfile.mutate()}
            disabled={updateProfile.isPending || (Boolean(password) && !currentPassword)}
            className="h-10 px-4"
          >
            {updateProfile.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </MoneyPanel>

      <MoneyPanel className={bento(2)} title="Security" subtitle="Extra protection for your account">
        <div className="flex items-center justify-between gap-3 rounded-lg bg-row px-3 py-2.5 ring-1 ring-row-border ring-inset">
          <div className="flex min-w-0 items-center gap-2.5">
            {user?.twoFactorEnabled ? (
              <ShieldCheck aria-hidden className="size-5 shrink-0 text-money-in" />
            ) : (
              <ShieldOff aria-hidden className="size-5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <p className="text-base font-medium">Two-step sign in</p>
              <p className="truncate text-sm text-muted-foreground">
                {user?.twoFactorEnabled ? `Codes sent to ${user.twoFactorContact}` : "Not switched on"}
              </p>
            </div>
          </div>
          {user?.twoFactorEnabled && (
            <Button
              variant="secondary"
              className="h-9 shrink-0 px-3 text-sm"
              onClick={() => disable2fa.mutate()}
              disabled={disable2fa.isPending}
            >
              Turn off
            </Button>
          )}
        </div>
      </MoneyPanel>

      <MoneyPanel className={bento(2)} title="Appearance" subtitle="“Auto” follows your device setting">
        <ThemeSwitch />
      </MoneyPanel>
    </BentoGrid>
  );
}
