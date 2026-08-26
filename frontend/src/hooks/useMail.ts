import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type { EmailLogEntry, EmailTemplateInfo, EmailTemplatePreview, MailStatus } from "@/lib/mail";

/** The whole Mail page is admin-only; gate every query on the role. */
function useIsAdmin() {
  const { user } = useAuth();
  return user?.role === "admin";
}

export function useMailStatus() {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ["mail", "status"],
    queryFn: () => api<MailStatus>("GET", "/mail/status"),
    enabled: isAdmin,
  });
}

export function useMailTemplates() {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ["mail", "templates"],
    queryFn: () => api<{ templates: EmailTemplateInfo[] }>("GET", "/mail/templates").then((d) => d.templates),
    enabled: isAdmin,
  });
}

export function useMailPreview(key: string | null) {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ["mail", "preview", key],
    queryFn: () => api<EmailTemplatePreview>("GET", `/mail/templates/${key}/preview`),
    enabled: isAdmin && Boolean(key),
  });
}

export function useMailLog(limit = 100) {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ["mail", "log", limit],
    queryFn: () =>
      api<{ entries: EmailLogEntry[]; configured: boolean }>("GET", `/mail/log?limit=${limit}`),
    enabled: isAdmin,
  });
}

/** One logged message with the exact HTML that was rendered for it. */
export function useMailLogEntry(id: string | null) {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ["mail", "log-entry", id],
    queryFn: () => api<{ entry: EmailLogEntry & { html: string | null } }>("GET", `/mail/log/${id}`).then((d) => d.entry),
    enabled: isAdmin && Boolean(id),
  });
}

/** Open a real connection and authenticate, without sending a message. */
export function useVerifyTransport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean; transport: string; note?: string }>("POST", "/mail/verify"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mail", "status"] }),
  });
}

export function useSendTestEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (to: string) => api<{ ok: true; to: string; transport: string }>("POST", "/mail/test", { to }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mail", "log"] }),
  });
}

/** Run the first-response deadline check now instead of waiting for traffic. */
export function useRunSlaSweep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ checked: number; due: number; warned: number }>("POST", "/mail/sla-sweep"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mail", "log"] }),
  });
}

/** Run the domain expiry reminders now instead of waiting for traffic. */
export function useRunDomainSweep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ checked: number; due: number; sent: number; skipped: number }>("POST", "/mail/domain-sweep"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mail", "log"] }),
  });
}

export function useSendProgressDigest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clientId: string) =>
      api<{ ok: boolean; skipped: string | null; to: string; redirectedTo: string | null }>(
        "POST",
        `/mail/digest/${clientId}`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mail", "log"] }),
  });
}
