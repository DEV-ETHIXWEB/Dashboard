import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MoneyPanel, DataList, DataRow, PanelEmpty } from "@/components/money/Money";
import { useMarkPaid, usePendingSubscriptions } from "@/hooks/useMembership";
import { isHeldForApproval } from "@/lib/api";
import { plainDate } from "@/lib/money";
import { usd } from "@/lib/plans";

/**
 * Everybody who has chosen a plan and is waiting on payment details.
 *
 * The admin's working list. A choice nobody acts on is a sale that died in an
 * inbox, so it sits on the Billing page they already open rather than
 * somewhere they have to remember to look.
 */
export function PendingPayments({ className }: { className?: string }) {
  const { data: pending, isLoading } = usePendingSubscriptions();
  const markPaid = useMarkPaid();

  const confirm = (id: string, clientName: string, amount: number) =>
    markPaid.mutate(id, {
      onSuccess: () => toast.success(`${clientName} is now active. Their perks are unlocked.`),
      onError: (err) => {
        // A 202 is not a failure: an admin who has not been vouched for
        // proposes this and a second admin signs it off. Saying "started" here
        // would be the one thing the queue exists to prevent.
        if (isHeldForApproval(err)) {
          toast.info("Sent to the other admins to sign off. Nothing has changed yet.");
          return;
        }
        toast.error(
          err instanceof Error ? err.message : `Could not confirm ${usd(amount)} from ${clientName}`,
        );
      },
    });

  if (isLoading) {
    return (
      <MoneyPanel className={className} title="Waiting on payment" subtitle="Checking">
        <div className="space-y-2">
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
        </div>
      </MoneyPanel>
    );
  }

  const rows = pending ?? [];

  return (
    <MoneyPanel
      className={className}
      title="Waiting on payment"
      subtitle={
        rows.length === 0
          ? "Nobody right now"
          : `${rows.length} client${rows.length === 1 ? "" : "s"} chose a plan`
      }
    >
      {rows.length === 0 ? (
        <PanelEmpty>
          Nobody is waiting on payment details. When a client picks a plan they appear here, and
          confirming the money is what starts it.
        </PanelEmpty>
      ) : (
        <DataList>
          {rows.map((row) => (
            <DataRow
              key={row.id}
              title={row.clientName}
              meta={[
                `${row.planName} · ${row.periodLabel}`,
                row.creditUsd ? `${usd(row.creditUsd)} credited from their old plan` : null,
                row.clientEmail,
                row.chosenAt ? `Chose ${plainDate(row.chosenAt)}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              // Deliberately not DataRow's `amount`, which renders every
              // figure as money going out and would print this one as
              // "- $96.90" -- a refund, which is the opposite of what it is.
              // This is money we are waiting to receive.
              status={`${usd(row.amountUsd)} USD`}
              flag="Send payment details"
              action={
                <Button
                  className="h-10 px-4"
                  disabled={markPaid.isPending}
                  onClick={() => confirm(row.id, row.clientName, row.amountUsd)}
                >
                  {markPaid.isPending && <Loader2 className="size-4 animate-spin" />}
                  Mark as paid
                </Button>
              }
            />
          ))}
        </DataList>
      )}
    </MoneyPanel>
  );
}
