import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { plainDate } from "@/lib/money";
import { cn } from "@/lib/utils";
import { PANEL_COPY } from "@/components/plans/panelExamples";
import type { PlanKey } from "@/lib/plans";

interface SiteRecord {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  status: string | null;
  occurredAt: string | null;
}

interface PanelResponse {
  records: SiteRecord[];
  locked: boolean;
  kind: string;
  recommended?: PlanKey;
}

/**
 * One of the seven panels an Unlimited plan unlocks.
 *
 * The same component renders all three states, which is the point: a client
 * who upgrades sees the panel they were already looking at, with their own
 * rows in it, rather than being taken somewhere new.
 *
 *   locked    the real layout, with rows marked Example on every line, one
 *             sentence on why it is worth having, and the way to get it.
 *   empty     unlocked, nothing logged yet. Says so plainly rather than
 *             inventing a row to fill the space.
 *   rows      what we actually did, newest first.
 *
 * The server refuses the rows to a client whose plan does not include them, so
 * this is a presentation of a decision made elsewhere rather than the decision
 * itself. The example rows are written here and never come from the server --
 * nothing that looks like a client's own data is ever sent to somebody who
 * does not own it.
 */
export function SitePanel({
  kind,
  clientId,
  className,
}: {
  kind: keyof typeof PANEL_COPY;
  /** Staff looking at one client. A client always sees their own. */
  clientId?: string;
  className?: string;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const copy = PANEL_COPY[kind];

  const { data, isLoading } = useQuery({
    queryKey: ["site-records", kind, clientId ?? "me"],
    queryFn: () =>
      api<PanelResponse>(
        "GET",
        `/site-records?kind=${encodeURIComponent(kind)}${clientId ? `&clientId=${encodeURIComponent(clientId)}` : ""}`,
      ),
    enabled: Boolean(user),
  });

  return (
    <section
      id={kind}
      className={cn("rounded-2xl bg-card px-4 py-4 ring-1 ring-foreground/10 sm:px-5 sm:py-5", className)}
    >
      <h2 className="t-heading">{copy.title}</h2>
      <p className="mt-0.5 t-body text-muted-foreground">{copy.description}</p>

      {isLoading ? (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-11/12 rounded-lg" />
        </div>
      ) : data?.locked ? (
        <LockedState
          copy={copy}
          onUpgrade={() =>
            navigate(`/portal/billing/plans?plan=${data.recommended ?? "unlimited"}`)
          }
        />
      ) : (data?.records.length ?? 0) === 0 ? (
        <p className="mt-3 rounded-lg bg-secondary/60 px-3 py-2.5 t-body text-muted-foreground">
          {copy.empty}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {data!.records.map((row) => (
            <li
              key={row.id}
              className="flex items-start gap-3 rounded-lg bg-row px-3 py-2.5 ring-1 ring-row-border ring-inset"
            >
              <div className="min-w-0 flex-1">
                <p className="t-body font-medium">{row.title}</p>
                {row.detail && <p className="t-caption text-muted-foreground">{row.detail}</p>}
              </div>
              <div className="shrink-0 text-right">
                {row.status && <p className="t-caption font-medium">{row.status}</p>}
                {row.occurredAt && (
                  <p className="t-caption text-muted-foreground">{plainDate(row.occurredAt)}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The real panel, with example rows.
 *
 * Every row carries its own "Example" tag rather than one notice at the top:
 * a label at the top scrolls away, and the row underneath it then reads as
 * somebody's data. The rows are visibly quieter than real ones, which is the
 * second signal doing the same job.
 */
export function LockedState({
  copy,
  onUpgrade,
}: {
  copy: (typeof PANEL_COPY)[keyof typeof PANEL_COPY];
  onUpgrade: () => void;
}) {
  return (
    <>
      <ul className="mt-3 space-y-2" aria-label={`Example of what ${copy.title} shows`}>
        {copy.examples.map((row) => (
          <li
            key={row.title + row.when}
            className="flex items-start gap-3 rounded-lg bg-secondary/40 px-3 py-2.5 ring-1 ring-border ring-inset"
          >
            <span className="mt-0.5 shrink-0 rounded-md bg-foreground/10 px-1.5 py-0.5 t-micro text-muted-foreground">
              Example
            </span>
            <div className="min-w-0 flex-1">
              <p className="t-body font-medium text-muted-foreground">{row.title}</p>
              <p className="t-caption text-muted-foreground">{row.detail}</p>
            </div>
            <div className="shrink-0 text-right">
              {row.status && <p className="t-caption text-muted-foreground">{row.status}</p>}
              <p className="t-caption text-muted-foreground">{row.when}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-3 t-body">{copy.benefit}</p>

      <Button className="mt-3 h-11 w-full px-4 sm:h-10 sm:w-auto" onClick={onUpgrade}>
        Upgrade to Unlimited
      </Button>
    </>
  );
}
