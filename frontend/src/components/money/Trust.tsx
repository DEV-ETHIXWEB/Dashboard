import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, Lock, BadgeCheck, TriangleAlert, Mail, Phone, MessageSquare } from "lucide-react";
import { SUPPORT } from "@/lib/support";
import { money } from "@/lib/money";
import { cn } from "@/lib/utils";

export function AttentionNotice({
  label = "Needs your attention",
  title,
  children,
  action,
}: {
  label?: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div role="status" className="rounded-xl border border-attention-border bg-attention-surface px-4 py-3.5">
      <div className="flex items-start gap-2.5">
        <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-attention" />
        <div className="min-w-0 flex-1">
          <p className="t-label text-attention">{label}</p>
          <p className="mt-1 text-base leading-snug font-semibold text-foreground">{title}</p>
          {children && <div className="mt-1 text-sm leading-relaxed text-foreground/90">{children}</div>}
          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
    </div>
  );
}

export function FeeBreakdown({
  rows,
  note,
}: {
  rows: { label: string; amount: number | string | null; explain: string }[];
  note?: string;
}) {
  return (
    <div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex items-start justify-between gap-4 rounded-lg bg-row px-3 py-2.5 ring-1 ring-row-border ring-inset"
          >
            <div className="min-w-0">
              <p className="text-base font-medium">{row.label}</p>
              <p className="mt-0.5 text-sm leading-snug text-muted-foreground">{row.explain}</p>
            </div>
            <p className="shrink-0 text-base font-semibold tabular-nums">
              {typeof row.amount === "string"
                ? row.amount
                : row.amount === null
                  ? "Not charged"
                  : row.amount === 0
                    ? "Free"
                    : money(row.amount)}
            </p>
          </li>
        ))}
      </ul>
      {note && <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{note}</p>}
    </div>
  );
}

export function TrustFooter({ className }: { className?: string }) {
  const badges = [
    { icon: BadgeCheck, label: "Identity verified" },
    { icon: Lock, label: "Details encrypted" },
    { icon: ShieldCheck, label: "Money protected" },
  ];

  const action =
    "focus-clear inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium";

  return (
    <section className={cn("rounded-2xl bg-card px-4 py-3.5 ring-1 ring-foreground/10 sm:px-5", className)}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {badges.map((b) => (
          <span key={b.label} className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <b.icon aria-hidden className="size-4 shrink-0 text-primary" />
            {b.label}
          </span>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <div className="min-w-0">
          <p className="text-base font-medium">Talk to a real person</p>
          <p className="text-sm text-muted-foreground">{SUPPORT.hours}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link to="/portal/tickets" className={cn(action, "bg-primary text-primary-foreground hover:bg-primary/90")}>
            <MessageSquare aria-hidden className="size-4" />
            Message us
          </Link>
          <a
            href={`mailto:${SUPPORT.email}`}
            className={cn(action, "bg-secondary text-secondary-foreground ring-1 ring-foreground/10 hover:bg-secondary/70")}
          >
            <Mail aria-hidden className="size-4" />
            Email
          </a>
          {SUPPORT.phone && (
            <a
              href={`tel:${SUPPORT.phone.replace(/\s/g, "")}`}
              className={cn(action, "bg-secondary text-secondary-foreground ring-1 ring-foreground/10 hover:bg-secondary/70")}
            >
              <Phone aria-hidden className="size-4" />
              Call
            </a>
          )}
        </div>
      </div>

      <p className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">
        We never sell your information, and you can ask us to delete it at any time.
      </p>
    </section>
  );
}
