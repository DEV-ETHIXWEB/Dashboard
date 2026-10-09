import { Progress, ProgressLabel } from "@/components/ui/progress";
import { plainDate } from "@/lib/money";
import type { UpdateAllowance } from "@/lib/plans";

/**
 * This month's update allowance.
 *
 * Shows nothing at all on Unlimited: a meter that can never fill is a reminder
 * of a limit somebody has already paid to be rid of. Shows nothing on Basic
 * either, where the allowance is zero and the honest message is the upgrade
 * prompt on the ticket form, not an empty bar here.
 *
 * Chargeable extras are a separate sentence rather than a second bar, because
 * "2 of 2 used" and "1 extra, quoted separately" are different facts and
 * adding them together would tell the client they had used three of two.
 */
export function UsageMeter({ usage }: { usage: UpdateAllowance }) {
  if (usage.unlimited || usage.included == null || usage.included === 0) return null;

  const used = Math.min(usage.used, usage.included);
  const pct = Math.round((used / usage.included) * 100);
  const spent = usage.remaining === 0;

  return (
    <div className="rounded-xl bg-secondary/60 px-3 py-3">
      {/* The value is written out rather than handed to ProgressValue, which
          formats a percentage. "1 of 2 used" is the sentence a client reads;
          "50%" is the one a chart reads. */}
      <Progress value={pct} aria-label="Updates used this month">
        <ProgressLabel className="t-body font-medium">Updates this month</ProgressLabel>
        <span className="numeric ml-auto t-body text-muted-foreground">
          {usage.used} of {usage.included} used
        </span>
      </Progress>

      <p className="mt-2.5 t-caption text-muted-foreground">
        {spent
          ? usage.resetsAt
            ? `Your next ${usage.included} unlock on ${plainDate(usage.resetsAt)}.`
            : "Your allowance resets on your billing day each month."
          : usage.resetsAt
            ? `Resets ${plainDate(usage.resetsAt)}.`
            : "Resets on your billing day each month."}
        {usage.extraUsed > 0
          ? ` ${usage.extraUsed} extra ${usage.extraUsed === 1 ? "request" : "requests"} quoted separately this month.`
          : ""}
      </p>
    </div>
  );
}
