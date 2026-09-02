import { AlertTriangle, Clock, ShieldCheck, ShieldOff } from "lucide-react";
import type { PasswordState, PasswordStatus } from "@/lib/types";
import { describePassword, passwordLabel, PASSWORD_TONE } from "@/lib/password";
import { cn } from "@/lib/utils";

const ICONS: Record<PasswordState, typeof ShieldCheck> = {
  active: ShieldCheck,
  reset_completed: ShieldCheck,
  expiring_soon: Clock,
  reset_required: AlertTriangle,
  no_password: ShieldOff,
};

/**
 * Where an account stands on the password policy, as one pill.
 *
 * Deliberately the same shape as the role and standing badges already on the
 * Team page -- a bordered pill with a small glyph -- so a row that gains this
 * reads as one line of badges rather than a new kind of thing bolted on.
 *
 * The full sentence lives in the `title`, which is where the existing pills put
 * their explanations too.
 */
export function PasswordStatusBadge({
  status,
  className,
  showIcon = true,
}: {
  status: PasswordStatus | null | undefined;
  className?: string;
  showIcon?: boolean;
}) {
  if (!status) return null;
  // Nothing to report about an account that has no password and never will;
  // saying "No password" on every Google-only row is noise, not information.
  if (status.state === "no_password") return null;
  // A workspace that has switched rotation off does not want a badge on every
  // person telling it so.
  if (!status.policyEnabled && status.state === "active") return null;

  const Icon = ICONS[status.state];

  return (
    <span
      title={describePassword(status)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold",
        PASSWORD_TONE[status.state],
        className,
      )}
    >
      {showIcon && <Icon aria-hidden className="size-3" />}
      {passwordLabel(status)}
    </span>
  );
}
