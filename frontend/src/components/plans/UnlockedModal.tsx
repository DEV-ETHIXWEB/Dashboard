import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useMarkUnlockSeen, useMembership } from "@/hooks/useMembership";
import { useAuth } from "@/context/AuthContext";
import type { Unlock } from "@/lib/plans";

/**
 * The first dashboard load after a plan starts.
 *
 * Calm and specific. It lists only what is new to this client -- for an
 * upgrade, strictly the difference, so the step up they just paid for reads as
 * one rather than as a list they have already seen. Every line that has a
 * screen behind it is a link to that screen, because a perk somebody cannot
 * find is a perk they will not renew for.
 *
 * No confetti, nothing that moves on hover, and the fade is the app's own
 * dialog transition rather than anything written for this. Somebody has just
 * spent money; the tone is confirmation, not celebration.
 */
export function UnlockedModal() {
  const { user } = useAuth();
  const { data: membership } = useMembership();
  const markSeen = useMarkUnlockSeen();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  /**
   * A copy of what was unlocked, taken when the modal opens.
   *
   * It cannot render from the live query. Opening stamps the moment as seen,
   * which refetches the membership, which sets `unlock` back to null -- and a
   * component reading the live value would unmount itself a second after it
   * appeared, while somebody was still reading it. The snapshot is what it
   * shows; the live value only decides whether to open.
   */
  const [shown, setShown] = useState<Unlock | null>(null);

  const unlock = membership?.unlock ?? null;

  useEffect(() => {
    if (!unlock || user?.role !== "client") return;
    if (shown?.subscriptionId === unlock.subscriptionId) return;
    setShown(unlock);
    setOpen(true);
    // Stamped as it opens. Somebody who shuts the tab halfway through has
    // still been shown it, and showing it again on their next sign-in would
    // be the nagging the rest of this feature is written to avoid.
    markSeen.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlock, user?.role, shown?.subscriptionId]);

  if (!shown) return null;

  const goto = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90svh] overflow-y-auto scrollbar-slim sm:max-w-lg">
        <DialogTitle className="t-title">You're on {shown.planName}</DialogTitle>
        <DialogDescription className="t-body">
          {shown.isUpgrade && shown.fromPlanName
            ? `Here's what moving up from ${shown.fromPlanName} adds to your site.`
            : "Here's what's now unlocked for your site."}
        </DialogDescription>

        <ul className="space-y-1">
          {shown.gained.map((perk) => (
            <li key={perk.key}>
              {perk.surface ? (
                // A line that goes somewhere. The whole row is the target, so
                // it is a comfortable tap on a phone rather than a few words.
                <Link
                  to={perk.surface.to}
                  onClick={(e) => {
                    e.preventDefault();
                    goto(perk.surface!.to);
                  }}
                  className="focus-clear flex items-baseline gap-2.5 rounded-lg px-2 py-2 hover:bg-secondary/60"
                >
                  <span aria-hidden className="mt-[0.45rem] size-[5px] shrink-0 rounded-[1px] bg-primary" />
                  <span className="t-body flex-1">{perk.label}</span>
                  <span className="t-caption shrink-0 text-link underline underline-offset-2">
                    {perk.surface.label}
                  </span>
                </Link>
              ) : (
                // Not everything has a screen. "Proactive internal updates,
                // done for you" is work we do, not a panel to open, and
                // linking it somewhere approximate would be worse than not.
                <div className="flex items-baseline gap-2.5 px-2 py-2">
                  <span aria-hidden className="mt-[0.45rem] size-[5px] shrink-0 rounded-[1px] bg-primary" />
                  <span className="t-body flex-1">{perk.label}</span>
                </div>
              )}
            </li>
          ))}
        </ul>

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button className="h-11 flex-1 px-4 sm:h-10" onClick={() => setOpen(false)}>
            Take me to my dashboard
          </Button>
          {shown.canRaiseRequest && (
            <Button
              variant="outline"
              className="h-11 flex-1 px-4 sm:h-10"
              onClick={() => goto("/portal/tickets")}
            >
              Raise my first request
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
