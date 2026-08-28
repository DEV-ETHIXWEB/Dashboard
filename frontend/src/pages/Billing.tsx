import { useState } from "react";
import { toast } from "sonner";
import { CreditCard, CheckCircle2, Loader2, RefreshCw, Settings2, Wallet } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import {
  useBillingStatus,
  useBillingPortal,
  usePayments,
  useSyncStripe,
  useUsers,
  useStripeCustomers,
  useLinkStripeCustomer,
} from "@/hooks/useData";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  const isAdmin = user?.role === "admin";
  const { data, isLoading, isError, error, refetch } = useBillingStatus();
  const { data: users } = useUsers();
  const sync = useSyncStripe();
  const portal = useBillingPortal();

  /** Which client the staff view is looking at; null is the whole workspace. */
  const [focus, setFocus] = useState<string | null>(null);
  const { data: payments } = usePayments(focus ?? undefined);
  const { data: customers } = useStripeCustomers(isAdmin);
  const link = useLinkStripeCustomer();

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

    // One row per client account, not per billing record: a client nobody has
    // filed under a Stripe customer yet is exactly the one an admin needs to
    // see, and they have no billing record to be listed by.
    const clients = (users ?? []).filter((u) => u.role === "client");
    const billingFor = (clientId: string) => rows.find((b) => b.clientId === clientId);
    const customerFor = (clientId: string) => {
      const id = billingFor(clientId)?.stripeCustomerId;
      return id ? customers?.find((c) => c.id === id) ?? { id, name: null, email: null } : null;
    };

    /** File a client under a customer, or unfile them, and say what happened. */
    const relink = (clientId: string, value: string) =>
      link.mutate(
        { clientId, stripeCustomerId: value === "none" ? null : value },
        {
          onSuccess: (r) => {
            toast.success(
              value === "none"
                ? "Unlinked. Their payments are no longer shown against this account."
                : `Linked${r.customerName ? ` to ${r.customerName}` : ""} · ${r.payments} payment${r.payments === 1 ? "" : "s"} imported`,
            );
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Could not link that customer"),
        },
      );

    return (
      <BentoGrid className="mx-auto w-full max-w-6xl">
        <header className={`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${bento(4)}`}>
          <div>
            <h1 className="t-title">Payments</h1>
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
                sync.mutate(focus ?? undefined, {
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
              {focus ? `Sync ${clientName(focus)}` : "Sync from Stripe"}
            </Button>
          )}
        </header>

        <MoneyPanel
          className={bento(4)}
          title="Client accounts"
          subtitle={
            isAdmin
              ? `${clients.filter((c) => billingFor(c.id)?.stripeCustomerId).length} of ${clients.length} linked to Stripe`
              : `${rows.length} on record`
          }
        >
          {clients.length === 0 ? (
            <PanelEmpty>No client accounts yet.</PanelEmpty>
          ) : (
            <DataList>
              {clients.map((c) => {
                const b = billingFor(c.id);
                const customer = customerFor(c.id);
                const state = describeStatus(b?.status);
                const linked = Boolean(customer);

                return (
                  <DataRow
                    key={c.id}
                    title={c.name}
                    meta={
                      linked
                        ? `${customer?.name ?? customer?.id} · ${b?.plan ?? "No plan"} · Updated ${plainDate(b?.updatedAt)}`
                        : "Not linked to Stripe, so no payments are shown"
                    }
                    status={linked && state.ok ? state.headline : undefined}
                    flag={linked && !state.ok ? state.headline : !linked ? "Needs linking" : undefined}
                    action={
                      isAdmin ? (
                        <div className="flex items-center gap-2">
                          {/* The pairing is chosen, never inferred: client emails
                              and Stripe customer emails are two separate lists,
                              and one address here belongs to two companies. */}
                          <Select
                            value={customer?.id ?? "none"}
                            disabled={data?.enabled === false || link.isPending}
                            onValueChange={(v) => relink(c.id, v ?? "none")}
                          >
                            <SelectTrigger className="h-10 w-[190px]" aria-label={`Stripe customer for ${c.name}`}>
                              {/* The label is stated rather than looked up: the
                                  list is unmounted while closed, so Radix would
                                  otherwise fall back to showing the raw value. */}
                              <SelectValue placeholder="Link a customer">
                                {customer ? (customer.name ?? customer.email ?? customer.id) : "Not linked"}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">Not linked</SelectItem>
                              {(customers ?? []).map((cust) => {
                                const heldBy =
                                  cust.linkedClientId && cust.linkedClientId !== c.id
                                    ? ` · ${clientName(cust.linkedClientId)}`
                                    : "";
                                return (
                                  <SelectItem key={cust.id} value={cust.id}>
                                    {cust.name ?? cust.email ?? cust.id}
                                    {heldBy}
                                  </SelectItem>
                                );
                              })}
                            </SelectContent>
                          </Select>
                          <Button
                            variant="ghost"
                            className="h-10 px-3"
                            onClick={() => setFocus(focus === c.id ? null : c.id)}
                          >
                            {focus === c.id ? "Show all" : "View"}
                          </Button>
                        </div>
                      ) : undefined
                    }
                  />
                );
              })}
            </DataList>
          )}
        </MoneyPanel>

        <MoneyPanel
          className={bento(4)}
          title={focus ? `Payments from ${clientName(focus)}` : "Payments received"}
          subtitle={
            payments && payments.count > 0
              ? `${paymentMoney(payments.total, payments.currency)} across ${payments.count} payment${payments.count === 1 ? "" : "s"}`
              : "Nothing recorded yet"
          }
          action={
            focus ? (
              <Button variant="ghost" className="h-10 px-3" onClick={() => setFocus(null)}>
                Show every client
              </Button>
            ) : undefined
          }
        >
          {!payments || payments.payments.length === 0 ? (
            <PanelEmpty>
              {data?.enabled === false
                ? "Stripe is not configured, so there is nothing to mirror yet."
                : focus && !customerFor(focus)
                  ? "This client is not linked to a Stripe customer yet. Pick one above and their history is imported straight away."
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
        <h1 className="t-title">Your payments</h1>
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
                  <p className="mt-1 t-title">
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
