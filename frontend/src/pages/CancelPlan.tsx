import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { useCancelPlan, useMembership, usePlanCatalogue } from "@/hooks/useMembership";
import { plainDate } from "@/lib/money";
import { usd } from "@/lib/plans";
import { cn } from "@/lib/utils";

/**
 * Leaving.
 *
 * One screen. The consequences, one optional question, one button. There is no
 * second confirmation, no survey and no "are you sure" after the "are you
 * sure" -- a cancellation that takes three screens to finish is a complaint
 * being drafted in somebody's head, and they leave anyway.
 *
 * Exactly one retention offer, the honest one: Basic at $9 keeps the site
 * hosted. It sits beside the cancel button rather than in front of it, so it
 * is an option rather than a toll gate.
 */

/** Optional, and genuinely optional. Nothing here changes what happens next. */
const REASONS = [
  "Too expensive",
  "Not using it enough",
  "Moving to another provider",
  "Closing or pausing the business",
  "Something was not working",
  "Something else",
];

export default function CancelPlan() {
  const navigate = useNavigate();
  const { data: membership, isLoading } = useMembership();
  const { data: catalogue } = usePlanCatalogue();
  const cancelPlan = useCancelPlan();
  const [reason, setReason] = useState("");

  if (isLoading || !membership) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <Skeleton className="h-8 w-56 rounded-lg" />
        <Skeleton className="mt-4 h-48 w-full rounded-2xl" />
      </div>
    );
  }

  const sub = membership.subscription;

  // Nothing running to stop. Says so plainly rather than showing a cancel
  // button that would fail.
  if (!membership.planKey || !sub) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <PageHeader
          title="Cancel your plan"
          description="There is no running plan on this account at the moment."
        />
        <Link to="/portal/billing" className={cn(buttonVariants(), "h-11 px-4 sm:h-10")}>
          Back to Billing
        </Link>
      </div>
    );
  }

  const endsOn = sub.renewsAt ? plainDate(sub.renewsAt) : "the end of your paid period";
  const basic = catalogue?.plans.find((p) => p.key === "basic");
  const alreadyOnBasic = membership.planKey === "basic";

  const confirm = () =>
    cancelPlan.mutate(
      { reason: reason || undefined },
      {
        onSuccess: () => {
          toast.success(`Cancelled. Your plan runs until ${endsOn}.`);
          navigate("/portal/billing");
        },
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "We could not cancel that"),
      },
    );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <PageHeader
        title="Cancel your plan"
        description={`You are on ${sub.planName}. Here is exactly what happens if you stop.`}
      />

      {/* The consequences, before the button. Stated once, plainly, with no
          threat in them -- the playbook is explicit that hosting is linked to
          a plan calmly and never as a warning. */}
      <section className="rounded-2xl bg-card px-4 py-4 ring-1 ring-foreground/10 sm:px-5 sm:py-5">
        <ul className="space-y-3">
          <Consequence>
            Your plan keeps running until <strong className="font-medium">{endsOn}</strong>. Nothing
            switches off before then, and you will not be charged again.
          </Consequence>
          <Consequence>
            After that date, your site needs an active plan to stay on our servers.
          </Consequence>
          <Consequence>
            If you would rather host elsewhere, we will prepare your website files so your new
            provider can deploy them. Setting it up on their side is handled by them.
          </Consequence>
          <Consequence>
            You can come back whenever you like. Starting again takes a minute.
          </Consequence>
        </ul>
      </section>

      {/* The one retention offer, and only one. Beside the exit, not in front
          of it. */}
      {!alreadyOnBasic && basic && (
        <section className="rounded-2xl bg-secondary/50 px-4 py-4 ring-1 ring-foreground/10 sm:px-5">
          <h2 className="t-heading">Keep the site live for {usd(basic.monthlyUsd)} a month</h2>
          <p className="mt-1 t-body text-muted-foreground">
            {basic.name} is hosting only, with no changes included. If the plan is more than you
            need right now, it keeps your site where it is.
          </p>
          <Link
            to="/portal/billing/plans?plan=basic"
            className={cn(buttonVariants({ variant: "outline" }), "mt-3 h-11 px-4 sm:h-10")}
          >
            Switch to {basic.name} instead
          </Link>
        </section>
      )}

      <section className="rounded-2xl bg-card px-4 py-4 ring-1 ring-foreground/10 sm:px-5 sm:py-5">
        <Label htmlFor="cancel-reason" className="t-body font-medium">
          Anything you would like to tell us? (optional)
        </Label>
        <p className="mt-1 t-caption text-muted-foreground">
          This does not change anything that happens next. It just helps us.
        </p>
        <Select value={reason} onValueChange={(v) => setReason(v ?? "")}>
          <SelectTrigger id="cancel-reason" className="mt-2 h-11 w-full sm:h-10">
            <SelectValue placeholder="Pick a reason, or leave it blank" />
          </SelectTrigger>
          <SelectContent>
            {REASONS.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          {/* The real action, and not hidden. Destructive styling says what it
              does without shouting; it is still the most reachable thing on
              the screen after the offer above. */}
          <Button
            variant="destructive"
            className="h-11 px-4 sm:h-10"
            disabled={cancelPlan.isPending}
            onClick={confirm}
          >
            {cancelPlan.isPending ? "Cancelling…" : `Cancel my ${sub.planName} plan`}
          </Button>
          <Link
            to="/portal/billing"
            className={cn(buttonVariants({ variant: "ghost" }), "h-11 px-4 sm:h-10")}
          >
            Keep my plan
          </Link>
        </div>
      </section>
    </div>
  );
}

function Consequence({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span aria-hidden className="mt-[0.5rem] size-[5px] shrink-0 rounded-[1px] bg-primary" />
      <span className="t-body flex-1">{children}</span>
    </li>
  );
}
