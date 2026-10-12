import { cn } from "@/lib/utils";
import type { Entitlement } from "@/lib/plans";

/**
 * A plan's perks, as plain lines.
 *
 * No checkmarks. A column of ticks reads as a claim being made at you, and on
 * a phone fifteen of them is a wall of green before a single word is read. A
 * small square in the brand red marks the line and gets out of the way.
 *
 * `tone="muted"` is for the perks a *lower* plan does not have, shown beside
 * the ones it does in an upgrade comparison.
 */
export function PerkList({
  perks,
  tone = "default",
  className,
}: {
  perks: Pick<Entitlement, "key" | "label">[];
  tone?: "default" | "muted";
  className?: string;
}) {
  if (perks.length === 0) return null;

  return (
    <ul className={cn("space-y-2", className)}>
      {perks.map((perk) => (
        <li key={perk.key} className="flex gap-2.5">
          <span
            aria-hidden
            className={cn(
              "mt-[0.45rem] size-[5px] shrink-0 rounded-[1px]",
              tone === "muted" ? "bg-muted-foreground/50" : "bg-primary",
            )}
          />
          <span
            className={cn(
              "t-body",
              tone === "muted" ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {perk.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
