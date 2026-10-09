import { Link } from "react-router-dom";
import { Button, buttonVariants } from "@/components/ui/button";
import { toast } from "sonner";
import { useRequestHandover } from "@/hooks/useMembership";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { PerkList } from "@/components/plans/PerkList";
import { UsageMeter } from "@/components/plans/UsageMeter";
import { plainDate } from "@/lib/money";
import { usd, type Membership } from "@/lib/plans";

/**
 * What plan this client is on, in the order they would ask it: which plan,
 * what it costs, when it renews, whether anything needs doing, what it covers,
 * and how to change it.
 *
 * Deliberately one card rather than a row of tiles. A client opens this screen
 * with one question, and the answer should be readable in the time it takes to
 * glance at a phone.
 */

/** Shaped like the card it replaces, so the page does not jump when it loads. */
export function PlanStatusCardSkeleton() {
  return (
    <section className="rounded-2xl bg-card px-4 py-4 ring-1 ring-foreground/10 sm:px-5 sm:py-5">
      <Skeleton className="h-4 w-20 rounded-md" />
      <Skeleton className="mt-2 h-7 w-44 rounded-lg" />
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
      </div>
      <Skeleton className="mt-4 h-4 w-28 rounded-md" />
      <div className="mt-3 space-y-2">
        <Skeleton className="h-4 w-full rounded-md" />
        <Skeleton className="h-4 w-11/12 rounded-md" />
        <Skeleton className="h-4 w-4/5 rounded-md" />
      </div>
      <Skeleton className="mt-4 h-11 w-full rounded-xl sm:h-10 sm:w-40" />
    </section>
  );
}

/** One of the three facts under the plan name. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-secondary/60 px-3 py-2">
      <dt className="t-label text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 t-body font-medium">{value}</dd>
    </div>
  );
}

/**
 * The one line that says where this account stands.
 *
 * Written for somebody who is busy and may be worried. Each one says what is
 * true, then what it means for them, and never implies a consequence that is
 * not actually coming.
 */
function standing(membership: Membership): { headline: string; detail: string } {
  const sub = membership.subscription;

  if (membership.awaitingPayment && sub) {
    return {
      headline: "We are waiting on your payment",
      detail: `You picked ${sub.planName} (${sub.periodLabel}), ${usd(sub.amountUsd)} USD. Your perks unlock as soon as we confirm the payment. Nothing has been charged to you yet.`,
    };
  }

  if (membership.pastDue) {
    return {
      headline: "We could not take your last payment",
      detail:
        "Your plan is still running and nothing has been switched off. Updating your card takes about a minute.",
    };
  }

  if (membership.endingAt) {
    return {
      headline: `Your plan ends ${plainDate(membership.endingAt)}`,
      detail:
        "Everything keeps working until then. After that your site needs an active plan to stay on our servers, and we will prepare your website files if you would rather move.",
    };
  }

  if (membership.planKey) {
    return {
      headline: "Everything is up to date",
      detail: "Your plan is active and your site is covered.",
    };
  }

  if (membership.grandfathered) {
    return {
      headline: "You have not picked a plan yet",
      detail:
        "Your site is still live and nothing has been switched off. Hosting with us runs on a plan now, so choosing one is what keeps it that way.",
    };
  }

  return {
    headline: "You do not have an active plan",
    detail: "Nothing is being charged to you.",
  };
}

export function PlanStatusCard({ membership }: { membership: Membership }) {
  const sub = membership.subscription;
  const plan = membership.plan;
  const state = standing(membership);

  // The perks to list are the ones they actually have. A grandfathered client
  // has no plan to list, so the card talks about choosing one instead of
  // reading them a list of things they have not bought.
  const perks = plan?.entitlements ?? [];

  return (
    <section className="rounded-2xl bg-card px-4 py-4 ring-1 ring-foreground/10 sm:px-5 sm:py-5">
      <p className="t-body font-medium text-muted-foreground">Your plan</p>

      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="t-title">{plan ? plan.name : sub?.planName ?? "No plan yet"}</h2>
        {plan && (
          <span className="t-body text-muted-foreground">
            {usd(plan.monthlyUsd)} USD / month
          </span>
        )}
      </div>

      {plan && <p className="mt-1 t-body text-muted-foreground">{plan.promise}</p>}

      <p className="mt-3 t-heading">{state.headline}</p>
      <p className="mt-1 t-body text-muted-foreground">{state.detail}</p>

      {sub && (
        <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Fact label="Amount" value={`${usd(sub.amountUsd)} USD`} />
          <Fact label="Billing period" value={sub.periodLabel} />
          <Fact
            label={membership.endingAt ? "Ends" : "Renews"}
            value={sub.renewsAt ? plainDate(sub.renewsAt) : "Not set yet"}
          />
        </dl>
      )}

      {/* A credit is the one number on this card a client did not choose, so
          it is spelled out rather than folded into the amount above. */}
      {sub?.creditUsd != null && sub.creditUsd > 0 && (
        <p className="mt-2 t-caption text-muted-foreground">
          {usd(sub.listAmountUsd)} less {usd(sub.creditUsd)} credited from your previous plan.
        </p>
      )}

      <UsageMeterSlot membership={membership} />

      {perks.length > 0 && (
        <>
          <p className="mt-4 t-label text-muted-foreground">What it covers</p>
          <PerkList perks={perks} className="mt-2" />
        </>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        {/* A Link styled as a button, not a Button rendering a Link: base-ui's
            Button expects a native <button>, and handing it an anchor strips
            the button semantics it is about to announce to a screen reader.
            buttonVariants is the house pattern for exactly this. */}
        <Link
          to="/portal/billing/plans"
          className={cn(buttonVariants(), "h-11 px-4 sm:h-10")}
        >
          {membership.planKey ? "Change plan" : "Choose your plan"}
        </Link>

        {/* As easy to find as the upgrade, which is the whole point. A
            cancellation that takes three screens to reach is a complaint
            waiting to happen, and it is also the thing the law is moving
            towards requiring. */}
        {membership.planKey && !membership.endingAt && (
          <Link
            to="/portal/billing/cancel"
            className={cn(buttonVariants({ variant: "outline" }), "h-11 px-4 sm:h-10")}
          >
            Cancel plan
          </Link>
        )}
      </div>

      {/* Once they have cancelled, the one thing still owed to them. Offered
          here rather than left to an email thread, and with the terms stated
          again so nobody has to remember what was said: we prepare the files,
          we do not move the site. */}
      {membership.endingAt && <Handover membership={membership} />}
    </section>
  );
}

/**
 * The website files, for a client whose plan is ending.
 *
 * The terms are on the button's own panel rather than in a confirmation step,
 * because they are the whole point: we prepare the files so another provider
 * can deploy them, and we do not do the moving. Saying that once, here, is
 * fairer than saying it after they have asked.
 */
function Handover({ membership }: { membership: Membership }) {
  const request = useRequestHandover();
  const asked = membership.subscription?.handoverRequestedAt;

  return (
    <div className="mt-4 rounded-xl bg-secondary/60 px-3.5 py-3 ring-1 ring-foreground/10">
      <p className="t-body font-medium">Taking your site elsewhere?</p>
      <p className="mt-1 t-body text-muted-foreground">
        We will prepare your website files so your new provider can deploy them. Setting it up on
        their side is handled by them.
      </p>

      {asked ? (
        <p className="mt-2.5 t-caption text-muted-foreground">
          Asked for on {plainDate(asked)}. We will be in touch with your files.
        </p>
      ) : (
        <Button
          variant="outline"
          className="mt-3 h-11 px-4 sm:h-10"
          disabled={request.isPending}
          onClick={() =>
            request.mutate(undefined, {
              onSuccess: () => toast.success("Asked for. We will be in touch with your files."),
              onError: (err) =>
                toast.error(err instanceof Error ? err.message : "Could not record that"),
            })
          }
        >
          {request.isPending ? "Asking…" : "Prepare my website files"}
        </Button>
      )}
    </div>
  );
}

/** Keeps the meter's own "show nothing" rule out of the card's layout. */
function UsageMeterSlot({ membership }: { membership: Membership }) {
  const meter = <UsageMeter usage={membership.usage} />;
  if (!meter || membership.usage.unlimited || !membership.usage.included) return null;
  return <div className="mt-3">{meter}</div>;
}
