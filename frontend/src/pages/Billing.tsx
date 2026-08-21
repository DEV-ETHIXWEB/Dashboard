import { toast } from "sonner";
import { CreditCard, CheckCircle2, Loader2, RefreshCw, Settings2, Wallet } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { useBillingStatus, useBillingPortal, usePayments, useSyncStripe, useUsers } from "@/hooks/useData";
import { api } from "@/lib/api";
import { MoneyPanel, DataList, DataRow, PanelEmpty, BentoGrid, BentoColumns, bento } from "@/components/money/Money";
import { AttentionNotice, FeeBreakdown, TrustFooter } from "@/components/money/Trust";
import { PaymentList, PlanSummary, paymentMoney } from "@/components/money/Payments";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { plainDate } from "@/lib/money";
import type { Billing as BillingRecord } from "@/lib/entities";

const NEEDS_ACTION = new Set(["past_due", "unpaid", "incomplete", "incomplete_expired", "canceled"]);

const FEE_ROWS = [
  {
    label: "Your monthly plan",
    amount: "Shown before you pay",
    explain: "You see the exact amount on the payment screen, before you confirm anything.",
  },
  { label: "Setting up your account", amount: 0, explain: "There is no joining fee." },
  { label: "Paying by card", amount: 0, explain: "We do not add a surcharge for card payments." },
  { label: "Changing or cancelling", amount: 0, explain: "Stop any time. You are not tied in." },
] as const;

function describeStatus(status: string | undefined): { headline: string; detail: string; ok: boolean } {
  switch (status) {
    case "active":
      return { headline: "Everything is up to date", detail: "Your payments are going through normally.", ok: true };
    case "trialing":
      return { headline: "You are on a free trial", detail: "We will tell you before the first payment.", ok: true };
    case "past_due":
    case "unpaid":
      return { headline: "We could not take your last payment", detail: "Your card was declined. Updating it takes about a minute.", ok: false };
    case "incomplete":
    case "incomplete_expired":
      return { headline: "Your setup was not finished", detail: "The payment details were never confirmed, so nothing has been charged.", ok: false };
    case "canceled":
      return { headline: "Your plan has been cancelled", detail: "You will not be charged again. You can start a new plan whenever you like.", ok: false };
    default:
      return { headline: "You do not have a plan yet", detail: "Nothing is being charged to you.", ok: true };
  }
}

export default function Billing() {
  const { user } = useAuth();
  const isStaff = user != null && ["admin", "sales", "project_manager"].includes(user.role);
  const { data, isLoading, isError, error, refetch } = useBillingStatus();
  const { data: users } = useUsers();
  const { data: payments } = usePayments();
  const sync = useSyncStripe();
  const portal = useBillingPortal();

  const checkout = useMutation({
    mutationFn: () => api<{ url: string }>("POST", "/billing/checkout"),
    onSuccess: (d) => {
      window.location.href = d.url;
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Checkout failed"),
  });

  /** Card details are entered on Stripe's own page, never on ours. */
  const openPortal = () =>
    portal.mutate(undefined, {
      onSuccess: (d) => {
        window.location.href = d.url;
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not open the payment settings"),
    });

  if (isLoading) {
    return (
      <BentoGrid className="mx-auto w-full max-w-6xl">
        <Skeleton className={`h-9 w-56 rounded-xl ${bento(4)}`} />
        <Skeleton className={`h-36 w-full rounded-2xl ${bento(2)}`} />
        <Skeleton className={`h-56 w-full rounded-2xl ${bento(2)}`} />
      </BentoGrid>
    );
  }

  if (isError) {
    return (
      <BentoGrid className="mx-auto w-full max-w-6xl">
        <div className={bento(4)}>
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      </BentoGrid>
    );
  }

  if (isStaff) {
    const rows = (data?.billing as BillingRecord[]) ?? [];
    const clientName = (id: string) => users?.find((u) => u.id === id)?.name ?? id;

    return (
      <BentoGrid className="mx-auto w-full max-w-6xl">
        <header className={`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${bento(4)}`}>
          <div>
            <h1 className="text-2xl leading-tight font-semibold tracking-tight">Payments</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Every plan and every payment, read straight from Stripe.
            </p>
          </div>
          {user?.role === "admin" && (
            <Button
              variant="outline"
              className="h-10 w-full gap-2 px-4 sm:w-auto"
              disabled={sync.isPending || data?.enabled === false}
              title={data?.enabled === false ? "Stripe is not configured yet" : "Pull the latest from Stripe"}
              onClick={() =>
                sync.mutate(undefined, {
                  onSuccess: (r) => {
                    const failed = r.synced.filter((x) => x.error);
                    toast.success(
                      failed.length === 0
                        ? `Synced ${r.synced.length} account${r.synced.length === 1 ? "" : "s"} from Stripe`
                        : `Synced with ${failed.length} problem${failed.length === 1 ? "" : "s"}: ${failed[0].error}`,
                    );
                  },
                  onError: (err) => toast.error(err instanceof Error ? err.message : "Sync failed"),
                })
              }
            >
              {sync.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Sync from Stripe
            </Button>
          )}
        </header>

        <MoneyPanel className={bento(4)} title="All client accounts" subtitle={`${rows.length} on record`}>
          {rows.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">No payment records yet.</p>
          ) : (
            <DataList>
              {rows.map((b) => {
                const state = describeStatus(b.status);
                return (
                  <DataRow
                    key={b.id}
                    title={clientName(b.clientId)}
                    meta={`${b.plan ?? "No plan"} · Updated ${plainDate(b.updatedAt)}`}
                    status={state.ok ? state.headline : undefined}
                    flag={state.ok ? undefined : state.headline}
                  />
                );
              })}
            </DataList>
          )}
        </MoneyPanel>

        <MoneyPanel
          className={bento(4)}
          title="Payments received"
          subtitle={
            payments && payments.count > 0
              ? `${paymentMoney(payments.total, payments.currency)} across ${payments.count} payment${payments.count === 1 ? "" : "s"}`
              : "Nothing recorded yet"
          }
        >
          {!payments || payments.payments.length === 0 ? (
            <PanelEmpty>
              {data?.enabled === false
                ? "Stripe is not configured, so there is nothing to mirror yet."
                : "No payments have come through Stripe yet. Sync pulls in anything already on the account."}
            </PanelEmpty>
          ) : (
            <PaymentList payments={payments.payments.slice(0, 25)} />
          )}
        </MoneyPanel>

        <TrustFooter className={bento(4)} />
      </BentoGrid>
    );
  }

  const billing = data?.billing as BillingRecord | undefined;
  const enabled = data?.enabled;
  const state = describeStatus(billing?.status);
  const needsAction = billing?.status ? NEEDS_ACTION.has(billing.status) : false;

  return (
    <BentoGrid className="mx-auto w-full max-w-6xl">
      <header className={bento(4)}>
        <h1 className="text-2xl leading-tight font-semibold tracking-tight">Your payments</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          What you pay, when you pay it, and exactly what it covers.
        </p>
      </header>

      {needsAction && (
        <div className={bento(4)}>
        <AttentionNotice
          title={state.headline}
          action={
            enabled ? (
              <Button onClick={() => checkout.mutate()} disabled={checkout.isPending} className="h-10 px-4">
                <CreditCard className="size-4" />
                {checkout.isPending ? "Opening…" : "Update your card"}
              </Button>
            ) : undefined
          }
        >
          {state.detail} Your money is safe and nothing else has changed.
        </AttentionNotice>
        </div>
      )}

      <div className={bento(4)}>
        <BentoColumns
          items={[
            {
              key: "plan",
              node: (
                <section className="rounded-2xl bg-card px-4 py-4 ring-1 ring-foreground/10 sm:px-5 sm:py-5">
                  <p className="text-sm font-medium text-muted-foreground">Your plan</p>
                  <p className="mt-1 text-2xl leading-tight font-semibold tracking-tight">
                    {billing?.plan ?? "No plan yet"}
                  </p>

                  {!needsAction && (
                    <>
                      <p className="mt-3 flex items-start gap-2 text-base leading-snug font-medium">
                        <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-money-in" />
                        {state.headline}
                      </p>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{state.detail}</p>
                    </>
                  )}

                  <PlanSummary
                    amount={billing?.amount}
                    currency={billing?.currency}
                    interval={billing?.interval}
                    currentPeriodEnd={billing?.currentPeriodEnd}
                    cancelAtPeriodEnd={billing?.cancelAtPeriodEnd}
                    cardBrand={billing?.cardBrand}
                    cardLast4={billing?.cardLast4}
                  />

                  {billing?.updatedAt && (
                    <p className="mt-3 text-sm text-muted-foreground">
                      Last checked {plainDate(billing.updatedAt)}.
                    </p>
                  )}

                  {billing?.stripeCustomerId && (
                    <Button
                      variant="outline"
                      className="mt-4 h-11 w-full gap-2 px-4 sm:h-10 sm:w-auto"
                      disabled={portal.isPending}
                      onClick={openPortal}
                    >
                      {portal.isPending ? <Loader2 className="size-4 animate-spin" /> : <Settings2 className="size-4" />}
                      Manage payment method
                    </Button>
                  )}

                  {/* Only say "no payments set up" when that is actually true.
                      A mirrored plan with real invoices behind it is set up,
                      whether or not this deployment holds the Stripe key. */}
                  {!enabled && !billing?.stripeCustomerId ? (
                    <p className="mt-4 rounded-lg bg-secondary px-3 py-2.5 text-sm leading-relaxed">
                      Payments are not switched on for this account yet. Nothing is being charged to
                      you. <span className="font-medium">There is nothing you need to do.</span>
                    </p>
                  ) : (
                    billing?.status !== "active" &&
                    !needsAction && (
                      <Button
                        onClick={() => checkout.mutate()}
                        disabled={checkout.isPending}
                        className="mt-4 h-10 px-4"
                      >
                        <CreditCard className="size-4" />
                        {checkout.isPending ? "Opening…" : "Set up your payment"}
                      </Button>
                    )
                  )}
                </section>
              ),
            },
            {
              key: "fees",
              node: (
                <MoneyPanel title="What you pay" subtitle="Every charge, in full">
                  <FeeBreakdown
                    rows={[...FEE_ROWS]}
                    note="That is the complete list. There are no other charges, and we will never take money from you without telling you first."
                  />
                </MoneyPanel>
              ),
            },
          ]}
        />
      </div>

      <MoneyPanel
        className={bento(4)}
        title="What you have paid"
        subtitle={
          payments && payments.count > 0
            ? `${paymentMoney(payments.total, payments.currency)} in total`
            : "Nothing yet"
        }
      >
        {!payments || payments.payments.length === 0 ? (
          <PanelEmpty>
            <span className="flex flex-col items-center gap-1">
              <Wallet aria-hidden className="size-6 text-muted-foreground" />
              You have not been charged anything yet. Every payment will be listed here with a
              receipt you can download.
            </span>
          </PanelEmpty>
        ) : (
          <PaymentList payments={payments.payments} />
        )}
      </MoneyPanel>

      <TrustFooter className={bento(4)} />
    </BentoGrid>
  );
}
