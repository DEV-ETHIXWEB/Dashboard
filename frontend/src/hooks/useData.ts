import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiUpload } from "@/lib/api";
import type { UserRecord, Project, Task, Ticket, Domain, Report, BudgetItem, Billing, Notification } from "@/lib/entities";
import type { OtpLogEntry } from "@/lib/types";

export function useUsers() {
  return useQuery({ queryKey: ["users"], queryFn: () => api<{ users: UserRecord[] }>("GET", "/users").then((d) => d.users) });
}

export function useOtpLogs() {
  return useQuery({
    queryKey: ["otp-logs"],
    queryFn: () => api<{ logs: OtpLogEntry[] }>("GET", "/auth/otp-logs").then((d) => d.logs),
    refetchInterval: 5000,
  });
}

// Codes are never included in the list response -- each reveal is its own
// audited request, so there's a real record of which admin looked at which
// code and when, instead of every code sitting in the browser's memory the
// instant the page loads.
export function useRevealOtpCode() {
  return useMutation({
    mutationFn: (id: string) => api<{ code: string }>("POST", `/auth/otp-logs/${id}/reveal`).then((d) => d.code),
  });
}

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => api<{ projects: Project[] }>("GET", "/projects").then((d) => d.projects) });
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
    mutationFn: (body: { name: string; email: string; role: string; company: string | null; password: string }) =>
      api<{ user: UserRecord }>("POST", "/users", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => api<{ user: UserRecord }>("PUT", `/users/${id}`, patch),
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
  return useQuery({ queryKey: ["tickets"], queryFn: () => api<{ tickets: Ticket[] }>("GET", "/tickets").then((d) => d.tickets) });
}

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { subject: string; category: string; description: string; clientId?: string }) =>
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
  return useQuery({ queryKey: ["domains"], queryFn: () => api<{ domains: Domain[] }>("GET", "/domains").then((d) => d.domains) });
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
  return useQuery({ queryKey: ["reports"], queryFn: () => api<{ reports: Report[] }>("GET", "/reports").then((d) => d.reports) });
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
  return useQuery({
    queryKey: ["budget", clientId ?? "all"],
    queryFn: () => api<{ items: BudgetItem[] }>("GET", clientId ? `/budget?clientId=${clientId}` : "/budget").then((d) => d.items),
  });
}

export function useBillingStatus() {
  return useQuery({
    queryKey: ["billing"],
    queryFn: () => api<{ enabled: boolean; billing: Billing | Billing[] }>("GET", "/billing/status"),
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () => api<{ notifications: Notification[] }>("GET", "/notifications").then((d) => d.notifications),
    refetchInterval: 30_000,
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
