import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type { CredentialDelivery, CredentialDeliveryRow } from "@/lib/types";

/**
 * Scheduled credential deliveries, for the admin screens.
 *
 * Admin-only on the server too, so the query is disabled for everybody else
 * rather than firing a request that can only come back 403 and then showing an
 * error state for a feature that is simply not theirs.
 */
export function useCredentialDeliveries() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["credential-deliveries"],
    queryFn: () =>
      api<{ deliveries: CredentialDeliveryRow[]; emailConfigured: boolean; linkBaseConfigured: boolean }>(
        "GET",
        "/credentials",
      ),
    enabled: user?.role === "admin",
  });
}

/** Both the queries a delivery change makes stale: the list, and the people. */
function useDeliveryInvalidation() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["credential-deliveries"] });
    // The user list carries each account's pending delivery inline, so a
    // change here moves what Client Access and Team are showing.
    qc.invalidateQueries({ queryKey: ["users"] });
  };
}

/** Book a delivery, or move the one already booked. */
export function useScheduleDelivery() {
  const invalidate = useDeliveryInvalidation();
  return useMutation({
    mutationFn: ({ userId, scheduledAt, kind }: { userId: string; scheduledAt: number; kind?: "activation" | "reset" }) =>
      api<{
        delivery: CredentialDelivery;
        rescheduled: boolean;
        emailConfigured: boolean;
        linkBaseConfigured: boolean;
      }>(
        "POST",
        `/credentials/${encodeURIComponent(userId)}`,
        { scheduledAt, ...(kind ? { kind } : {}) },
      ),
    onSuccess: invalidate,
  });
}

export function useCancelDelivery() {
  const invalidate = useDeliveryInvalidation();
  return useMutation({
    mutationFn: (userId: string) =>
      api<{ delivery: CredentialDelivery }>("DELETE", `/credentials/${encodeURIComponent(userId)}`),
    onSuccess: invalidate,
  });
}

/** Send a failed delivery again, now. Answers with whether it worked this time. */
export function useRetryDelivery() {
  const invalidate = useDeliveryInvalidation();
  return useMutation({
    mutationFn: (deliveryId: string) =>
      api<{ delivery: CredentialDelivery; sent: boolean; error: string | null }>(
        "POST",
        `/credentials/${encodeURIComponent(deliveryId)}/retry`,
      ),
    onSuccess: invalidate,
  });
}

/** Run both scheduled sweeps by hand, for a deployment with no live timer. */
export function useRunCredentialSweep() {
  const invalidate = useDeliveryInvalidation();
  return useMutation({
    mutationFn: () =>
      api<{
        credentials: { due: number; sent: number; failed: number };
        passwords: { checked: number; warned: number; required: number };
      }>("POST", "/credentials/run"),
    onSuccess: invalidate,
  });
}
