import { LegalPage, Points, Section } from "@/components/plans/LegalPage";

/**
 * The Privacy Policy.
 *
 * Says what the dashboard actually records, in the words somebody would use to
 * describe it. The section on upgrade prompts exists because we do record when
 * we asked somebody to upgrade and what they answered, and a policy that
 * omitted that would be a policy written to look good rather than to be true.
 */
export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy" updated="8 October 2026">
      <Section title="The short version">
        <p>
          We collect what we need to run your website and your account, and nothing to sell on. We
          do not sell your information to anyone, and you can ask us to delete it.
        </p>
      </Section>

      <Section title="What we hold about your account">
        <Points
          items={[
            "Your name, business name, email address, and a phone number if you give us one.",
            "Your sign-in details. Passwords are stored as a one-way hash, which means we cannot read yours and neither can anyone who takes a copy of our database.",
            "A record of the devices and times your account signed in, so you can spot one that is not you.",
          ]}
        />
      </Section>

      <Section title="What we hold about your website">
        <Points
          items={[
            "Your domains, hosting details and certificate dates.",
            "The requests you raise, the replies on them, and the work we did.",
            "Where your plan includes it, the record of backups, uptime checks, security scans, SEO work, performance checks and health checks on your site.",
          ]}
        />
      </Section>

      <Section title="Billing information">
        <p>
          We record which plan you are on, the period, the amount, when it started and when it
          renews, and whether a payment has been confirmed.
        </p>
        <p>
          Where payment details are sent to you directly, we never see or store your card. Where a
          payment is taken through our payment provider, the card details go to them and not to us;
          we keep only the card type and the last four digits so you can tell which card was used.
        </p>
      </Section>

      <Section title="Plans and upgrade prompts">
        <p>
          The dashboard sometimes suggests a different plan. So that this stays useful rather than
          becoming a nuisance, we record what happened each time.
        </p>
        <Points
          items={[
            "When a plan was shown to you, which plan it was, and what you chose.",
            "When an upgrade suggestion was shown, and whether you took it, said not now, or asked to be reminded later.",
            "How many update requests you have used in the current month, which is also what the meter on your dashboard shows you.",
          ]}
        />
        <p>
          We use this to limit how often we ask. A suggestion is capped at one a week, three
          declines in a row drops that to one a month, and asking to be reminded later is honoured
          exactly. None of it is shared with anyone outside Ethixweb.
        </p>
      </Section>

      <Section title="Email">
        <p>
          We send account email: your sign-in codes, request updates, payment confirmations and
          renewal reminders. Every message has a link to manage what we send you.
        </p>
        <p>
          We keep a record of the messages we sent you and whether they were delivered, so we can
          tell whether something reached you when you say it did not arrive.
        </p>
      </Section>

      <Section title="Who else sees it">
        <p>
          Our hosting, email and payment providers process some of this on our behalf, under
          contract, only to provide the service. We do not sell your information and we do not pass
          it to anyone for advertising.
        </p>
      </Section>

      <Section title="How long we keep it">
        <p>
          We keep your account and site records while you are a client, and for a period afterwards
          where we are required to, such as for accounting. You can ask us to delete what is not
          legally required at any time.
        </p>
      </Section>

      <Section title="Your choices">
        <Points
          items={[
            "Ask for a copy of what we hold about you.",
            "Ask us to correct anything that is wrong.",
            "Ask us to delete what we are not required to keep.",
            "Change what email we send you, from the link in any message.",
          ]}
        />
        <p>
          Email{" "}
          <a href="mailto:yash@ethixweb.com" className="text-link underline underline-offset-2">
            yash@ethixweb.com
          </a>{" "}
          and we will answer.
        </p>
      </Section>
    </LegalPage>
  );
}
