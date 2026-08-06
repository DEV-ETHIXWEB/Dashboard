import type { LucideIcon } from "lucide-react";
import { PlugZap } from "lucide-react";

/**
 * Shown when the workspace token for an integration is missing from the server
 * environment. Lists exactly which variables to set so an admin can self-serve.
 */
export function IntegrationNotConnected({
  name,
  icon: Icon = PlugZap,
  vars,
  steps,
}: {
  name: string;
  icon?: LucideIcon;
  vars: { key: string; hint: string; optional?: boolean }[];
  steps: string[];
}) {
  return (
    <div className="rounded-2xl bg-card p-6 ring-1 ring-foreground/10">
      <div className="flex items-start gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-warning/10 text-warning">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">{name} is not connected</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Add the environment variables below to the server, then restart it.
          </p>
        </div>
      </div>

      <dl className="mt-5 space-y-3">
        {vars.map((v) => (
          <div key={v.key} className="rounded-xl bg-secondary/40 px-4 py-3">
            <dt className="font-mono text-sm font-semibold text-foreground">
              {v.key}
              {v.optional && <span className="ml-2 font-sans text-xs font-normal text-muted-foreground">optional</span>}
            </dt>
            <dd className="mt-0.5 text-sm text-muted-foreground">{v.hint}</dd>
          </div>
        ))}
      </dl>

      <ol className="mt-5 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
