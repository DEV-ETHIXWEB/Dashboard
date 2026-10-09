import { Button } from "@/components/ui/button";
import { plainDate } from "@/lib/money";
import type { PlanKey } from "@/lib/plans";

/** What the server said when it would not take the request as it stands. */
export interface RequestBlock {
  error: string;
  reason: "allowance_used" | "category_not_included" | "no_plan" | string;
  recommended: PlanKey | null;
  resetsAt: string | null;
  chargeable: boolean;
}

/**
 * Shown inside the ticket form when a plan will not carry the request as it
 * stands. Never a dead end, and never at the cost of what they typed.
 *
 * Out of allowance is three ways forward: pay for this one, wait for the
 * reset, or upgrade. The decline wording is neutral in all of them -- nobody
 * is told they do not care about their website.
 */
export function AllowancePanel({
  block,
  busy,
  onUpgrade,
  onPayExtra,
  onQueue,
}: {
  block: RequestBlock;
  busy?: boolean;
  onUpgrade: (plan: PlanKey) => void;
  onPayExtra: () => void;
  onQueue: () => void;
}) {
  const outOfAllowance = block.reason === "allowance_used";
  const resetLabel = block.resetsAt ? plainDate(block.resetsAt) : "your billing day";

  return (
    <div className="rounded-xl bg-attention-surface px-3.5 py-3 ring-1 ring-attention-border">
      <p className="t-body font-medium text-attention">{block.error}</p>

      {outOfAllowance && (
        <p className="mt-1 t-caption text-attention">
          {block.chargeable
            ? `We can still do this one now and quote you for it first, or save it until ${resetLabel}. Nothing you have typed is lost either way.`
            : `We can save it until ${resetLabel}. Nothing you have typed is lost.`}
        </p>
      )}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {block.recommended && (
          <Button
            className="h-10 px-4"
            disabled={busy}
            onClick={() => onUpgrade(block.recommended!)}
          >
            Upgrade to {block.recommended === "unlimited" ? "Unlimited" : "Managed"}
          </Button>
        )}

        {outOfAllowance && block.chargeable && (
          <Button variant="outline" className="h-10 px-4" disabled={busy} onClick={onPayExtra}>
            Send it as a paid extra
          </Button>
        )}

        {outOfAllowance && (
          <Button variant="outline" className="h-10 px-4" disabled={busy} onClick={onQueue}>
            Save it for {resetLabel}
          </Button>
        )}
      </div>

      {outOfAllowance && block.chargeable && (
        <p className="mt-2.5 t-caption text-muted-foreground">
          A paid extra is quoted per job, and we tell you the price before any work starts.
        </p>
      )}
    </div>
  );
}
