import { LegalPage, Points, Section } from "@/components/plans/LegalPage";
import { usePlanCatalogue } from "@/hooks/useMembership";
import { usd } from "@/lib/plans";

/**
 * The Terms of Service.
 *
 * Written to describe what the product actually does rather than to sound
 * like a contract: every paragraph here matches a behaviour somewhere in the
 * code, and where it does not, the code is the thing that is wrong.
 *
 * Every price and period is read from the plan catalogue rather than typed,
 * for the same reason as everywhere else -- a terms page quoting a price the
 * product no longer charges is worse than one with no prices in it.
 */
export default function Terms() {
  const { data: catalogue } = usePlanCatalogue();
  const plans = catalogue?.plans ?? [];
  const multiMonth = (catalogue?.periods ?? []).filter((p) => p.months > 1);

  return (
    <LegalPage title="Terms of Service" updated="8 October 2026">
      <Section title="Who we are">
        <p>
          Ethixweb provides website hosting, maintenance and related services to businesses. These
          terms cover the client dashboard at ethixwebdashboard.com and the plans you can buy
          through it.
        </p>
      </Section>

      <Section title="Plans">
        <p>
          Hosting with us runs on a plan. Each plan includes a different amount of work from us,
          and what each one includes is listed in your dashboard and on the plans page.
        </p>
        {plans.length > 0 && (
          <Points
            items={plans.map((plan) => (
              <>
                <strong className="font-medium text-foreground">
                  {plan.name}, {usd(plan.monthlyUsd)} USD per month.
                </strong>{" "}
                {plan.promise}{" "}
                {plan.updateRequestsPerMonth === null
                  ? "Update requests are not capped."
                  : plan.updateRequestsPerMonth === 0
                    ? "Changes to your site are not included."
                    : `Includes ${plan.updateRequestsPerMonth} update requests a month.`}
              </>
            ))}
          />
        )}
        <p>
          On a plan with a monthly allowance of update requests, work beyond that allowance is
          quoted per job and charged separately. We tell you the price before any of that work
          starts. You can also hold a request until your allowance resets, at no cost.
        </p>
        <p>
          An outage or a billing question is never counted against an allowance and is never
          refused, whatever plan you are on.
        </p>
      </Section>

      <Section title="Prices and payment">
        <Points
          items={[
            <>
              All prices are in <strong className="font-medium text-foreground">US dollars</strong>.
              We do not bill in any other currency. If your bank holds another currency, it converts
              on your side.
            </>,
            <>
              Plans can be paid monthly or for a longer period.{" "}
              {multiMonth.length > 0 && (
                <>
                  Longer periods are discounted:{" "}
                  {multiMonth.map((p) => `${p.label} ${p.discountLabel}`).join(", ")}.
                </>
              )}
            </>,
            <>
              A multi-month period is{" "}
              <strong className="font-medium text-foreground">paid upfront</strong>, in full, for
              the whole period.
            </>,
            <>
              We show you the amount and the renewal date before you pay, and again on your Billing
              page afterwards.
            </>,
          ]}
        />
      </Section>

      <Section title="Renewals">
        <p>
          A plan continues until you stop it. We send a reminder seven days before a multi-month
          plan is due to renew, with the amount and the date.
        </p>
        <p>
          You can change your plan or stop it at any time before a renewal, from your Billing page.
        </p>
      </Section>

      <Section title="Changing your plan">
        <Points
          items={[
            <>
              <strong className="font-medium text-foreground">Moving up a plan</strong> takes effect
              when we confirm your payment. The unused part of the plan you are leaving is credited
              against the new one, worked out by day.
            </>,
            <>
              <strong className="font-medium text-foreground">Moving down a plan</strong> takes
              effect when your current period ends. There is nothing to pay at the time you ask, and
              we do not refund the period you have already paid for.
            </>,
          ]}
        />
      </Section>

      <Section title="Cancelling">
        <p>
          You can cancel from your Billing page. It takes one screen and no phone call.
        </p>
        <Points
          items={[
            "Your plan keeps running until the end of the period you have already paid for. Nothing is switched off before then and you are not charged again.",
            "After that date, your site needs an active plan to stay on our servers.",
            <>
              If you would rather host elsewhere, we will{" "}
              <strong className="font-medium text-foreground">prepare your website files</strong> so
              another provider can deploy them. Setting the site up on their side is handled by them;
              we do not migrate it for you.
            </>,
            "You can start a plan again at any time.",
          ]}
        />
      </Section>

      <Section title="What we expect from you">
        <Points
          items={[
            "That the content on your site is yours to publish and does not break the law.",
            "That you keep your sign-in details to yourself, and tell us if you think somebody else has them.",
            "That the person who buys a plan is authorised to buy it for the business.",
          ]}
        />
      </Section>

      <Section title="What we do not promise">
        <p>
          We work hard to keep sites online and we monitor them where your plan includes it, but no
          host can promise a site will never be unavailable. Where your plan includes a guaranteed
          first response time on requests, that is a response time, not a time by which the work is
          finished.
        </p>
      </Section>

      <Section title="Changes to these terms">
        <p>
          If we change these terms in a way that affects what you pay or what you get, we will tell
          you by email before the change applies to you.
        </p>
      </Section>
    </LegalPage>
  );
}
