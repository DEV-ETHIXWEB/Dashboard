import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type { TicketStage, TicketTimeline, TicketUpdate } from "@/lib/tickets";

/**
 * Anything that changes a ticket can change its timeline, the ticket list, and
 * the caller's pending-request inbox at once, so writes invalidate all three.
 */
function useTicketWrite<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ticket-timeline"] });
      qc.invalidateQueries({ queryKey: ["tickets"] });
      qc.invalidateQueries({ queryKey: ["ticket-requests"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useTicketStages() {
  return useQuery({
    queryKey: ["ticket-stages"],
    queryFn: () => api<{ stages: TicketStage[] }>("GET", "/tickets/stages").then((d) => d.stages),
    staleTime: Infinity,
  });
}

export function useTicketTimeline(ticketId: string | null) {
  return useQuery({
    queryKey: ["ticket-timeline", ticketId],
    queryFn: () => api<TicketTimeline>("GET", `/tickets/${ticketId}/timeline`),
    enabled: Boolean(ticketId),
  });
}

/** Handover and collaboration requests waiting on the signed-in user. */
export function useMyTicketRequests() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["ticket-requests", "mine"],
    queryFn: () => api<{ requests: TicketUpdate[] }>("GET", "/tickets/requests/mine").then((d) => d.requests),
    enabled: Boolean(user),
    // Covered by the `tickets` topic; kept long as a fallback.
    refetchInterval: 120_000,
  });
}

export function usePostTicketUpdate() {
  return useTicketWrite(
    ({ ticketId, ...body }: { ticketId: string; body?: string; progress?: number; stage?: string }) =>
      api<{ update: TicketUpdate }>("POST", `/tickets/${ticketId}/updates`, body).then((d) => d.update),
  );
}

export function useRequestHandover() {
  return useTicketWrite(({ ticketId, targetUserId, note }: { ticketId: string; targetUserId: string; note?: string }) =>
    api<{ request: TicketUpdate }>("POST", `/tickets/${ticketId}/handover`, { targetUserId, note }),
  );
}

export function useRequestCollaboration() {
  return useTicketWrite(({ ticketId, targetUserId, note }: { ticketId: string; targetUserId: string; note?: string }) =>
    api<{ request: TicketUpdate }>("POST", `/tickets/${ticketId}/collaboration`, { targetUserId, note }),
  );
}

export function useRespondToRequest() {
  return useTicketWrite(({ ticketId, requestId, accept }: { ticketId: string; requestId: string; accept: boolean }) =>
    api<{ request: TicketUpdate }>("POST", `/tickets/${ticketId}/requests/${requestId}/respond`, { accept }),
  );
}

export function useRemoveCollaborator() {
  return useTicketWrite(({ ticketId, userId }: { ticketId: string; userId: string }) =>
    api("DELETE", `/tickets/${ticketId}/collaborators/${userId}`),
  );
}
