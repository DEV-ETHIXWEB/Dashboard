import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type {
  ClickUpComment, ClickUpMember, ClickUpOverview, ClickUpStatus, ClickUpTask, ClickUpTaskInput,
  ClickUpTree, IntegrationStatus, SlackChannel, SlackFeed, SlackMessage,
} from "@/lib/integrations";

/** All integration data is admin-only; gate every query on the role. */
function useIsAdmin() {
  const { user } = useAuth();
  return user?.role === "admin";
}

export function useIntegrationStatus() {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ["integrations", "status"],
    queryFn: () => api<IntegrationStatus>("GET", "/integrations/status"),
    enabled: isAdmin,
    staleTime: 5 * 60_000,
  });
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
    staleTime: 60_000,
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
    staleTime: 10 * 60_000,
    retry: false,
  });
}

export function useClickUpListTasks(listId: string | null) {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ["integrations", "clickup", "list", listId],
    queryFn: () => api<{ tasks: ClickUpTask[] }>("GET", `/integrations/clickup/lists/${listId}/tasks`).then((d) => d.tasks),
    enabled: isAdmin && Boolean(listId),
    staleTime: 60_000,
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
    staleTime: 10 * 60_000,
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
    staleTime: 60 * 60_000,
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
    staleTime: 60_000,
    retry: false,
  });
}

// --- ClickUp writes --------------------------------------------------------
// Every write invalidates the whole ClickUp cache: a status change can move a
// task between urgency buckets, lists, and the workload table at once.

function useClickUpWrite<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations", "clickup"] }),
  });
}

export function useCreateClickUpTask() {
  return useClickUpWrite(({ listId, input }: { listId: string; input: ClickUpTaskInput }) =>
    api<{ task: ClickUpTask }>("POST", `/integrations/clickup/lists/${listId}/tasks`, input).then((d) => d.task),
  );
}

export function useUpdateClickUpTask() {
  return useClickUpWrite(({ taskId, input }: { taskId: string; input: ClickUpTaskInput }) =>
    api<{ task: ClickUpTask }>("PUT", `/integrations/clickup/tasks/${taskId}`, input).then((d) => d.task),
  );
}

export function useDeleteClickUpTask() {
  return useClickUpWrite((taskId: string) => api("DELETE", `/integrations/clickup/tasks/${taskId}`));
}

export function useAddClickUpComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, text }: { taskId: string; text: string }) =>
      api("POST", `/integrations/clickup/tasks/${taskId}/comments`, { text }),
    onSuccess: (_d, { taskId }) =>
      qc.invalidateQueries({ queryKey: ["integrations", "clickup", "comments", taskId] }),
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
    staleTime: 10 * 60_000,
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
    staleTime: 2 * 60_000,
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
    staleTime: 2 * 60_000,
    retry: false,
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
