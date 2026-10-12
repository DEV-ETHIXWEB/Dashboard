import { cn } from "@/lib/utils";
import type { PlanPeriod } from "@/lib/plans";

/**
 * Monthly, 3, 6 or 12 months.
 *
 * Opens on Monthly, always. The playbook's rule is to use the discount to
 * close rather than to open, and a pricing table that starts on the yearly
 * figure is quoting a number nobody agreed to pay in one go.
 *
 * Built on the app's own recessed-well and raised-key surfaces rather than a
 * new segmented control, so it reads as the same hardware as the rest of the
 * dashboard.
 */
export function PeriodSwitcher({
  periods,
  value,
  onChange,
  className,
}: {
  periods: PlanPeriod[];
  value: number;
  onChange: (months: number) => void;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Billing period"
      // Two rows of two on a phone, one row of four from sm up. Four keys with
      // their discount labels need about 430px, and forcing them into 375 cut
      // "12 mo 20% off" off the right edge of the screen -- the one key the
      // playbook most wants read.
      className={cn(
        "skeu-well grid w-full grid-cols-2 gap-1 rounded-xl p-1 sm:inline-flex sm:w-auto",
        className,
      )}
    >
      {periods.map((period) => {
        const selected = period.months === value;
        return (
          <button
            key={period.months}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(period.months)}
            className={cn(
              "focus-clear tap-target rounded-lg px-3 py-1.5 whitespace-nowrap transition-colors duration-(--duration-fast) sm:flex-none",
              selected
                ? "skeu-key text-foreground"
                : "skeu-key-idle text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="t-body font-medium">{period.shortLabel}</span>
            {period.discountLabel && (
              <span
                className={cn(
                  "ml-1.5 t-micro",
                  selected ? "text-primary" : "text-muted-foreground",
                )}
              >
                {period.discountLabel}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
