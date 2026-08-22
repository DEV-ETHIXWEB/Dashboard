import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiUpload } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type { UserRecord, Project, Task, Ticket, Domain, Report, BudgetItem, Billing, Notification, PaymentSummary } from "@/lib/entities";
import { canSeePage } from "@/lib/permissions";
import type { ClientPageKey, OtpLogEntry } from "@/lib/types";

/**
 * A client only fetches the sections their admin left switched on. The API
 * refuses the rest anyway; this keeps the UI from firing doomed requests and
 * showing error states for pages the user is not meant to have.
 */
function useAllowedPage(page: ClientPageKey) {
  const { user } = useAuth();
  return Boolean(user) && canSeePage(user, page);
}

export function useUsers() {
  return useQuery({ queryKey: ["users"], queryFn: () => api<{ users: UserRecord[] }>("GET", "/users").then((d) => d.users) });
}

export function useOtpLogs() {
  return useQuery({
    queryKey: ["otp-logs"],
    queryFn: () => api<{ logs: OtpLogEntry[] }>("GET", "/auth/otp-logs").then((d) => d.logs),
    // A code now arrives on the `otp` topic the moment it is issued; five
    // second polling was how this used to feel immediate.
    refetchInterval: 60_000,
  });
}

export function useRevealOtpCode() {
  return useMutation({
    mutationFn: (id: string) => api<{ code: string }>("POST", `/auth/otp-logs/${id}/reveal`).then((d) => d.code),
  });
}

export function useProjects() {
  const allowed = useAllowedPage("projects");
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ projects: Project[] }>("GET", "/projects").then((d) => d.projects),
    enabled: allowed,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; type: string; clientId: string; assignedPmId: string | null; status: string; description: string }) =>
      api<{ project: Project }>("POST", "/projects", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Project> }) => api<{ project: Project }>("PUT", `/projects/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api("DELETE", `/projects/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useTasks(projectId?: string) {
  return useQuery({
    queryKey: ["tasks", projectId ?? "all"],
    queryFn: () => api<{ tasks: Task[] }>("GET", projectId ? `/tasks?projectId=${projectId}` : "/tasks").then((d) => d.tasks),
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { projectId: string; name: string; assigneeId: string | null; priority: string; due: string | null }) =>
      api<{ task: Task }>("POST", "/tasks", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Task> }) => api<{ task: Task }>("PUT", `/tasks/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api("DELETE", `/tasks/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      email: string;
      role: string;
      company: string | null;
      password?: string;
      passwordExpiresAt?: number | null;
      allowedPages?: string[] | null;
      /** The one Slack channel a client may read and write. Clients only. */
      slackChannelId?: string | null;
      slackChannelName?: string | null;
      /** Defaults to true on the server: mail the credentials to the new user. */
      sendEmail?: boolean;
    }) =>
      api<{
        user: UserRecord; temporaryPassword: string; emailed: boolean; emailConfigured: boolean;
        slackChannel?: { joined: boolean; message?: string };
      }>(
        "POST",
        "/users",
        body,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      api<{ user: UserRecord; temporaryPassword?: string; emailed?: boolean; emailConfigured?: boolean }>(
        "PUT",
        `/users/${id}`,
        patch,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api("DELETE", `/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useTickets() {
  const allowed = useAllowedPage("tickets");
  return useQuery({
    queryKey: ["tickets"],
    queryFn: () => api<{ tickets: Ticket[] }>("GET", "/tickets").then((d) => d.tickets),
    enabled: allowed,
  });
}

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { subject: string; category: string; description: string; priority?: string; clientId?: string }) =>
      api<{ ticket: Ticket }>("POST", "/tickets", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tickets"] }),
  });
}

export function useUpdateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Ticket> }) => api<{ ticket: Ticket }>("PUT", `/tickets/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tickets"] }),
  });
}

export function useDomains() {
  const allowed = useAllowedPage("domains");
  return useQuery({
    queryKey: ["domains"],
    queryFn: () => api<{ domains: Domain[] }>("GET", "/domains").then((d) => d.domains),
    enabled: allowed,
  });
}

export function useCreateDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      clientId: string; domainName: string; platform: string; hostingProvider: string;
      hostingRegion: string; registrar: string; expiresAt?: string; notes: string;
    }) => api<{ domain: Domain }>("POST", "/domains", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains"] }),
  });
}

export function useUpdateDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Domain> }) => api<{ domain: Domain }>("PUT", `/domains/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains"] }),
  });
}

export function useRenewDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ domain: Domain }>("POST", `/domains/${id}/renew`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains"] }),
  });
}

export function useDeleteDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api("DELETE", `/domains/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains"] }),
  });
}

export function useReports() {
  const allowed = useAllowedPage("reports");
  return useQuery({
    queryKey: ["reports"],
    queryFn: () => api<{ reports: Report[] }>("GET", "/reports").then((d) => d.reports),
    enabled: allowed,
  });
}

export function useUploadReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (formData: FormData) => apiUpload<{ report: Report }>("/reports", formData),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reports"] }),
  });
}

export function useDeleteReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api("DELETE", `/reports/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reports"] }),
  });
}

export function useBudget(clientId?: string) {
  const allowed = useAllowedPage("budget");
  return useQuery({
    queryKey: ["budget", clientId ?? "all"],
    queryFn: () => api<{ items: BudgetItem[] }>("GET", clientId ? `/budget?clientId=${clientId}` : "/budget").then((d) => d.items),
    enabled: allowed,
  });
}

export function useBillingStatus() {
  const allowed = useAllowedPage("billing");
  return useQuery({
    queryKey: ["billing"],
    queryFn: () => api<{ enabled: boolean; billing: Billing | Billing[] }>("GET", "/billing/status"),
    enabled: allowed,
  });
}

/**
 * The real payment history, mirrored from Stripe by the server.
 *
 * Clients get their own; staff get the whole workspace, or one account when a
 * `clientId` is named. The figures are Stripe's, so nothing here is ever
 * reconciled by hand.
 */
export function usePayments(clientId?: string) {
  const allowed = useAllowedPage("billing");
  return useQuery({
    queryKey: ["payments", clientId ?? "all"],
    queryFn: () =>
      api<PaymentSummary>("GET", clientId ? `/billing/payments?clientId=${encodeURIComponent(clientId)}` : "/billing/payments"),
    enabled: allowed,
  });
}

/** Admin-only repair: pull everything Stripe has and mirror it locally. */
export function useSyncStripe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clientId?: string) =>
      api<{ ok: boolean; synced: { name: string; payments?: number; error?: string }[] }>(
        "POST",
        "/billing/sync",
        clientId ? { clientId } : {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["billing"] });
    },
  });
}

/** Opens Stripe's own hosted page, where card details are entered. */
export function useBillingPortal() {
  return useMutation({
    mutationFn: () => api<{ url: string }>("POST", "/billing/portal"),
  });
}

export function useNotifications() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () => api<{ notifications: Notification[] }>("GET", "/notifications").then((d) => d.notifications),
    // Every role now receives notifications -- staff get handover and
    // collaboration requests, not just clients.
    enabled: Boolean(user),
    // Pushed on the `notifications` topic; this is only a safety net.
    refetchInterval: 120_000,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ notification: Notification }>("PATCH", `/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useClearAllNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("DELETE", "/notifications"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}
