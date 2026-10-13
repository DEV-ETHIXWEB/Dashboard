import { useState } from "react";
import { AlertTriangle, ArrowUpRight, CheckCircle2, ChevronDown, CreditCard, RotateCcw } from "lucide-react";
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

/** What one stored row is, said plainly. Only ever shown inside a fold. */
const KIND_LABEL: Record<string, string> = {
  invoice: "Invoice",
  charge: "Card payment",
  refund: "Refund",
};

/**
 * The rows one payment was folded from, invoice first.
 *
 * Opened by hand, never by default: the fold is the truth of what was paid,
 * and this is only here so nobody has to take that on trust.
 */
function PaymentRecords({ records }: { records: Payment[] }) {
  const ordered = [...records].sort((a, b) => (a.kind === "invoice" ? -1 : b.kind === "invoice" ? 1 : 0));

  return (
    <ul className="mt-2 space-y-1.5 rounded-xl bg-secondary/60 p-3">
      {ordered.map((record) => {
        const receipt = record.invoiceUrl || record.receiptUrl;
        const detail = [
          record.paidAt ? plainDate(record.paidAt) : null,
          record.invoiceNumber,
          cardLine(record),
        ]
          .filter(Boolean)
          .join(" · ");

        return (
          <li key={record.id} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              <span className="font-medium text-foreground">{KIND_LABEL[record.kind] ?? "Payment"}</span>
              {detail && ` · ${detail}`}
            </span>
            <span className="flex shrink-0 items-baseline gap-2">
              <span className="numeric text-muted-foreground">
                {paymentMoney(record.amount, record.currency)}
              </span>
              {receipt && (
                <a
                  href={receipt}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-clear rounded-lg font-medium text-link hover:underline"
                >
                  Receipt
                </a>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One row per real payment.
 *
 * Every figure here came from Stripe, and the receipt link goes to Stripe's own
 * document rather than to something this app printed -- so a client can check
 * us against the payment processor without asking.
 *
 * A payment Stripe reported twice -- once as an invoice, once as the charge
 * that paid it -- is one row here, counted once, and it opens to show both. The
 * alternative was the history that shipped before this: the same payment listed
 * twice, which reads as having been charged twice.
 *
 * `clientName` is the staff view. Without it this is a client reading their own
 * payments, where naming the payer on every line would say nothing.
 */
export function PaymentList({
  payments,
  clientName,
}: {
  payments: Payment[];
  clientName?: (clientId: string | null) => string | null;
}) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <ul className="divide-y divide-row-border">
      {payments.map((payment) => {
        const look = lookFor(payment.status);
        const Icon = look.icon;
        const card = cardLine(payment);
        const receipt = payment.invoiceUrl || payment.receiptUrl;
        const records = payment.records && payment.records.length > 1 ? payment.records : null;
        const expanded = open === payment.id;
        const payer = clientName ? clientName(payment.clientId ?? null) : null;

        return (
          <li key={payment.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex items-center gap-3">
              <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", look.tone)}>
                <Icon aria-hidden className="size-[17px]" strokeWidth={1.9} />
              </span>

              <div className="min-w-0 flex-1">
                <p className="min-w-0 truncate text-sm font-medium">
                  {payment.description || "Payment"}
                </p>
                {clientName && (
                  <p
                    className={cn(
                      "mt-0.5 truncate text-xs font-medium",
                      payer ? "text-foreground/80" : "text-warning",
                    )}
                  >
                    {payer ?? "Not linked to a client yet"}
                  </p>
                )}
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
                {records && (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : payment.id)}
                    className="focus-clear mt-1 -ml-1 inline-flex items-center gap-1 rounded-lg px-1 text-xs font-medium text-muted-foreground hover:text-foreground coarse:min-h-11"
                  >
                    <ChevronDown
                      aria-hidden
                      className={cn("size-3 transition-transform", expanded && "rotate-180")}
                    />
                    {expanded
                      ? "Hide how this was recorded"
                      : `Stripe recorded this ${records.length} ways`}
                  </button>
                )}
              </div>

              <div className="shrink-0 text-right">
                <p
                  className={cn(
                    "numeric text-sm font-semibold",
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
            </div>

            {records && expanded && <PaymentRecords records={records} />}
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
          <dt className="t-label text-muted-foreground">
            {i === 0 ? "Amount" : i === 1 ? (cancelAtPeriodEnd ? "Ends" : "Next payment") : "Card"}
          </dt>
          <dd className="mt-0.5 text-sm font-medium">{line}</dd>
        </div>
      ))}
    </dl>
  );
}
