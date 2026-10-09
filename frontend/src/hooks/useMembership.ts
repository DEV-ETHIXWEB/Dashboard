import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type { Membership, PlanCatalogue, PlanKey, Quote, Subscription, UpsellPrompt } from "@/lib/plans";

/**
 * The plan catalogue.
 *
 * Cached hard, because it is a price list that changes when we deploy and not
 * otherwise, and it is read by the plans modal, the billing page and every
 * upgrade prompt. Fetched rather than bundled so there is exactly one price
 * list in the system -- see the note at the top of lib/plans.ts.
 */
export function usePlanCatalogue() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["plan-catalogue"],
    queryFn: () => api<PlanCatalogue>("GET", "/plans"),
    enabled: Boolean(user),
    staleTime: 60 * 60 * 1000,
  });
}

/**
 * What this client is on, and what it unlocks.
 *
 * Deliberately not gated on the Billing page being switched on. An admin can
 * hide Billing from a client, and that is a decision about a page, not about
 * whether the "choose a plan" banner may appear on their dashboard. The server
 * takes the same view, so this never fires a doomed request.
 *
 * `clientId` is for staff looking at one client. A client is only ever told
 * about themselves whatever they pass, which the server enforces.
 */
export function useMembership(clientId?: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["membership", clientId ?? "me"],
    queryFn: () =>
      api<{ membership: Membership | null }>(
        "GET",
        clientId ? `/membership/status?clientId=${encodeURIComponent(clientId)}` : "/membership/status",
      ).then((d) => d.membership),
    enabled: Boolean(user),
  });
}

/**
 * Choose a plan.
 *
 * Creates a `pending_payment` subscription and nothing else: nothing is
 * charged, nothing unlocks, and a client already on a plan stays on it until
 * the new payment is confirmed.
 */
export function useChoosePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { planKey: PlanKey; period: number; clientId?: string }) =>
      api<{ subscription: Subscription; quote: Quote }>("POST", "/membership/select", vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["membership"] });
      qc.invalidateQueries({ queryKey: ["subscription-history"] });
    },
  });
}

/**
 * The upgrade prompt this client should see, or null.
 *
 * Fetching is not showing. The server hands one over at most once a week, and
 * it only counts as spent when the modal reports that it actually appeared --
 * a tab opened in the background and never looked at must not use up the
 * week's single prompt.
 */
export function useUpsell() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["upsell"],
    queryFn: () => api<{ prompt: UpsellPrompt | null }>("GET", "/membership/upsell").then((d) => d.prompt),
    enabled: user?.role === "client",
    // Asked once per page load, not on every window focus: an upgrade prompt
    // that re-evaluates when somebody alt-tabs back is a prompt that feels
    // like it is watching them.
    refetchOnWindowFocus: false,
    staleTime: 10 * 60 * 1000,
  });
}

/** Shown, dismissed, snoozed or clicked. All four are recorded. */
export function useUpsellAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { action: "shown" | "dismissed" | "snoozed" | "clicked"; messageKey?: string }) =>
      api<{ ok: boolean }>("POST", `/membership/upsell/${vars.action}`, {
        messageKey: vars.messageKey,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["upsell"] }),
  });
}

/**
 * Stop a plan renewing. Nothing switches off today -- the period they paid for
 * runs to its end.
 */
export function useCancelPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { reason?: string }) =>
      api<{ subscription: Subscription }>("POST", "/membership/cancel", vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["membership"] });
      qc.invalidateQueries({ queryKey: ["subscription-history"] });
    },
  });
}

/**
 * Ask us to prepare the website files. We prepare them; we do not migrate the
 * site, and the client is shown that before they ask.
 */
export function useRequestHandover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ requestedAt: string }>("POST", "/membership/handover", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["membership"] }),
  });
}

/** One client's chosen plan, as the admin's working list shows it. */
export interface PendingSubscription extends Subscription {
  clientName: string;
  clientEmail: string | null;
  chosenAt: string | null;
}

/**
 * Everybody waiting on payment details. Admin only, and refetched on a short
 * stale time because it is a queue somebody is working through.
 */
export function usePendingSubscriptions() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["pending-subscriptions"],
    queryFn: () =>
      api<{ pending: PendingSubscription[] }>("GET", "/membership/pending").then((d) => d.pending),
    enabled: user?.role === "admin",
    staleTime: 30_000,
  });
}

/**
 * Confirm the money arrived and start the plan.
 *
 * May come back as 202 rather than 200 -- an admin who has not been vouched
 * for proposes this and a second admin signs it off. `api` raises that as
 * HeldForApproval, so a caller that says nothing shows the server's own "sent
 * for approval" line instead of claiming the plan started.
 */
export function useMarkPaid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (subscriptionId: string) =>
      api<{ subscription: Subscription; kind: string }>(
        "POST",
        `/membership/${subscriptionId}/mark-paid`,
        {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pending-subscriptions"] });
      qc.invalidateQueries({ queryKey: ["membership"] });
      qc.invalidateQueries({ queryKey: ["subscription-history"] });
    },
  });
}

/**
 * Note that the unlock moment has been shown. Stamped on the subscription, not
 * the account, so an upgrade months later is a second unlock and still gets
 * its moment.
 */
export function useMarkUnlockSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean }>("POST", "/membership/unlock-seen", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["membership"] }),
  });
}

/**
 * Note that the first-login modal has been seen, so it never opens by itself
 * again. Fire-and-forget: a client who closed the modal has answered it, and
 * a failed write here is not worth an error message.
 */
export function useMarkPlansModalSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean }>("POST", "/membership/modal-seen", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "me"] }),
  });
}

/**
 * Every plan this client has been on. Read only on the billing page, which is
 * why it is a second request rather than part of the one above.
 */
export function useSubscriptionHistory(clientId?: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["subscription-history", clientId ?? "me"],
    queryFn: () =>
      api<{ subscriptions: Subscription[] }>(
        "GET",
        clientId ? `/membership/history?clientId=${encodeURIComponent(clientId)}` : "/membership/history",
      ).then((d) => d.subscriptions),
    enabled: Boolean(user),
  });
}
