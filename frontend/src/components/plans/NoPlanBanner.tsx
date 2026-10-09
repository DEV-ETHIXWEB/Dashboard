import { Link } from "react-router-dom";
import { useMembership, usePlanCatalogue } from "@/hooks/useMembership";
import { useAuth } from "@/context/AuthContext";
import { usd } from "@/lib/plans";

/**
 * A slim line at the top of the dashboard for a client without a plan.
 *
 * Non-blocking by design. Everything underneath it keeps working, and it is
 * one sentence and one link rather than a card demanding attention -- the
 * modal has already asked once, and this is the reminder that stays available
 * without being in the way. No dismiss control, because it answers itself the
 * moment they choose a plan.
 */
export function NoPlanBanner() {
  const { user } = useAuth();
  const { data: membership } = useMembership();
  const { data: catalogue } = usePlanCatalogue();

  if (user?.role !== "client" || !membership) return null;
  if (!membership.needsPlan) return null;
  // A cancelled plan that is still running is not a client who needs asking.
  // They have decided, the billing page says when it ends, and chasing them
  // on every screen until then is the behaviour nobody forgives.
  if (membership.endingAt) return null;

  const pending = membership.pendingSubscription;
  // Read off the catalogue, never typed. A "from $9" in this file would be the
  // second price list the whole design exists to avoid, and the one nobody
  // would remember to change.
  const cheapest = catalogue?.plans.reduce<number | null>(
    (low, plan) => (low == null || plan.monthlyUsd < low ? plan.monthlyUsd : low),
    null,
  );

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-xl bg-secondary/70 px-3.5 py-2.5 ring-1 ring-foreground/10 sm:flex-row sm:items-center sm:justify-between">
      {pending ? (
        <p className="t-body">
          You picked {pending.planName}. We are sending payment details to {user.email}, and your
          perks unlock once it is confirmed.
        </p>
      ) : (
        <p className="t-body">
          Choose a plan to keep your site hosted with us.
          {cheapest != null && (
            <> They start at <span className="numeric">{usd(cheapest)}</span> a month.</>
          )}
        </p>
      )}

      <Link
        to="/portal/billing/plans"
        className="focus-clear t-body shrink-0 font-medium text-link underline underline-offset-2"
      >
        {pending ? "Change your plan" : "View plans"}
      </Link>
    </div>
  );
}
