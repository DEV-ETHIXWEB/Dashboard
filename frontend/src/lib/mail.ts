/** Shapes returned by routes/mail.js. */

export type EmailStatus = "sent" | "failed" | "skipped";

export interface EmailLogEntry {
  id: string;
  toEmails: string;
  subject: string;
  template: string;
  status: EmailStatus;
  transport: string;
  error: string | null;
  entity: string | null;
  entityId: string | null;
  createdAt: string;
  hasHtml: boolean;
}

export interface EmailTemplateInfo {
  key: string;
  label: string;
  description: string;
}

export interface EmailTemplatePreview {
  key: string;
  label: string;
  subject: string;
  html: string;
  text: string;
}

export interface SmtpSummary {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  hasPassword: boolean;
}

export interface MailStatus {
  configured: boolean;
  transport: "smtp2go" | "smtp" | "webhook" | "none" | string;
  from: string;
  adminInboxes: string[];
  adminCount: number;
  extraRecipients: string[];
  smtp: SmtpSummary | null;
}

export const TRANSPORT_LABEL: Record<string, string> = {
  smtp2go: "SMTP2GO API",
  smtp: "SMTP",
  webhook: "Custom webhook",
  none: "Not configured",
};

/**
 * What to put in the server environment to turn mail on. Shown verbatim when
 * no transport is configured, so an admin can self-serve without the README.
 */
export const MAIL_SETUP = {
  vars: [
    { key: "SMTP2GO_API_KEY", hint: "From SMTP2GO -> Sending -> API Keys. Give it the /email/send permission." },
    { key: "MAIL_FROM", hint: 'Display name and address, e.g. EthixWeb <noreply@ethixwebdashboard.com>. The domain must be verified under SMTP2GO -> Sending -> Verified Senders.' },
    { key: "APP_BASE_URL", hint: "Public URL of this dashboard. Email buttons and the emblem link back to it.", optional: true },
    { key: "MAIL_TRANSPORT", hint: "Leave empty. Set to smtp2go, smtp, or webhook only to force one when several are configured.", optional: true },
  ],
  steps: [
    "Add the variables above to the server environment (.env locally, project settings on Vercel).",
    "Restart the server so it picks them up.",
    "Come back here and press Verify connection, then Send test.",
  ],
};

/** Which templates belong to which part of the product, for grouping. */
export const TEMPLATE_GROUPS: { heading: string; keys: string[] }[] = [
  { heading: "Tickets", keys: ["new_ticket_staff", "ticket_receipt_client", "ticket_assigned", "ticket_status", "ticket_comment", "ticket_request", "sla_warning"] },
  { heading: "Accounts", keys: ["login_code", "credentials", "admin_roster"] },
  { heading: "Summaries", keys: ["progress_digest", "test"] },
];

export function statusTone(status: EmailStatus): "success" | "danger" | "muted" {
  if (status === "sent") return "success";
  if (status === "failed") return "danger";
  return "muted";
}
