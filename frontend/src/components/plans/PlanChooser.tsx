import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { PlanCard, PlanCardSkeleton } from "@/components/plans/PlanCard";
import { PeriodSwitcher } from "@/components/plans/PeriodSwitcher";
import { useChoosePlan, usePlanCatalogue } from "@/hooks/useMembership";
import { usd, type Membership, type Plan, type Quote } from "@/lib/plans";
import { ErrorState } from "@/components/ErrorState";

/**
 * The three plans, the period switcher, and what happens when one is chosen.
 *
 * Shared by the Plans page and the first-login modal so there is one of these
 * rather than two that drift. The caller decides what a successful choice
 * leads to -- the page shows the confirmation inline, the modal closes onto it.
 */
export function PlanChooser({
  membership,
  onChosen,
  compact = false,
}: {
  membership: Membership | null | undefined;
  onChosen?: (quote: Quote) => void;
  /** Tighter spacing, for the modal. */
  compact?: boolean;
}) {
  const { data: catalogue, isLoading, isError, error, refetch } = usePlanCatalogue();
  // Monthly, always. The discount closes a sale; it does not open one.
  const [months, setMonths] = useState(1);
  const choose = useChoosePlan();

  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;

  // Skeletons shaped like the three cards, not a spinner. A spinner tells
  // somebody to wait; these tell them what is about to arrive.
  if (isLoading || !catalogue) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-10 w-full rounded-xl bg-muted sm:w-80" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <PlanCardSkeleton featured />
          <PlanCardSkeleton />
          <PlanCardSkeleton />
        </div>
      </div>
    );
  }

  const onChoose = (plan: Plan) => {
    choose.mutate(
      { planKey: plan.key, period: months },
      {
        onSuccess: (result) => onChosen?.(result.quote),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "We could not record that choice"),
      },
    );
  };

  return (
    <div className={compact ? "flex flex-col gap-4" : "flex flex-col gap-5"}>
      <PeriodSwitcher
        periods={catalogue.periods}
        value={months}
        onChange={setMonths}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {catalogue.plans.map((plan) => (
          <PlanCard
            key={plan.key}
            plan={plan}
            months={months}
            featured={plan.key === "unlimited"}
            current={membership?.planKey === plan.key}
            busy={choose.isPending}
            onChoose={onChoose}
          />
        ))}
      </div>

      <p className="t-caption text-muted-foreground">
        Prices in USD. Multi-month plans are paid upfront. Cancel or change your plan any time from
        Billing.{" "}
        <Link to="/terms" className="text-link underline underline-offset-2">
          Terms of Service
        </Link>
        {" and "}
        <Link to="/privacy" className="text-link underline underline-offset-2">
          Privacy Policy
        </Link>
        .
      </p>
    </div>
  );
}

/**
 * What a client reads straight after choosing.
 *
 * Says exactly what happens next and what has not happened: nothing is charged
 * yet, and nothing unlocks until the money is confirmed. Being plain about
 * that is what stops the support email three days later asking why the
 * backups panel is still locked.
 */
export function PlanChosen({
  quote,
  email,
  firstName,
}: {
  quote: Quote;
  email: string;
  firstName: string;
}) {
  const months = quote.period;
  const periodLabel = months === 1 ? "monthly" : `${months} months`;

  return (
    <div className="rounded-2xl bg-card px-4 py-5 ring-1 ring-foreground/10 sm:px-5">
      <h2 className="t-title">Thanks, {firstName}.</h2>

      {quote.scheduled ? (
        <>
          <p className="mt-2 t-prose text-muted-foreground">
            You picked {quote.planName} ({periodLabel}). Your current plan runs until{" "}
            {quote.startsAt ? new Date(quote.startsAt).toLocaleDateString() : "the end of the period you paid for"},
            and {quote.planName} starts after that. There is nothing to pay now.
          </p>
        </>
      ) : (
        <>
          <p className="mt-2 t-prose text-muted-foreground">
            You picked {quote.planName} ({periodLabel}),{" "}
            <span className="numeric font-medium text-foreground">{usd(quote.amountUsd)} USD</span>.
            We will send payment details to {email} shortly. Your perks unlock as soon as payment is
            confirmed.
          </p>

          {quote.creditUsd > 0 && (
            <p className="mt-2 t-body text-muted-foreground">
              That is {usd(quote.listAmountUsd)} less{" "}
              <span className="numeric">{usd(quote.creditUsd)}</span> credited for the days left on{" "}
              {quote.from?.planName}.
            </p>
          )}
        </>
      )}

      <p className="mt-3 t-body text-muted-foreground">
        Nothing has been charged to you, and nothing about your site changes in the meantime.
      </p>
    </div>
  );
}
