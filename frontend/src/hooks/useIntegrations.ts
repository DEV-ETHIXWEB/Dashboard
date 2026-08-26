import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type {
  ClickUpComment, ClickUpMember, ClickUpOverview, ClickUpStatus, ClickUpTask, ClickUpTaskInput,
  ClickUpTree, IntegrationStatus, SlackChannel, SlackFeed, SlackMessage,
  SendSlackMessageInput, ConvertSlackToTaskInput, SendSlackDigestInput,
} from "@/lib/integrations";

/** All integration data is admin-only; gate every query on the role. */
function useIsAdmin() {
  const { user } = useAuth();
  return user?.role === "admin";
}

const STATUS_KEY = ["integrations", "status"];
const fetchStatus = () => api<IntegrationStatus>("GET", "/integrations/status");

export function useIntegrationStatus() {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: fetchStatus,
    enabled: isAdmin,
  });
}

/**
 * Fetch the connection status before anybody asks for it.
 *
 * Every ClickUp and Slack read waits on this answer, because firing a request
 * at an integration nobody has configured only produces an error state for a
 * page that should say "not connected" instead. That gate is right, but it also
 * means opening either screen is two round trips end to end: one to learn
 * ClickUp is connected, and only then one to ask it anything.
 *
 * The status itself is read from the server's own environment -- no upstream
 * call, a handful of booleans -- so it is worth having in hand early. Pointing
 * at the nav row is enough: by the time the page mounts the gate is already
 * open and the real request goes out on the first render rather than the
 * second. On a reload it is already there, having been kept in session storage.
 */
export function usePrefetchIntegrationStatus() {
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  return () => {
    if (!isAdmin) return;
    void qc.prefetchQuery({ queryKey: STATUS_KEY, queryFn: fetchStatus });
  };
}

// --- ClickUp ---------------------------------------------------------------

export function useClickUpOverview(spaceId?: string) {
  const isAdmin = useIsAdmin();
  const { data: status } = useIntegrationStatus();
  return useQuery({
    queryKey: ["integrations", "clickup", "overview", spaceId ?? "all"],
    queryFn: () =>
      api<ClickUpOverview>("GET", spaceId ? `/integrations/clickup/overview?spaceId=${spaceId}` : "/integrations/clickup/overview"),
    enabled: isAdmin && status?.clickup.connected === true,
    retry: false,
  });
}

export function useClickUpTree() {
  const isAdmin = useIsAdmin();
  const { data: status } = useIntegrationStatus();
  return useQuery({
    queryKey: ["integrations", "clickup", "tree"],
    queryFn: () => api<ClickUpTree>("GET", "/integrations/clickup/tree"),
    enabled: isAdmin && status?.clickup.connected === true,
    retry: false,
  });
}

export function useClickUpListTasks(listId: string | null) {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ["integrations", "clickup", "list", listId],
    queryFn: () => api<{ tasks: ClickUpTask[] }>("GET", `/integrations/clickup/lists/${listId}/tasks`).then((d) => d.tasks),
    enabled: isAdmin && Boolean(listId),
    retry: false,
  });
}

export function useClickUpMembers() {
  const isAdmin = useIsAdmin();
  const { data: status } = useIntegrationStatus();
  return useQuery({
    queryKey: ["integrations", "clickup", "members"],
    queryFn: () => api<{ members: ClickUpMember[] }>("GET", "/integrations/clickup/members").then((d) => d.members),
    enabled: isAdmin && status?.clickup.connected === true,
    retry: false,
  });
}

/**
 * Status options for one list.
 *
 * `enabled` is deliberate: a screen of task rows can span dozens of lists, and
 * fetching every one up front burns through ClickUp's 100 requests/minute.
 * Callers pass `enabled: true` only once the user actually opens the dropdown.
 * Statuses barely change, so the result is cached for an hour.
 */
export function useClickUpListStatuses(listId: string | null, enabled = true) {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ["integrations", "clickup", "statuses", listId],
    queryFn: () =>
      api<{ statuses: ClickUpStatus[] }>("GET", `/integrations/clickup/lists/${listId}/statuses`).then((d) => d.statuses),
    enabled: isAdmin && enabled && Boolean(listId),
    gcTime: 60 * 60_000,
    retry: false,
  });
}

export function useClickUpComments(taskId: string | null) {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ["integrations", "clickup", "comments", taskId],
    queryFn: () =>
      api<{ comments: ClickUpComment[] }>("GET", `/integrations/clickup/tasks/${taskId}/comments`).then((d) => d.comments),
    enabled: isAdmin && Boolean(taskId),
    retry: false,
  });
}

// --- ClickUp writes --------------------------------------------------------
// Every write invalidates the whole ClickUp cache: a status change can move a
// task between urgency buckets, lists, and the workload table at once.

export function useCreateClickUpTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, input }: { listId: string; input: ClickUpTaskInput }) =>
      api<{ task: ClickUpTask }>("POST", `/integrations/clickup/lists/${listId}/tasks`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations", "clickup"] }),
  });
}

export function useUpdateClickUpTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, input }: { taskId: string; input: ClickUpTaskInput }) =>
      api<{ task: ClickUpTask }>("PUT", `/integrations/clickup/tasks/${taskId}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations", "clickup"] }),
  });
}

export function useDeleteClickUpTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api("DELETE", `/integrations/clickup/tasks/${taskId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations", "clickup"] }),
  });
}

export function useAddClickUpComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, text }: { taskId: string; text: string }) =>
      api("POST", `/integrations/clickup/tasks/${taskId}/comments`, { text }),
    onSuccess: (_d, { taskId }) => qc.invalidateQueries({ queryKey: ["integrations", "clickup", "comments", taskId] }),
  });
}

// --- Slack -----------------------------------------------------------------

export function useSlackChannels() {
  const isAdmin = useIsAdmin();
  const { data: status } = useIntegrationStatus();
  return useQuery({
    queryKey: ["integrations", "slack", "channels"],
    queryFn: () => api<{ channels: SlackChannel[] }>("GET", "/integrations/slack/channels").then((d) => d.channels),
    enabled: isAdmin && status?.slack.connected === true,
    retry: false,
  });
}

export function useSlackFeed(channelIds: string[], perChannel = 30) {
  const isAdmin = useIsAdmin();
  const { data: status } = useIntegrationStatus();
  const key = [...channelIds].sort().join(",");
  return useQuery({
    queryKey: ["integrations", "slack", "feed", key, perChannel],
    queryFn: () =>
      api<SlackFeed>("GET", `/integrations/slack/feed?channels=${encodeURIComponent(key)}&perChannel=${perChannel}`),
    enabled: isAdmin && status?.slack.connected === true,
    retry: false,
  });
}

export function useSlackChannelMessages(channelId: string | null, limit = 50) {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ["integrations", "slack", "messages", channelId, limit],
    queryFn: () =>
      api<{ messages: SlackMessage[] }>("GET", `/integrations/slack/channels/${channelId}/messages?limit=${limit}`)
        .then((d) => d.messages),
    enabled: isAdmin && Boolean(channelId),
    retry: false,
  });
}

export function useSlackThread(channelId: string | null, messageTs: string | null) {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ["integrations", "slack", "thread", channelId, messageTs],
    queryFn: () =>
      api<{ replies: SlackMessage[] }>("GET", `/integrations/slack/channels/${channelId}/messages/${messageTs}/replies`)
        .then((d) => d.replies),
    enabled: isAdmin && Boolean(channelId) && Boolean(messageTs),
    retry: false,
  });
}

export function useSendSlackMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendSlackMessageInput) =>
      api<{ ok: boolean; ts: string }>("POST", "/integrations/slack/messages", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations", "slack"] }),
  });
}

export function useConvertSlackToTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ConvertSlackToTaskInput) =>
      api<{ task: any }>("POST", "/integrations/slack/convert-to-task", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useSendSlackDigest() {
  return useMutation({
    mutationFn: (input: SendSlackDigestInput) =>
      api<{ ok: boolean }>("POST", "/integrations/slack/send-digest", input),
  });
}

/** Drop the server-side cache, then refetch whatever the page is showing. */
export function useRefreshIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scope?: "slack" | "clickup") =>
      api("POST", scope ? `/integrations/refresh?scope=${scope}` : "/integrations/refresh"),
    onSuccess: (_data, scope) =>
      qc.invalidateQueries({ queryKey: scope ? ["integrations", scope] : ["integrations"] }),
  });
}
