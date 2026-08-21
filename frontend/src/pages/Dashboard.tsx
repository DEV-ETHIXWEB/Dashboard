import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Wallet, FolderKanban, LifeBuoy, Globe, FileText, Plus } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import {
  useBudget, useBillingStatus, useTickets, useProjects, useDomains, useReports, usePayments,
} from "@/hooks/useData";
import {
  MoneyPanel, PanelLink, PanelEmpty, BigMoney, SpendBreakdown, StatTile,
  DataList, DataRow, BentoGrid, BentoColumns, bento,
} from "@/components/money/Money";
import { AttentionNotice, TrustFooter } from "@/components/money/Trust";
import { PaymentList, PlanSummary, paymentMoney } from "@/components/money/Payments";
import { ErrorState } from "@/components/ErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { Button, buttonVariants } from "@/components/ui/button";
import { CreateTicketModal } from "@/components/CreateTicketModal";
import { cn } from "@/lib/utils";
import { money, monthKey, plainMonth, plainDate, describeChange } from "@/lib/money";
import { formatBytes } from "@/lib/format";
import { apiUrl } from "@/lib/api";
import { canSeePage } from "@/lib/permissions";
import type { Billing, BudgetItem } from "@/lib/entities";
import type { ClientPageKey } from "@/lib/types";

const NEEDS_ACTION = new Set(["past_due", "unpaid", "incomplete", "incomplete_expired", "canceled"]);

const RENEWAL_WARNING_DAYS = 45;

const NOTICE_ACTION =
  "focus-clear inline-flex h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90";

export default function Dashboard() {
  const { user } = useAuth();
  const isClient = user?.role === "client";

  /** Sections this account may open; staff always get all of them. */
  const can = (page: ClientPageKey) => canSeePage(user, page);

  const queryClient = useQueryClient();

  const budgetQuery = useBudget(isClient ? user?.id : undefined);
  const billingQuery = useBillingStatus();
  const ticketsQuery = useTickets();
  const projectsQuery = useProjects();
  const domainsQuery = useDomains();
  const reportsQuery = useReports();
  const paymentsQuery = usePayments();

  const { data: budgetItems, isLoading } = budgetQuery;
  const { data: billingStatus } = billingQuery;
  const { data: tickets } = ticketsQuery;
  const { data: projects } = projectsQuery;
  const { data: domains } = domainsQuery;
  const { data: reports } = reportsQuery;
  const { data: payments } = paymentsQuery;

  const queries = [budgetQuery, billingQuery, ticketsQuery, projectsQuery, domainsQuery, reportsQuery, paymentsQuery];
  const isError = queries.some((q) => q.isError);
  const firstError = queries.find((q) => q.isError)?.error;

  const periods = useMemo(() => summarise(budgetItems ?? []), [budgetItems]);

  const billing = Array.isArray(billingStatus?.billing)
    ? undefined
    : (billingStatus?.billing as Billing | undefined);
  const paymentProblem = billing?.status ? NEEDS_ACTION.has(billing.status) : false;

  const openTickets = (tickets ?? []).filter((t) => !["Resolved", "Closed"].includes(t.status));
  const activeProjects = (projects ?? []).filter((p) => p.status !== "Complete");
  const daysLeft = (iso: string) => Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  const expiringDomains = (domains ?? []).filter((d) => {
    const days = daysLeft(d.expiresAt);
    return days > 0 && days < RENEWAL_WARNING_DAYS;
  });

  if (isLoading) return <DashboardSkeleton />;

  if (isError) {
    return (
      <BentoGrid className="mx-auto w-full max-w-6xl">
        <div className={bento(4)}>
          <ErrorState error={firstError} onRetry={() => queryClient.invalidateQueries()} />
        </div>
      </BentoGrid>
    );
  }

  const { latest, previous, allTime, categories } = periods;
  const change = describeChange(latest.total, previous.total);

  /**
   * Real payments beat tracked spend.
   *
   * `budget_items` are what the team recorded by hand; `payments` are what the
   * payment processor actually took. When both exist the processor wins the
   * headline, because that is the number a client can check against their own
   * bank statement -- the hand-tracked spend keeps its own panel below.
   */
  const paid = payments && payments.count > 0 ? payments : null;
  const recentPayments = paid?.payments.slice(0, 5) ?? [];

  return (
    <BentoGrid className="mx-auto w-full max-w-6xl">
      <header className={`flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between ${bento(4)}`}>
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight text-foreground">
            Hello, {user?.name?.split(" ")[0] ?? "there"}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Everything on {isClient ? "your account" : "the accounts you look after"}, on one page.
          </p>
        </div>

        <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto">
          <CreateTicketModal
            trigger={
              <Button className="h-11 w-full cursor-pointer gap-1.5 px-4 text-sm font-medium shadow-xs sm:h-9 sm:w-auto sm:px-3.5 sm:text-xs">
                <Plus className="size-4 sm:size-3.5" />
                Create ticket
              </Button>
            }
          />
          {/* Both of these are a tab away on a phone, and the tiles below link
              to them too. Only a desktop has room to spare for the shortcut. */}
          <Link
            to="/portal/reports"
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "hidden h-9 gap-1.5 border-border/70 px-3.5 text-xs font-medium hover:bg-muted/80 sm:inline-flex"
            )}
          >
            <FileText className="size-3.5 text-muted-foreground" />
            View Report
          </Link>
          <Link
            to="/portal/domains"
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "hidden h-9 gap-1.5 border-border/70 px-3.5 text-xs font-medium hover:bg-muted/80 sm:inline-flex"
            )}
          >
            <Globe className="size-3.5 text-muted-foreground" />
            View Domain
          </Link>
        </div>
      </header>

      {paymentProblem && (
        <div className={bento(4)}>
          <AttentionNotice
            title="We could not take your last payment"
            action={
              <Link to="/portal/billing" className={NOTICE_ACTION}>
                Fix this now
                <ArrowRight aria-hidden className="size-4" />
              </Link>
            }
          >
            Your card was declined, so your plan is on hold. Nothing else has changed and your money
            is safe. Updating your card takes about a minute.
          </AttentionNotice>
        </div>
      )}

      {expiringDomains.length > 0 && (
        <div className={bento(4)}>
          <AttentionNotice
            label="Coming up soon"
            title={`${expiringDomains.length} ${expiringDomains.length === 1 ? "website address needs" : "website addresses need"} renewing`}
            action={
              <Link to="/portal/domains" className={NOTICE_ACTION}>
                Look at these
                <ArrowRight aria-hidden className="size-4" />
              </Link>
            }
          >
            {expiringDomains.map((d) => d.domainName).join(", ")}, due within the next{" "}
            {RENEWAL_WARNING_DAYS} days.
          </AttentionNotice>
        </div>
      )}

      {/* Only tiles for sections this account can actually open. */}
      {can("projects") && (
        <StatTile
          className={bento(1)}
          label="Projects"
          value={activeProjects.length}
          hint={`${projects?.length ?? 0} in total`}
          icon={FolderKanban}
          to="/portal/projects"
        />
      )}
      {can("tickets") && (
        <StatTile
          className={bento(1)}
          label="Requests"
          value={openTickets.length}
          hint={openTickets.length === 0 ? "Nothing waiting" : "Waiting on us"}
          icon={LifeBuoy}
          to="/portal/tickets"
        />
      )}
      {can("domains") && (
        <StatTile
          className={bento(1)}
          label="Websites"
          value={domains?.length ?? 0}
          hint={expiringDomains.length > 0 ? `${expiringDomains.length} renewing soon` : "All up to date"}
          icon={Globe}
          to="/portal/domains"
        />
      )}
      {can("reports") && (
        <StatTile
          className={bento(1)}
          label="Documents"
          value={reports?.length ?? 0}
          hint="Ready to read"
          icon={FileText}
          to="/portal/reports"
        />
      )}

      <div className={bento(4)}>
        <BentoColumns
          items={[
            {
              key: "hero",
              node: (
                <section className="rounded-2xl bg-card px-4 py-4 ring-1 ring-foreground/10 sm:px-5 sm:py-5">
                  {paid ? (
                    <>
                      <BigMoney
                        label="Money you have paid us"
                        amount={paid.total}
                        direction="out"
                        caption={paid.lastPaidAt ? `Last payment ${plainDate(paid.lastPaidAt)}` : undefined}
                        footnote={`${paid.count} payment${paid.count === 1 ? "" : "s"} on record.${latest.key ? ` ${money(latest.total)} of tracked spend in ${plainMonth(latest.key)}.` : ""}`}
                      />
                      <p className="mt-4 border-t border-border pt-3 text-sm text-muted-foreground">
                        Every figure here comes from our payment provider, not from us. Each payment
                        has a receipt you can open and check.
                      </p>
                    </>
                  ) : latest.key ? (
                    <>
                      <BigMoney
                        label={`Money out in ${plainMonth(latest.key)}`}
                        amount={latest.total}
                        direction="out"
                        caption={change.text}
                        footnote={`Across ${categories.length} ${categories.length === 1 ? "category" : "categories"}. ${money(allTime)} tracked in total.`}
                      />
                      <p className="mt-4 border-t border-border pt-3 text-sm text-muted-foreground">
                        These figures come straight from {isClient ? "your account" : "the client accounts"}.
                        If a number looks wrong, tell us and a real person will check it.
                      </p>
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-2 py-6 text-center">
                      <Wallet aria-hidden className="size-8 text-muted-foreground" />
                      <p className="text-lg font-semibold tracking-tight">No spending yet</p>
                      <p className="max-w-sm text-sm text-muted-foreground">
                        As soon as there is spending on this account, you will see exactly where it
                        went right here.
                      </p>
                    </div>
                  )}
                </section>
              ),
            },
            ...(paid && paid.categories.length > 0
              ? [
                  {
                    key: "breakdown-paid",
                    node: (
                      <MoneyPanel
                        title="Where your money went"
                        subtitle="From your own payments"
                        action={<PanelLink to="/portal/billing">See every payment</PanelLink>}
                      >
                        <SpendBreakdown categories={paid.categories} total={paid.total} />
                      </MoneyPanel>
                    ),
                  },
                  {
                    key: "payments",
                    node: (
                      <MoneyPanel
                        title="Your payments"
                        subtitle={`${paymentMoney(paid.total, paid.currency)} in total`}
                        action={<PanelLink to="/portal/billing">See all</PanelLink>}
                      >
                        <PaymentList payments={recentPayments} />
                      </MoneyPanel>
                    ),
                  },
                ]
              : []),
            ...(latest.key
              ? [
                  {
                    key: "breakdown",
                    node: (
                      <MoneyPanel
                        title={paid ? "Ad and project spend" : "Where your money went"}
                        subtitle={plainMonth(latest.key)}
                        action={<PanelLink to="/portal/budget">See all spending</PanelLink>}
                      >
                        <SpendBreakdown categories={categories} total={latest.total} />
                      </MoneyPanel>
                    ),
                  },
                ]
              : []),
            ...(activeProjects.length > 0
              ? [
                  {
                    key: "projects",
                    node: (
                      <MoneyPanel
                        title="What we are working on"
                        subtitle={`${activeProjects.length} ${activeProjects.length === 1 ? "project" : "projects"} on the go`}
                        action={<PanelLink to="/portal/projects">See all</PanelLink>}
                      >
                        <DataList>
                          {activeProjects.map((p) => (
                            <DataRow
                              key={p.id}
                              title={p.name}
                              meta={p.type}
                              status={p.status}

                              progress={{ pct: p.progress.pct, label: `${p.progress.pct}%` }}
                            />
                          ))}
                        </DataList>
                      </MoneyPanel>
                    ),
                  },
                ]
              : []),
            {
              key: "requests",
              node: (
                <MoneyPanel
                  title="Your requests to us"
                  subtitle={openTickets.length === 0 ? "Nothing waiting on us" : `${openTickets.length} still open`}
                  action={<PanelLink to="/portal/tickets">See all</PanelLink>}
                >
                  {(tickets ?? []).length === 0 ? (
                    <PanelEmpty>You have not asked us anything yet. When you do, it will be listed here.</PanelEmpty>
                  ) : (
                    <DataList>
                      {(tickets ?? []).map((t) => (
                        <DataRow
                          key={t.id}
                          title={t.subject}
                          meta={`${t.category} · Asked ${plainDate(t.createdAt)}`}
                          status={t.status}
                        />
                      ))}
                    </DataList>
                  )}
                </MoneyPanel>
              ),
            },
            ...((domains ?? []).length > 0
              ? [
                  {
                    key: "domains",
                    node: (
                      <MoneyPanel
                        title="Your website addresses"
                        subtitle={`${domains?.length} looked after by us`}
                        action={<PanelLink to="/portal/domains">See all</PanelLink>}
                      >
                        <DataList>
                          {(domains ?? []).map((d) => {
                            const days = daysLeft(d.expiresAt);
                            const soon = days > 0 && days < RENEWAL_WARNING_DAYS;
                            const remaining = days > 0 ? `${days} days` : "Expired";
                            return (
                              <DataRow
                                key={d.id}
                                title={d.domainName}
                                meta={`Certificate ${d.sslStatus} · Renews ${plainDate(d.expiresAt)}`}
                                status={soon ? undefined : remaining}
                                flag={soon ? remaining : undefined}
                              />
                            );
                          })}
                        </DataList>
                      </MoneyPanel>
                    ),
                  },
                ]
              : []),
            ...((reports ?? []).length > 0
              ? [
                  {
                    key: "reports",
                    node: (
                      <MoneyPanel
                        title="Documents for you"
                        subtitle={`${reports?.length} ready to read`}
                        action={<PanelLink to="/portal/reports">See all</PanelLink>}
                      >
                        <DataList>
                          {(reports ?? []).map((r) => (
                            <DataRow
                              key={r.id}
                              title={r.name}
                              meta={`${r.category} · ${formatBytes(r.sizeBytes)} · ${plainDate(r.createdAt)}`}
                              action={
                                <a
                                  href={apiUrl(`/reports/${r.id}/download`)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="tap-target focus-clear -mr-2 inline-flex shrink-0 items-center justify-center rounded-lg px-2 text-sm font-medium text-link hover:underline"
                                >
                                  Open
                                </a>
                              }
                            />
                          ))}
                        </DataList>
                      </MoneyPanel>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </div>

      {billing && (
        <MoneyPanel
          className={bento(4)}
          title="Your plan"
          subtitle={billing.plan ?? "No plan yet"}
          action={<PanelLink to="/portal/billing">See payments</PanelLink>}
        >
          <p className="text-base">
            {paymentProblem
              ? "Your last payment did not go through. See the message at the top of this page."
              : "Your payments are going through normally. There is nothing you need to do."}
          </p>
          <PlanSummary
            amount={billing.amount}
            currency={billing.currency}
            interval={billing.interval}
            currentPeriodEnd={billing.currentPeriodEnd}
            cancelAtPeriodEnd={billing.cancelAtPeriodEnd}
            cardBrand={billing.cardBrand}
            cardLast4={billing.cardLast4}
          />
          {billing.updatedAt && (
            <p className="mt-1 text-sm text-muted-foreground">Last checked {plainDate(billing.updatedAt)}.</p>
          )}
        </MoneyPanel>
      )}

      <TrustFooter className={bento(4)} />
    </BentoGrid>
  );
}

interface Period {
  key: string | null;
  total: number;
  items: BudgetItem[];
}

function summarise(items: BudgetItem[]) {
  const buckets = new Map<string, BudgetItem[]>();
  for (const item of items) {
    const key = monthKey(item.month) ?? "unknown";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const sum = (list: BudgetItem[]) => list.reduce((acc, i) => acc + Number(i.amount), 0);

  const keys = [...buckets.keys()].sort((a, b) => (a === "unknown" ? 1 : b === "unknown" ? -1 : b.localeCompare(a)));

  const period = (key: string | undefined): Period =>
    key ? { key, total: sum(buckets.get(key) ?? []), items: buckets.get(key) ?? [] } : { key: null, total: 0, items: [] };

  const latest = period(keys[0]);
  const previous = period(keys[1]);

  const byLabel = new Map<string, number>();
  for (const item of latest.items) {
    byLabel.set(item.label, (byLabel.get(item.label) ?? 0) + Number(item.amount));
  }
  const categories = [...byLabel.entries()]
    .map(([label, amount]) => ({ id: label, label, amount }))
    .sort((a, b) => b.amount - a.amount);

  const rank = new Map(categories.map((c, i) => [c.label, i]));
  const activity = [...latest.items]
    .sort((a, b) => Number(b.amount) - Number(a.amount))
    .map((item) => ({
      id: item.id,
      title: item.label,
      when: plainMonth(item.month),
      amount: Number(item.amount),
      direction: "out" as const,
      colorIndex: rank.get(item.label) ?? 0,
    }));

  return { latest, previous, allTime: sum(items), categories, activity };
}

function DashboardSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <Skeleton className="h-9 w-56 rounded-xl" />
      <Skeleton className="h-24 w-full rounded-2xl" />
      <Skeleton className="h-36 w-full rounded-2xl" />
      <Skeleton className="h-64 w-full rounded-2xl" />
    </div>
  );
}
