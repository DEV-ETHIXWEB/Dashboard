import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/PageHeader";
import { PlanChooser, PlanChosen } from "@/components/plans/PlanChooser";
import { useMembership } from "@/hooks/useMembership";
import { useAuth } from "@/context/AuthContext";
import { usd, type Quote } from "@/lib/plans";

/**
 * The plans, on their own page.
 *
 * Reachable from the Plan item in the navigation, the banner, the billing
 * page and the first-login modal, so a client who closed the modal can always
 * find their way back without being chased.
 */
export default function Plans() {
  const { user } = useAuth();
  const { data: membership } = useMembership();
  const [chosen, setChosen] = useState<Quote | null>(null);

  const firstName = (user?.name || "").split(" ")[0] || "there";
  const pending = membership?.pendingSubscription;

  if (chosen) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        <PlanChosen quote={chosen} email={user?.email ?? "your email"} firstName={firstName} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link to="/portal" className={cn(buttonVariants(), "h-11 px-4 sm:h-10")}>
            Take me to my dashboard
          </Link>
          <Button
            variant="outline"
            className="h-11 px-4 sm:h-10"
            onClick={() => setChosen(null)}
          >
            Look at the plans again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <PageHeader
        title="Choose your plan"
        description="Every plan keeps your site live on our servers. The difference is how much we take off your plate."
      />

      {/* Somebody who already chose and is waiting on payment details should
          be told that, not shown three buttons as though nothing happened. */}
      {pending && (
        <div className="rounded-xl bg-secondary/60 px-4 py-3 ring-1 ring-foreground/10">
          <p className="t-body font-medium">
            You picked {pending.planName} ({pending.periodLabel}),{" "}
            <span className="numeric">{usd(pending.amountUsd)} USD</span>.
          </p>
          <p className="mt-1 t-body text-muted-foreground">
            We are sending payment details to {user?.email}. Picking a different plan below replaces
            that choice. Nothing has been charged to you.
          </p>
        </div>
      )}

      <PlanChooser membership={membership} onChosen={setChosen} />
    </div>
  );
}
