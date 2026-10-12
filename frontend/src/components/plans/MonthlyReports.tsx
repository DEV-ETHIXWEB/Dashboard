import { Link, useNavigate } from "react-router-dom";
import { FileText } from "lucide-react";
import { MoneyPanel } from "@/components/money/Money";
import { LockedState } from "@/components/plans/SitePanel";
import { PANEL_COPY } from "@/components/plans/panelExamples";
import { useMembership } from "@/hooks/useMembership";
import { useAuth } from "@/context/AuthContext";
import { hasEntitlement } from "@/lib/plans";
import { plainDate } from "@/lib/money";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import type { Report } from "@/lib/entities";

/** Which documents count as the monthly report, by the category we file them under. */
export const MONTHLY_REPORT_CATEGORY = "Monthly report";

export function isMonthlyReport(report: Pick<Report, "category">) {
  return String(report.category || "").trim().toLowerCase()
    === MONTHLY_REPORT_CATEGORY.toLowerCase();
}

/**
 * The monthly performance report, as a section of the Documents page rather
 * than a page of its own.
 *
 * Deliberately not a new destination. A client already knows where their
 * documents live, and a second page also called Reports sitting next to the
 * first is the kind of thing that generates a phone call. The locked state is
 * shown here too, so somebody on Managed can see that the thing exists and
 * what it would contain.
 */
export function MonthlyReports({
  reports,
  className,
}: {
  reports: Report[] | undefined;
  className?: string;
}) {
  const { user } = useAuth();
  const { data: membership } = useMembership();
  const navigate = useNavigate();

  // Staff are never gated; they are looking at the workspace, not buying it.
  const isClient = user?.role === "client";
  const locked = isClient && membership != null && !hasEntitlement(membership, "monthly_report");

  const mine = (reports ?? []).filter(isMonthlyReport);
  const copy = PANEL_COPY.monthly_report;

  // Nothing to show and nothing to sell: a staff view with no reports filed
  // does not need a panel explaining what one would be.
  if (!locked && mine.length === 0 && !isClient) return null;

  return (
    <MoneyPanel
      className={className}
      title={copy.title}
      subtitle={locked ? "Included with Unlimited" : `${mine.length} so far`}
    >
      {locked ? (
        <LockedState
          copy={copy}
          onUpgrade={() => navigate("/portal/billing/plans?plan=unlimited")}
        />
      ) : mine.length === 0 ? (
        <p className="rounded-lg bg-secondary/60 px-3 py-2.5 t-body text-muted-foreground">
          {copy.empty}
        </p>
      ) : (
        <ul className="space-y-2">
          {mine.map((report) => (
            <li
              key={report.id}
              className="flex items-center gap-3 rounded-lg bg-row px-3 py-2.5 ring-1 ring-row-border ring-inset"
            >
              <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate t-body font-medium">{report.name}</p>
                <p className="t-caption text-muted-foreground">
                  Added {plainDate(report.createdAt)}
                </p>
              </div>
              <Link
                to={`/portal/reports/${report.id}`}
                className={cn(buttonVariants({ variant: "outline" }), "h-9 shrink-0 px-3")}
              >
                Open
              </Link>
            </li>
          ))}
        </ul>
      )}
    </MoneyPanel>
  );
}
