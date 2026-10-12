import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PerkList } from "@/components/plans/PerkList";
import { cn } from "@/lib/utils";
import { priceFor, usd, type Plan } from "@/lib/plans";

/**
 * One plan, priced for the period the client is looking at.
 *
 * Unlimited is the emphasised card and the first one on the page, on a phone
 * as well as a desk. The playbook is explicit about the order: $29, then $19,
 * then $9, and opening with the cheapest is on its list of things not to do.
 */

/** Shaped like the card, so the page does not jump when the prices land. */
export function PlanCardSkeleton({ featured = false }: { featured?: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl px-4 py-5 ring-1 sm:px-5",
        featured ? "bg-card ring-primary/30" : "bg-card ring-foreground/10",
      )}
    >
      <Skeleton className="h-4 w-24 rounded-md" />
      <Skeleton className="mt-3 h-8 w-32 rounded-lg" />
      <Skeleton className="mt-2 h-4 w-40 rounded-md" />
      <div className="mt-5 flex-1 space-y-2.5">
        <Skeleton className="h-4 w-full rounded-md" />
        <Skeleton className="h-4 w-11/12 rounded-md" />
        <Skeleton className="h-4 w-10/12 rounded-md" />
        <Skeleton className="h-4 w-9/12 rounded-md" />
      </div>
      <Skeleton className="mt-5 h-11 w-full rounded-xl" />
    </div>
  );
}

export function PlanCard({
  plan,
  months,
  featured = false,
  current = false,
  busy = false,
  onChoose,
}: {
  plan: Plan;
  months: number;
  featured?: boolean;
  /** The plan they are already on. The button says so rather than offering it. */
  current?: boolean;
  busy?: boolean;
  onChoose: (plan: Plan) => void;
}) {
  const price = priceFor(plan, months);
  const multiMonth = months > 1;

  return (
    <section
      className={cn(
        "flex flex-col px-4 py-5 ring-1 sm:px-5",
        // The radius varies with weight the way the rest of the app's surfaces
        // do, rather than every box carrying the same soft corner.
        featured ? "rounded-2xl bg-card ring-primary/40" : "rounded-xl bg-card ring-foreground/10",
      )}
    >
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="t-heading">{plan.name}</h3>
        {plan.badge && (
          <span
            className={cn(
              "t-micro rounded-md px-2 py-0.5 font-medium",
              featured ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground",
            )}
          >
            {plan.badge}
          </span>
        )}
      </div>

      <p className="mt-3 flex items-baseline gap-1.5">
        <span className="numeric-display t-display">{usd(plan.monthlyUsd)}</span>
        <span className="t-body text-muted-foreground">USD / month</span>
      </p>

      {/* The period total only appears when there is one. On Monthly the
          headline price IS the total, and repeating it reads as a second
          charge. */}
      {multiMonth && price && (
        <p className="mt-1.5 t-caption text-muted-foreground">
          <span className="numeric font-medium text-foreground">{usd(price.total)} USD</span>
          {" "}for {price.label}, which works out to{" "}
          <span className="numeric">{usd(price.perMonth)}</span> a month.
          {price.saving > 0 && (
            <> You save <span className="numeric">{usd(price.saving)}</span>.</>
          )}
        </p>
      )}

      <p className="mt-2 t-body text-muted-foreground">{plan.promise}</p>

      <PerkList perks={plan.entitlements} className="mt-4 flex-1" />

      <p className="mt-4 t-caption text-muted-foreground">{plan.bestFor}</p>

      <Button
        className="mt-4 h-11 w-full px-4"
        variant={featured ? "default" : "outline"}
        disabled={busy || current}
        onClick={() => onChoose(plan)}
      >
        {current ? `You are on ${plan.name}` : `Choose ${plan.name}`}
      </Button>
    </section>
  );
}
