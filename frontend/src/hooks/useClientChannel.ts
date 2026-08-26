import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { canSeePage } from "@/lib/permissions";

export interface ChannelMessage {
  id: string;
  author: string;
  body: string;
  at: number;
  isBot: boolean;
  /** Written from the portal rather than typed in Slack. */
  fromPortal: boolean;
}

export interface ChannelBoard {
  enabled: boolean;
  channel: { id: string; name: string | null } | null;
  client?: { id: string; name: string };
  messages: ChannelMessage[];
  /** Slack refused the read — usually the bot needs inviting to a private room. */
  slackError?: string;
}

/**
 * The client's own channel.
 *
 * Slack has no webhook pointed at this app, so freshness comes from polling.
 * Fifteen seconds is fast enough to feel like a conversation and slow enough
 * to stay well inside Slack's rate limits with a room full of clients.
 */
export function useClientChannel(clientId?: string | null) {
  const { user } = useAuth();
  const allowed = Boolean(user) && canSeePage(user, "messages");

  return useQuery({
    queryKey: ["client-channel", clientId ?? "self"],
    queryFn: () =>
      api<ChannelBoard>("GET", clientId ? `/client/channel?clientId=${encodeURIComponent(clientId)}` : "/client/channel"),
    enabled: allowed,
    refetchOnWindowFocus: true,
  });
}

export function useSendChannelMessage(clientId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      api<{ ok: boolean; at: number }>(
        "POST",
        clientId ? `/client/channel/messages?clientId=${encodeURIComponent(clientId)}` : "/client/channel/messages",
        { body },
      ),
    onSuccess: () => {
      // Slack takes a moment to make a new message readable back, so the
      // refetch is deliberate rather than optimistic -- a message that appears
      // and then vanishes is worse than one that appears a second late.
      qc.invalidateQueries({ queryKey: ["client-channel"] });
    },
  });
}
