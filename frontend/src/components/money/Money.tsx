import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";
import { categoryColor, money, shareOf, signedMoney } from "@/lib/money";

export function BentoGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0", className)}>
      {children}
    </div>
  );
}

const BENTO_SPAN = {
  1: "sm:col-span-1 lg:col-span-1",
  2: "sm:col-span-2 lg:col-span-2",
  3: "sm:col-span-2 lg:col-span-3",
  4: "sm:col-span-2 lg:col-span-4",
} as const;

export function bento(span: 1 | 2 | 3 | 4): string {
  return BENTO_SPAN[span];
}

export function BentoColumns({
  items,
  className,
}: {
  items: { key: string; node: ReactNode }[];
  className?: string;
}) {
  const left = items.filter((_, i) => i % 2 === 0);
  const right = items.filter((_, i) => i % 2 === 1);

  return (
    <div className={cn("grid grid-cols-1 items-start gap-4 lg:grid-cols-2", className)}>
      <div className="flex min-w-0 flex-col gap-4">
        {left.map((i) => (
          <div key={i.key}>{i.node}</div>
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {right.map((i) => (
          <div key={i.key}>{i.node}</div>
        ))}
      </div>
    </div>
  );
}

export function MoneyPanel({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col rounded-2xl bg-card px-4 py-4 ring-1 ring-foreground/10 sm:px-5 sm:py-5", className)}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 className="text-lg leading-snug font-semibold tracking-tight">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

export function PanelLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="focus-clear -mr-2 inline-flex h-11 items-center rounded-lg px-2 text-sm font-medium text-link hover:underline"
    >
      {children}
    </Link>
  );
}

export function BigMoney({
  label,
  amount,
  direction,
  caption,
  footnote,
}: {
  label: string;
  amount: number;
  direction: "in" | "out" | "none";
  caption?: string;
  footnote?: string;
}) {
  return (
    <div>
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 numeric-display text-4xl leading-none font-semibold",
          direction === "in" ? "text-money-in" : "text-money-out",
        )}
      >
        {direction === "none" ? money(amount) : signedMoney(amount, direction)}
      </p>
      {caption && <p className="mt-3 text-base leading-snug text-foreground">{caption}</p>}
      {footnote && <p className="mt-1 text-sm leading-snug text-muted-foreground">{footnote}</p>}
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  to,
  className,
}: {
  label: string;
  value: string | number;
  hint: string;
  icon: LucideIcon;
  to: string;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "focus-clear flex flex-col gap-1.5 rounded-2xl bg-card px-4 py-3.5 ring-1 ring-foreground/10 hover:bg-secondary",
        className,
      )}
    >
      <span className="flex items-center gap-2">
        <Icon aria-hidden className="size-4 shrink-0 text-primary" />
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
      </span>
      <span className="numeric-display text-2xl leading-none font-semibold">{value}</span>
      <span className="text-sm leading-snug text-muted-foreground">{hint}</span>
    </Link>
  );
}

export function DataRow({
  swatchIndex,
  title,
  meta,
  amount,
  status,
  flag,
  progress,
  action,
}: {
  swatchIndex?: number;
  title: string;
  meta?: string;

  amount?: number;

  status?: string;

  flag?: string;
  progress?: { pct: number; label: string };
  action?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg bg-row px-3 py-2.5 ring-1 ring-row-border ring-inset">
      {swatchIndex != null && (
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: categoryColor(swatchIndex) }}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-base leading-snug font-medium">{title}</p>
        {meta && <p className="truncate text-sm text-muted-foreground">{meta}</p>}
        {progress && (
          <div className="mt-1.5 flex items-center gap-2.5">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
              <div className="h-full rounded-full bg-primary" style={{ width: `${progress.pct}%` }} />
            </div>
            <span className="shrink-0 text-sm whitespace-nowrap text-muted-foreground tabular-nums">
              {progress.label}
            </span>
          </div>
        )}
      </div>

      {amount != null && (
        <p className="shrink-0 text-base font-semibold text-money-out tabular-nums">
          {signedMoney(amount, "out")}
        </p>
      )}
      {status && <p className="shrink-0 text-sm font-medium text-muted-foreground">{status}</p>}
      {flag && (
        <p className="shrink-0 rounded-md border border-attention-border bg-attention-surface px-2 py-0.5 text-sm font-medium text-attention">
          {flag}
        </p>
      )}
      {action}
    </li>
  );
}

export function DataList({ children }: { children: ReactNode }) {
  return <ul className="space-y-2">{children}</ul>;
}

export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="py-1 text-sm text-muted-foreground">{children}</p>;
}

export interface SpendCategory {
  id: string;
  label: string;
  amount: number;
}

export function SpendBreakdown({
  categories,
  total,
  emptyText = "Nothing to show here yet.",
}: {
  categories: SpendCategory[];
  total: number;
  emptyText?: string;
}) {
  if (categories.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">{emptyText}</p>;
  }

  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-7">
      <div aria-hidden className="relative mx-auto size-40 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={categories}
              dataKey="amount"
              nameKey="label"
              innerRadius={50}
              outerRadius={78}
              paddingAngle={2}
              strokeWidth={0}
              isAnimationActive={false}
            >
              {categories.map((c, i) => (
                <Cell key={c.id} fill={categoryColor(i)} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xs font-medium text-muted-foreground">Total</span>
          <span className="text-base font-semibold tracking-tight tabular-nums">{money(total)}</span>
        </div>
      </div>

      <ul className="min-w-0 flex-1 space-y-2">
        {categories.map((c, i) => {
          const share = shareOf(c.amount, total);
          return (
            <li key={c.id} className="rounded-lg bg-row px-3 py-2.5 ring-1 ring-row-border ring-inset">
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 translate-y-0.5 rounded-full"
                    style={{ backgroundColor: categoryColor(i) }}
                  />
                  <span className="truncate text-base font-medium">{c.label}</span>
                </span>
                <span className="shrink-0 text-base font-semibold tabular-nums">{money(c.amount)}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-2.5">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.max(share, 2)}%`, backgroundColor: categoryColor(i) }}
                  />
                </div>
                <span className="w-9 shrink-0 text-right text-sm text-muted-foreground tabular-nums">
                  {share}%
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
