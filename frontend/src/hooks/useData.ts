import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiUpload } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type { UserRecord, Project, Task, Ticket, Domain, Report, BudgetItem, Billing, Notification, PaymentSummary } from "@/lib/entities";
import { canReadBilling, canSeePage } from "@/lib/permissions";
import type { ClientPageKey, OtpLogEntry, RecoveryCodeStatus } from "@/lib/types";

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
  });
}

export function useRevealOtpCode() {
  return useMutation({
    mutationFn: (id: string) => api<{ code: string }>("POST", `/auth/otp-logs/${id}/reveal`).then((d) => d.code),
  });
}

/**
 * How many backup codes this admin has left. Never the codes -- the server
 * keeps only their hashes and genuinely cannot produce them again.
 */
export function useRecoveryCodeStatus() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["recovery-codes"],
    enabled: user?.role === "admin",
    queryFn: () =>
      api<{ status: RecoveryCodeStatus }>("GET", "/users/me/recovery-codes").then((d) => d.status),
  });
}

/** Replace the set. The plaintext comes back once, and is never fetchable again. */
export function useRegenerateRecoveryCodes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ codes: string[]; status: RecoveryCodeStatus }>("POST", "/users/me/recovery-codes", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recovery-codes"] }),
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
      /**
       * Whether this client may be emailed at all. Off unless this says
       * otherwise, which is the point: an account is created here long before
       * anybody has agreed to pay for a membership.
       */
      mailEnabled?: boolean;
    }) =>
      api<{
        user: UserRecord; temporaryPassword: string; emailed: boolean; emailConfigured: boolean;
        slackChannel?: { joined: boolean; message?: string };
        /** Present when the new account is an administrator. Shown once, never again. */
        recoveryCodes?: string[];
      }>(
        "POST",
        "/users",
        body,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

/** One client's email settings, as the admin screen reads them. */
export interface ClientMailSettings {
  user: { id: string; name: string; email: string };
  mailEnabled: boolean;
  /** Whether their non-essential mail sends itself, or waits for an admin. */
  mailAutomatic: boolean;
  welcomeEmailSentAt: string | null;
  /** When an admin sent the dashboard announcement, or null if never. */
  launchEmailSentAt: string | null;
  optOuts: string[];
  groups: {
    heading: string;
    essential: boolean;
    templates: {
      key: string;
      label: string;
      description?: string;
      enabled: boolean;
      /** Sends itself even on manual: money, access, and anything they caused. */
      essential: boolean;
    }[];
  }[];
}

/**
 * What this client is sent, and whether they are sent anything.
 *
 * Fetched per client rather than listed with everyone, because the template
 * list is sixty rows long and nobody is comparing two clients' settings side
 * by side.
 */
export function useClientMail(clientId: string | null) {
  return useQuery({
    queryKey: ["client-mail", clientId],
    queryFn: () => api<ClientMailSettings>("GET", `/users/${clientId}/mail`),
    enabled: Boolean(clientId),
  });
}

export function useSaveClientMail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string;
      mailEnabled?: boolean;
      mailAutomatic?: boolean;
      optOuts?: string[];
    }) =>
      api<{ mailEnabled: boolean; mailAutomatic: boolean; optOuts: string[] }>("PUT", `/users/${id}/mail`, body),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["client-mail", vars.id] });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

/**
 * Send the dashboard announcement to one client.
 *
 * The only message that reaches a client who is not being emailed yet, and it
 * only ever goes because somebody pressed the button. Nothing schedules this.
 */
export function useSendAnnouncement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true; sentAt: string; to: string }>("POST", `/users/${id}/announce`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["client-mail", id] });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

/** Send the welcome email on purpose. Turning email on never sends it. */
export function useSendWelcome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>("POST", `/users/${id}/welcome`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["client-mail", id] });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
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
    mutationFn: (body: {
      subject: string;
      category: string;
      description: string;
      priority?: string;
      clientId?: string;
      /** Agree to be quoted for one past the included allowance. */
      acceptExtraCharge?: boolean;
      /** Hold it until the allowance resets instead. */
      queueForNextPeriod?: boolean;
    }) =>
      api<{
        ticket?: Ticket;
        chargedAsExtra?: boolean;
        queued?: { id: string };
        message?: string;
        /**
         * Set when the server lowered the priority the client asked for.
         * A guaranteed response time is what Unlimited is sold on, so a
         * client's own ceiling is their plan's -- and an outage is never
         * capped on any plan. Carried back so the form can say so rather than
         * silently ignoring what somebody chose.
         */
        priorityCapped?: {
          requested: string;
          applied: string;
          message: string;
          recommended: string;
        };
      }>(
        "POST",
        "/tickets",
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tickets"] });
      // The meter on the billing page and the one in this form read the same
      // record, so both have to notice that an update was just spent.
      qc.invalidateQueries({ queryKey: ["membership"] });
      qc.invalidateQueries({ queryKey: ["queued-requests"] });
    },
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

/**
 * Record that a domain was renewed. It does not renew one.
 *
 * Nothing in this application talks to a registrar. This moves the expiry date
 * in our own records so the warnings stop firing for a domain somebody has
 * already renewed elsewhere -- which is useful, and is not what the word
 * "renew" promises on a button.
 */
export function useRecordDomainRenewal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ domain: Domain }>("POST", `/domains/${id}/record-renewal`),
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
  const { user } = useAuth();
  // Both checks, because both can refuse: a client can have Billing switched
  // off for them, and a staff role can be refused billing outright.
  const allowed = useAllowedPage("billing") && canReadBilling(user);
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
  const { user } = useAuth();
  const allowed = useAllowedPage("billing") && canReadBilling(user);
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

/** One entry in the admin's list of Stripe customers to file a client under. */
export interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: string | null;
  delinquent: boolean;
  linkedClientId: string | null;
}

/**
 * Every customer on the Stripe account, admin-only.
 *
 * Client emails and Stripe customer emails are two address books nobody keeps
 * in step, so which client a customer belongs to is stated by an admin rather
 * than guessed from an address.
 */
export function useStripeCustomers(enabled = true) {
  const { user } = useAuth();
  // Shares a query key with the Billing page's own call, so this costs nothing.
  // Without it the list was asked for whenever an admin opened Billing, and a
  // deployment with no Stripe key answered 503 every time -- a failed request
  // in the console on a page that was working perfectly well without it.
  const { data: billing } = useBillingStatus();
  return useQuery({
    queryKey: ["stripe-customers"],
    queryFn: () => api<{ customers: StripeCustomer[] }>("GET", "/billing/customers").then((d) => d.customers),
    enabled: enabled && user?.role === "admin" && billing?.enabled === true,
    staleTime: 60_000,
  });
}

/** File a client under a Stripe customer, or pass null to unfile them. */
export function useLinkStripeCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { clientId: string; stripeCustomerId: string | null }) =>
      api<{ ok: boolean; payments: number; customerName?: string | null }>("POST", "/billing/link", vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["billing"] });
      qc.invalidateQueries({ queryKey: ["stripe-customers"] });
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
