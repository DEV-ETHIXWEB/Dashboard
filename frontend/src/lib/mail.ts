/** Shapes returned by routes/mail.js. */

// "queued" is written the moment a message is accepted, before anything has
// been sent. It is what the Mail page shows for a message the outbound queue
// is still carrying -- see utils/outbox.js. The same row becomes "sent" or
// "failed" in place rather than a second row appearing beside it.
export type EmailStatus = "queued" | "sent" | "failed" | "skipped";

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

/** Who reads a message: the paying client, our own team, or both. */
export type TemplateAudience = "client" | "team" | "both";

export interface EmailTemplateInfo {
  key: string;
  label: string;
  description: string;
  audience: TemplateAudience;
  group: string;
}

/**
 * A heading and the templates under it, in the order the server sends them.
 *
 * The grouping is the server's, not this page's. It used to be a constant in
 * this file, and every template added after it was written stopped being drawn
 * -- forty-one of fifty-four of them by the end, including every payment,
 * approval, domain and password message. Taking the list from the same place
 * the templates are defined is what stops that happening again.
 */
export interface EmailTemplateGroup {
  heading: string;
  templates: EmailTemplateInfo[];
  audiences: TemplateAudience[];
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

/** What to call each audience in the filter. */
export const AUDIENCE_LABEL: Record<TemplateAudience, string> = {
  client: "Client",
  team: "Team",
  both: "Either",
};

export function statusTone(status: EmailStatus): "success" | "danger" | "muted" {
  if (status === "sent") return "success";
  if (status === "failed") return "danger";
  return "muted";
}

/** Whether this message is still on its way, rather than finished either way. */
export function isPending(status: EmailStatus): boolean {
  return status === "queued";
}
