import { AlertTriangle, ArrowUpRight, CheckCircle2, CreditCard, RotateCcw } from "lucide-react";
import { plainDate } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { Payment } from "@/lib/entities";

/**
 * Money in the currency Stripe reported it in.
 *
 * Not the app-wide `money()` helper: that one assumes dollars. A payment
 * carries its own currency because Stripe does, and showing a euro charge with
 * a dollar sign is the kind of small lie that costs trust.
 */
export function paymentMoney(amount: number, currency: string | undefined): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
      maximumFractionDigits: 2,
    }).format(Number(amount || 0));
  } catch {
    return `${Number(amount || 0).toFixed(2)} ${(currency || "").toUpperCase()}`;
  }
}

/** "Visa ending 4242", or nothing if Stripe did not say. */
export function cardLine(payment: Pick<Payment, "cardBrand" | "cardLast4">): string | null {
  if (!payment.cardBrand && !payment.cardLast4) return null;
  const brand = payment.cardBrand
    ? payment.cardBrand.charAt(0).toUpperCase() + payment.cardBrand.slice(1)
    : "Card";
  return payment.cardLast4 ? `${brand} ending ${payment.cardLast4}` : brand;
}

const LOOK = {
  paid: { icon: CheckCircle2, tone: "bg-money-in/10 text-money-in", label: "Paid" },
  refunded: { icon: RotateCcw, tone: "bg-secondary text-muted-foreground", label: "Refunded" },
  failed: { icon: AlertTriangle, tone: "bg-destructive/10 text-destructive", label: "Failed" },
  open: { icon: CreditCard, tone: "bg-warning/15 text-warning", label: "Not paid yet" },
} as const;

function lookFor(status: string) {
  return LOOK[status as keyof typeof LOOK] ?? LOOK.open;
}

/**
 * One row per real payment.
 *
 * Every figure here came from Stripe, and the receipt link goes to Stripe's own
 * document rather than to something this app printed -- so a client can check
 * us against the payment processor without asking.
 */
export function PaymentList({ payments }: { payments: Payment[] }) {
  return (
    <ul className="divide-y divide-row-border">
      {payments.map((payment) => {
        const look = lookFor(payment.status);
        const Icon = look.icon;
        const card = cardLine(payment);
        const receipt = payment.invoiceUrl || payment.receiptUrl;

        return (
          <li key={payment.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", look.tone)}>
              <Icon aria-hidden className="size-[17px]" strokeWidth={1.9} />
            </span>

            <div className="min-w-0 flex-1">
              <p className="min-w-0 truncate text-sm font-medium">
                {payment.description || "Payment"}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {[
                  look.label,
                  payment.paidAt ? plainDate(payment.paidAt) : null,
                  payment.invoiceNumber,
                  card,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {payment.status === "failed" && payment.failureMessage && (
                <p className="mt-1 text-xs text-destructive">{payment.failureMessage}</p>
              )}
            </div>

            <div className="shrink-0 text-right">
              <p
                className={cn(
                  "text-sm font-semibold tabular-nums",
                  payment.status === "failed" && "text-destructive",
                  payment.status === "refunded" && "text-muted-foreground",
                )}
              >
                {paymentMoney(payment.amount, payment.currency)}
              </p>
              {receipt && (
                <a
                  href={receipt}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-clear mt-0.5 -mr-2 inline-flex items-center gap-0.5 rounded-lg px-2 text-xs font-medium text-link hover:underline coarse:min-h-11"
                >
                  Receipt
                  <ArrowUpRight aria-hidden className="size-3" />
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The line that answers "when does this happen again, and on what card?".
 *
 * Only rendered from figures Stripe actually returned; a missing renewal date
 * shows nothing rather than a guess.
 */
export function PlanSummary({
  amount,
  currency,
  interval,
  currentPeriodEnd,
  cancelAtPeriodEnd,
  cardBrand,
  cardLast4,
}: {
  amount?: number | null;
  currency?: string;
  interval?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  cardBrand?: string | null;
  cardLast4?: string | null;
}) {
  const card = cardLine({ cardBrand, cardLast4 });
  const price = amount != null ? paymentMoney(amount, currency) : null;

  const lines = [
    price ? `${price}${interval ? ` every ${interval}` : ""}` : null,
    currentPeriodEnd
      ? cancelAtPeriodEnd
        ? `Ends ${plainDate(currentPeriodEnd)}`
        : `Renews ${plainDate(currentPeriodEnd)}`
      : null,
    card,
  ].filter(Boolean) as string[];

  if (lines.length === 0) return null;

  return (
    <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
      {lines.map((line, i) => (
        <div key={line} className="rounded-xl bg-secondary/60 px-3 py-2">
          <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {i === 0 ? "Amount" : i === 1 ? (cancelAtPeriodEnd ? "Ends" : "Next payment") : "Card"}
          </dt>
          <dd className="mt-0.5 text-sm font-medium">{line}</dd>
        </div>
      ))}
    </dl>
  );
}
