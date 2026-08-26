import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { canSeePage } from "@/lib/permissions";
import type { ProgressBoard, TicketActivity } from "@/lib/clientProgress";

/**
 * Clients only fetch this when their admin left the section switched on. The
 * API refuses it either way; this keeps the UI from firing a doomed request.
 */
function useAllowed() {
  const { user } = useAuth();
  return Boolean(user) && canSeePage(user, "progress");
}

/** Staff can look at one client's board by id; clients are pinned to their own. */
export function useProgressBoard(clientId?: string | null) {
  const allowed = useAllowed();
  return useQuery({
    queryKey: ["client-progress", clientId ?? "self"],
    queryFn: () =>
      api<ProgressBoard>("GET", clientId ? `/client/progress?clientId=${encodeURIComponent(clientId)}` : "/client/progress"),
    enabled: allowed,
  });
}

export function useTicketActivity(ticketId: string | null) {
  const allowed = useAllowed();
  return useQuery({
    queryKey: ["client-progress", "activity", ticketId],
    queryFn: () => api<TicketActivity>("GET", `/client/tickets/${ticketId}/activity`),
    enabled: allowed && Boolean(ticketId),
  });
}

export function useReplyOnTicket(ticketId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api("POST", `/client/tickets/${ticketId}/reply`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["client-progress"] });
      qc.invalidateQueries({ queryKey: ["tickets"] });
    },
  });
}
