import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PlanChooser, PlanChosen } from "@/components/plans/PlanChooser";
import { useMarkPlansModalSeen, useMembership } from "@/hooks/useMembership";
import { useAuth } from "@/context/AuthContext";
import type { Quote } from "@/lib/plans";

/**
 * The plans, the first time a client without a plan signs in.
 *
 * Opens once and never by itself again. Somebody who closed it has answered
 * the question, and reopening it on every sign-in is the behaviour that makes
 * people stop reading anything we put in front of them -- the Plan item in the
 * navigation and the slim banner are how they find it again.
 *
 * Closable at every point, including mid-choice. It covers the dashboard while
 * it is open; it does not hold it hostage.
 */
export function PlansModal() {
  const { user } = useAuth();
  const { data: membership } = useMembership();
  const markSeen = useMarkPlansModalSeen();

  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Quote | null>(null);
  // Whether this mount has already decided. Without it, marking the modal seen
  // refetches the account, which would re-run the decision and close the modal
  // under somebody who is still reading it.
  const [decided, setDecided] = useState(false);

  const isClient = user?.role === "client";
  const neverSeen = isClient && !user?.plansModalSeenAt;
  /**
   * Somebody who has just cancelled has no active plan, so `needsPlan` is
   * true -- but putting the plans in front of them is the worst possible
   * reading of that. They have told us they are leaving; `endingAt` is how
   * the state says so, and the billing page still carries "Change plan" if
   * they reconsider.
   */
  const noPlan =
    membership?.needsPlan === true
    && !membership?.pendingSubscription
    && !membership?.endingAt;

  useEffect(() => {
    if (decided) return;
    if (!neverSeen || !noPlan || !membership) return;
    setDecided(true);
    setOpen(true);
    // Recorded as it opens, not as it closes. A client who shuts the tab mid
    // modal has still been shown it, and showing it again next time would be
    // the nagging this is written to avoid.
    markSeen.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neverSeen, noPlan, membership, decided]);

  const firstName = (user?.name || "").split(" ")[0] || "there";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-h-[90svh] overflow-y-auto scrollbar-slim sm:max-w-4xl"
        // The close control is always reachable, including on the phone sheet.
        showCloseButton
      >
        {chosen ? (
          <>
            <DialogTitle className="sr-only">Plan chosen</DialogTitle>
            <PlanChosen
              quote={chosen}
              email={user?.email ?? "your email"}
              firstName={firstName}
            />
            <Button className="h-11 w-full px-4" onClick={() => setOpen(false)}>
              Take me to my dashboard
            </Button>
          </>
        ) : (
          <>
            <DialogTitle className="t-title">Choose your plan</DialogTitle>
            <DialogDescription className="t-body">
              Your site is live and nothing has been switched off. Hosting with us runs on a plan
              now, so picking one is what keeps it that way. You can change it any time from{" "}
              <Link to="/portal/billing">Billing</Link>.
            </DialogDescription>

            <PlanChooser membership={membership} onChosen={setChosen} compact />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
