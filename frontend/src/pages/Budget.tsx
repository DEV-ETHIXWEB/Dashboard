import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Wallet } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { useBudget, useUsers, usePayments } from "@/hooks/useData";
import { api } from "@/lib/api";
import {
  MoneyPanel, BigMoney, SpendBreakdown, DataList, DataRow, BentoGrid, BentoColumns, bento,
} from "@/components/money/Money";
import { TrustFooter } from "@/components/money/Trust";
import { PaymentList, paymentMoney } from "@/components/money/Payments";
import { ErrorState } from "@/components/ErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { monthKey, plainMonth } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { BudgetItem } from "@/lib/entities";

const ALL_PERIODS = "all";

export default function Budget() {
  const { user } = useAuth();
  const isStaff = user != null && ["admin", "sales", "project_manager"].includes(user.role);
  const { data: users } = useUsers();

  const clients = (users ?? []).filter((u) => u.role === "client");
  const [selectedClient, setSelectedClient] = useState<string>("");
  const activeClientId = (isStaff ? selectedClient || clients[0]?.id : user?.id) ?? "";

  const { data: items, isLoading, isError, error, refetch } = useBudget(activeClientId);
  const { data: payments } = usePayments(isStaff ? activeClientId || undefined : undefined);
  const paid = payments && payments.count > 0 ? payments : null;
  const qc = useQueryClient();

  const [period, setPeriod] = useState<string>(ALL_PERIODS);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);

  const createItem = useMutation({
    mutationFn: () =>
      api<{ item: BudgetItem }>("POST", "/budget", { clientId: activeClientId, label, amount: Number(amount) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["budget"] });
      toast.success("Budget item added");
      setOpen(false);
      setLabel("");
      setAmount("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to add item"),
  });

  const deleteItem = useMutation({
    mutationFn: (id: string) => api("DELETE", `/budget/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["budget"] });
      setConfirmingRemoval(null);
      toast.success("Removed");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to remove item"),
  });

  const periodKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const item of items ?? []) {
      const key = monthKey(item.month);
      if (key) keys.add(key);
    }
    return [...keys].sort((a, b) => b.localeCompare(a));
  }, [items]);

  const visibleItems = useMemo(() => {
    if (period === ALL_PERIODS) return items ?? [];
    return (items ?? []).filter((i) => monthKey(i.month) === period);
  }, [items, period]);

  const total = useMemo(() => visibleItems.reduce((sum, i) => sum + Number(i.amount), 0), [visibleItems]);

  const categories = useMemo(() => {
    const byLabel = new Map<string, number>();
    for (const item of visibleItems) {
      byLabel.set(item.label, (byLabel.get(item.label) ?? 0) + Number(item.amount));
    }
    return [...byLabel.entries()]
      .map(([name, value]) => ({ id: name, label: name, amount: value }))
      .sort((a, b) => b.amount - a.amount);
  }, [visibleItems]);

  const colorIndexFor = useMemo(() => new Map(categories.map((c, i) => [c.label, i])), [categories]);

  return (
    <BentoGrid className="mx-auto w-full max-w-6xl">
      <header className={`flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between ${bento(4)}`}>
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight">Your spending</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {isStaff
              ? "Every amount on this client's account, grouped by what it was for."
              : "Every amount on your account, grouped by what it was for."}
          </p>
        </div>

        {isStaff && (
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <Select
              items={Object.fromEntries(clients.map((c) => [c.id, c.name]))}
              value={activeClientId}
              onValueChange={(v) => setSelectedClient(v ?? "")}
            >
              <SelectTrigger className="h-10 w-full sm:w-52">
                <SelectValue placeholder="Choose a client" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger render={<Button disabled={!activeClientId} className="h-10 px-4" />}>
                <Plus className="size-4" /> Add an amount
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add an amount</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label>What was it for?</Label>
                    <Input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="For example: Website hosting"
                      className="h-10"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>How much, in dollars?</Label>
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                      className="h-10"
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => createItem.mutate()}
                    disabled={createItem.isPending || !label || !amount}
                    className="h-10 px-4"
                  >
                    {createItem.isPending ? "Adding…" : "Add it"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </header>

      {isLoading ? (
        <>
          <Skeleton className={`h-28 w-full rounded-2xl ${bento(4)}`} />
          <Skeleton className={`h-64 w-full rounded-2xl ${bento(4)}`} />
        </>
      ) : isError ? (
        <div className={bento(4)}>
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      ) : (items ?? []).length === 0 ? (
        <section className={`flex flex-col items-center gap-2 rounded-2xl bg-card px-5 py-10 text-center ring-1 ring-foreground/10 ${bento(4)}`}>
          <Wallet aria-hidden className="size-8 text-muted-foreground" />
          <p className="text-lg font-semibold tracking-tight">No spending on this account yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            When money goes out, it will be listed here in plain English: what it was for, when, and
            how much.
          </p>
        </section>
      ) : (
        <>
          {periodKeys.length > 1 && (
            <div className={`flex flex-wrap items-center gap-2 ${bento(4)}`}>
              <span className="text-sm font-medium text-muted-foreground">Period:</span>
              {[ALL_PERIODS, ...periodKeys].map((key) => {
                const active = period === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setPeriod(key)}
                    aria-pressed={active}
                    className={cn(
                      "focus-clear h-11 rounded-lg px-3.5 text-sm",
                      active
                        ? "bg-primary font-medium text-primary-foreground"
                        : "bg-card font-normal text-foreground ring-1 ring-foreground/15 hover:bg-secondary",
                    )}
                  >
                    {key === ALL_PERIODS ? "All time" : plainMonth(key)}
                  </button>
                );
              })}
            </div>
          )}

          <div className={bento(4)}>
            <BentoColumns
              items={[
                {
                  key: "total",
                  node: (
                    <section className="rounded-2xl bg-card px-4 py-4 ring-1 ring-foreground/10 sm:px-5 sm:py-5">
                      <BigMoney
                        label={period === ALL_PERIODS ? "Total money out" : `Money out in ${plainMonth(period)}`}
                        amount={total}
                        direction="out"
                        caption={`Spread across ${categories.length} ${categories.length === 1 ? "category" : "categories"}.`}
                        footnote={
                          period === ALL_PERIODS
                            ? "Covering every period on record."
                            : `Covering ${plainMonth(period)}.`
                        }
                      />
                    </section>
                  ),
                },
                {
                  key: "breakdown",
                  node: (
                    <MoneyPanel title="What you spent it on" subtitle="Largest first">
                      <SpendBreakdown
                        categories={categories}
                        total={total}
                        emptyText="Nothing was spent in this period."
                      />
                    </MoneyPanel>
                  ),
                },
              ]}
            />
          </div>

          <MoneyPanel className={bento(4)} title="Every amount, one by one" subtitle={`${visibleItems.length} in total`}>
              <DataList>
                {visibleItems.map((item) => (
                  <DataRow
                    key={item.id}
                    swatchIndex={colorIndexFor.get(item.label) ?? 0}
                    title={item.label}
                    meta={plainMonth(item.month)}
                    amount={Number(item.amount)}
                    action={
                      isStaff ? (
                        <Button
                          variant="ghost"
                          onClick={() => setConfirmingRemoval(item.id)}
                          className="-mr-2 h-9 shrink-0 px-2 text-sm text-muted-foreground"
                        >
                          Remove
                        </Button>
                      ) : undefined
                    }
                  />
                ))}
              </DataList>

              {isStaff && confirmingRemoval && (
                <div className="mt-3 flex flex-col gap-2.5 rounded-lg bg-secondary px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm">
                    Remove “{visibleItems.find((i) => i.id === confirmingRemoval)?.label}”? This
                    cannot be undone.
                  </p>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      disabled={deleteItem.isPending}
                      onClick={() => deleteItem.mutate(confirmingRemoval)}
                      className="h-9 bg-attention px-3 text-sm text-white hover:bg-attention/85"
                    >
                      {deleteItem.isPending ? "Removing…" : "Yes, remove"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setConfirmingRemoval(null)}
                      className="h-9 px-3 text-sm"
                    >
                      Keep it
                    </Button>
                  </div>
                </div>
              )}
          </MoneyPanel>
        </>
      )}

      {paid && (
        <MoneyPanel
          className={bento(4)}
          title="Payments you made to us"
          subtitle={`${paymentMoney(paid.total, paid.currency)} across ${paid.count} payment${paid.count === 1 ? "" : "s"}`}
        >
          {/* Spend above is what we tracked; this is what the payment provider
              actually took. Both are shown rather than merged, because they
              answer different questions. */}
          <PaymentList payments={paid.payments.slice(0, 6)} />
        </MoneyPanel>
      )}

      <TrustFooter className={bento(4)} />
    </BentoGrid>
  );
}
