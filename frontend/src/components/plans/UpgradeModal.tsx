import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PerkList } from "@/components/plans/PerkList";
import { useAuth } from "@/context/AuthContext";
import { useMembership, useUpsell, useUpsellAction } from "@/hooks/useMembership";
import { usd, type UpsellPrompt } from "@/lib/plans";

/**
 * The weekly value message, for a Basic or Managed client.
 *
 * The fallback trigger, and the only one of the four that interrupts. Hitting
 * a limit, opening a locked panel and asking for a change on Basic are all
 * answered where they happen; this is what is left when none of those has
 * come up, and the server will not hand one over more than once a week.
 *
 * Two ways out, both neutral. Nobody is asked to click "No thanks, I don't
 * care about my website" -- the decline wording is the thing most likely to
 * make somebody resent a product, and it buys nothing.
 */
export function UpgradeModal() {
  const { user } = useAuth();
  const { data: prompt } = useUpsell();
  const { data: membership } = useMembership();
  const act = useUpsellAction();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const [open, setOpen] = useState(false);
  /**
   * Held from the moment it opens, for the same reason the unlock modal holds
   * its own: recording that it was shown refetches, the server then declines
   * to offer another, and a component reading the live value would vanish
   * while somebody was still reading it.
   */
  const [shown, setShown] = useState<UpsellPrompt | null>(null);

  // Never over the ticket form. Somebody part-way through writing a request is
  // the worst possible moment to put a sales message on top of them, and it is
  // also where the limit prompt already lives.
  const busyWriting = pathname.startsWith("/portal/tickets");

  /**
   * Never behind the unlock modal either.
   *
   * Both mount in the shell, and both open on a dashboard load. Stacked, the
   * one underneath is invisible -- but it had already reported itself shown,
   * which spends the week's single prompt on something nobody saw. The
   * settling-in rule means this can hardly ever happen in practice; "hardly
   * ever" is not a reason to burn somebody's one prompt.
   */
  const unlockOwed = Boolean(membership?.unlock);

  useEffect(() => {
    if (!prompt || user?.role !== "client" || busyWriting || unlockOwed) return;
    if (shown?.messageKey === prompt.messageKey) return;
    setShown(prompt);
    setOpen(true);
    // Recorded when it appears, not when it was fetched: a tab opened in the
    // background and never looked at must not spend the week's one prompt.
    act.mutate({ action: "shown", messageKey: prompt.messageKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, user?.role, busyWriting, unlockOwed, shown?.messageKey]);

  if (!shown) return null;

  const close = (action: "dismissed" | "snoozed") => {
    act.mutate({ action, messageKey: shown.messageKey });
    setOpen(false);
  };

  const upgrade = () => {
    act.mutate({ action: "clicked", messageKey: shown.messageKey });
    setOpen(false);
    navigate(`/portal/billing/plans?plan=${shown.to.key}`);
  };

  const scheduled = shown.quote.scheduled;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close("dismissed"))}>
      <DialogContent className="max-h-[90svh] overflow-y-auto scrollbar-slim sm:max-w-xl">
        <DialogTitle className="t-title">
          {usd(shown.differenceUsd)} more a month
        </DialogTitle>
        <DialogDescription className="t-prose">{shown.message}</DialogDescription>

        {/* Their plan against the recommended one, and only what differs. A
            column repeating what they already have makes the step look
            smaller than it is. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <section className="rounded-xl bg-secondary/50 px-3.5 py-3 ring-1 ring-foreground/10">
            <p className="t-label text-muted-foreground">You have</p>
            <p className="mt-1 t-heading">{shown.from.name}</p>
            <p className="numeric t-body text-muted-foreground">
              {usd(shown.from.monthlyUsd)} USD / month
            </p>
          </section>

          <section className="rounded-2xl bg-card px-3.5 py-3 ring-1 ring-primary/40">
            <p className="t-label text-primary">You would get</p>
            <p className="mt-1 t-heading">{shown.to.name}</p>
            <p className="numeric t-body text-muted-foreground">
              {usd(shown.to.monthlyUsd)} USD / month
            </p>
            <PerkList perks={shown.gained} className="mt-2.5" />
          </section>
        </div>

        {/* What it actually costs today, credit included. The same quote the
            checkout uses, so the figure here is the figure on the invoice. */}
        {!scheduled && shown.quote.creditUsd > 0 && (
          <p className="t-caption text-muted-foreground">
            {usd(shown.quote.listAmountUsd)} less{" "}
            <span className="numeric">{usd(shown.quote.creditUsd)}</span> credited for the days
            left on your {shown.from.name} plan, so{" "}
            <span className="numeric font-medium text-foreground">
              {usd(shown.quote.amountUsd)} USD
            </span>{" "}
            today.
          </p>
        )}

        <div className="flex flex-col gap-2">
          <Button className="h-11 w-full px-4" onClick={upgrade}>
            Upgrade to {shown.to.name}
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              className="h-11 flex-1 px-4 sm:h-10"
              onClick={() => close("dismissed")}
            >
              Not now
            </Button>
            <Button
              variant="outline"
              className="h-11 flex-1 px-4 sm:h-10"
              onClick={() => close("snoozed")}
            >
              Remind me in 30 days
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
