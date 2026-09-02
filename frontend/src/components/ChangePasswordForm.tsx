import { useState } from "react";
import { toast } from "sonner";
import { Check, Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/context/AuthContext";
import { useChangePassword } from "@/hooks/useProfile";
import { localPasswordProblem } from "@/lib/password";
import { successFeedback } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/**
 * Changing your own password.
 *
 * Shared between the profile page and the screen somebody is held on when
 * theirs has expired, because they are the same form with different framing --
 * and a second copy would be a second place for the rules to drift out of step
 * with utils/passwordPolicy.js.
 *
 * The current password is asked for even on the expired path. It is the only
 * thing standing between a session somebody left open on a shared machine and
 * a permanent takeover of the account.
 */
export function ChangePasswordForm({
  onDone,
  submitLabel = "Change password",
  className,
}: {
  onDone?: () => void;
  submitLabel?: string;
  className?: string;
}) {
  const { user, config } = useAuth();
  const changePassword = useChangePassword();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);

  const minLength = config?.passwordPolicy?.minLength ?? user?.passwordStatus?.minLength ?? 12;

  // Reported as they type, but only once there is something to report on --
  // telling somebody their empty field is too short is noise.
  const problem = localPasswordProblem(next, {
    minLength,
    email: user?.email,
    name: user?.name,
  });
  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = Boolean(current && next && confirm) && !problem && !mismatch;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    try {
      await changePassword.mutateAsync({ currentPassword: current, password: next });
      successFeedback();
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password changed. Every other device has been signed out.");
      onDone?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That password could not be changed");
    }
  }

  return (
    <form onSubmit={submit} className={cn("space-y-4", className)}>
      <div className="space-y-1.5">
        <Label htmlFor="current-password" className="text-xs font-medium">
          Current password
        </Label>
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="••••••••"
          className="bg-background/50"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="new-password" className="text-xs font-medium">
          New password
        </Label>
        <div className="relative">
          <Input
            id="new-password"
            type={reveal ? "text" : "password"}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder={`At least ${minLength} characters`}
            aria-invalid={problem ? true : undefined}
            aria-describedby="new-password-hint"
            className="bg-background/50 pr-10"
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
          id="new-password-hint"
          className={cn("text-xs", problem ? "text-destructive" : "text-muted-foreground")}
        >
          {problem ?? `At least ${minLength} characters, and not your own name or address.`}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm-password" className="text-xs font-medium">
          Confirm new password
        </Label>
        <div className="relative">
          <Input
            id="confirm-password"
            type={reveal ? "text" : "password"}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Type it again"
            aria-invalid={mismatch ? true : undefined}
            className="bg-background/50 pr-9"
          />
          {confirm.length > 0 && !mismatch && (
            <Check aria-hidden className="absolute top-1/2 right-3 size-4 -translate-y-1/2 text-success" />
          )}
        </div>
        {mismatch && <p className="text-xs text-destructive">Those two do not match.</p>}
      </div>

      <Button type="submit" disabled={!ready || changePassword.isPending} className="w-full gap-1.5 sm:w-auto">
        {changePassword.isPending ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Saving…
          </>
        ) : (
          submitLabel
        )}
      </Button>

      <p className="text-xs text-muted-foreground">
        Changing it signs you out of every other browser and phone. This one stays signed in.
      </p>
    </form>
  );
}
