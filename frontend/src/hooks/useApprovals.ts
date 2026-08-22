import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type { ApprovalRequest, AuditEntry, Capabilities } from "@/lib/types";

/**
 * A 202 from a write means "held for a second signature", not "done".
 *
 * `api()` resolves on 202 the same as on 200, so without this every gated
 * mutation would report success and the person would walk away believing a
 * change happened that has not. Every caller that can be gated runs its result
 * through here.
 */
export interface HeldResponse {
  pendingApproval?: boolean;
  request?: ApprovalRequest;
  message?: string;
}

export function wasHeld(result: unknown): result is Required<HeldResponse> {
  return Boolean(result && typeof result === "object" && (result as HeldResponse).pendingApproval);
}

/** "Sent for approval" or whatever the caller wants to say on a real success. */
export function heldMessage(result: unknown, done: string): string {
  return wasHeld(result) ? result.message || "Sent to the other admins for approval." : done;
}

function useIsAdmin() {
  const { user } = useAuth();
  return user?.role === "admin";
}

export function useApprovals(status?: string) {
  const enabled = useIsAdmin();
  return useQuery({
    queryKey: ["approvals", status ?? "all"],
    queryFn: () =>
      api<{ requests: ApprovalRequest[]; pending: number; capabilities: Capabilities }>(
        "GET",
        status ? `/approvals?status=${encodeURIComponent(status)}` : "/approvals",
      ),
    enabled,
  });
}

/** Just the count, for the badge on the navigation. */
export function usePendingApprovalCount() {
  const { data } = useApprovals();
  return data?.pending ?? 0;
}

export function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, note }: { id: string; decision: "approve" | "reject"; note?: string }) =>
      api<{ request: ApprovalRequest }>("POST", `/approvals/${id}/${decision}`, note ? { note } : {}),
    onSuccess: () => {
      // A released change can touch anything, so the whole cache is suspect.
      qc.invalidateQueries();
    },
  });
}

export function useCancelApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ request: ApprovalRequest }>("POST", `/approvals/${id}/cancel`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["approvals"] }),
  });
}

/** The super admin's log. Refused for everyone else, so it is not even asked for. */
export function useAuditLog(limit = 200) {
  const { can } = useAuth();
  return useQuery({
    queryKey: ["audit-log", limit],
    queryFn: () => api<{ entries: AuditEntry[]; total: number }>("GET", `/approvals/audit-log?limit=${limit}`),
    enabled: can.canReadAuditLog,
  });
}

/** Appoint a super admin, step one down, or vouch for an admin. */
export function useSetStanding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, superAdmin, trusted }: { id: string; superAdmin?: boolean; trusted?: boolean }) =>
      api<{ user: { id: string; name: string } }>("POST", `/users/${id}/standing`, { superAdmin, trusted }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}
