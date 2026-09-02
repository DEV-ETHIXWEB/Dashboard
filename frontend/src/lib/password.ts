import type { CredentialDelivery, CredentialDeliveryStatus, PasswordState, PasswordStatus } from "./types";

/**
 * How each password state is drawn, in one place.
 *
 * The colours are the existing semantic tokens -- success, warning, destructive
 * -- rather than new ones, so a status badge here reads the same as a ticket
 * status or a domain expiry elsewhere in the dashboard. Nothing new is being
 * introduced to the palette for this feature.
 */
export const PASSWORD_TONE: Record<PasswordState, string> = {
  active: "border-success/30 bg-success/10 text-success",
  reset_completed: "border-success/30 bg-success/10 text-success",
  expiring_soon: "border-warning/30 bg-warning/10 text-warning",
  reset_required: "border-destructive/30 bg-destructive/10 text-destructive",
  no_password: "border-border/60 bg-muted text-muted-foreground",
};

/**
 * The one-line explanation under a badge.
 *
 * Written for whoever is looking rather than about the data: an admin scanning
 * a list wants to know what to do about a row, not what the column contains.
 */
export function describePassword(status: PasswordStatus | null | undefined): string {
  if (!status) return "No password information";
  if (!status.policyEnabled) return "Password rotation is switched off for this workspace";

  switch (status.state) {
    case "no_password":
      return "Signs in with Google, so there is no password to rotate";
    case "reset_required":
      return "Expired. They must set a new password before they can do anything else";
    case "expiring_soon":
      return status.daysLeft != null && status.daysLeft <= 1
        ? "Expires today"
        : `Expires in ${status.daysLeft} days`;
    case "reset_completed":
      return "Reset recently, using a link";
    default:
      return status.daysLeft != null
        ? `Good for another ${status.daysLeft} days`
        : "In good standing";
  }
}

/** The words on the badge itself. Short enough for a table cell. */
export function passwordLabel(status: PasswordStatus | null | undefined): string {
  if (!status) return "Unknown";
  if (!status.policyEnabled && status.state === "active") return "Active";
  return status.label;
}

export const DELIVERY_TONE: Record<CredentialDeliveryStatus, string> = {
  scheduled: "border-primary/30 bg-primary/10 text-primary",
  sent: "border-success/30 bg-success/10 text-success",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  cancelled: "border-border/60 bg-muted text-muted-foreground",
};

export const DELIVERY_LABEL: Record<CredentialDeliveryStatus, string> = {
  scheduled: "Scheduled",
  sent: "Sent",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** What a delivery row says it is waiting for, or what went wrong. */
export function describeDelivery(delivery: CredentialDelivery | null | undefined): string | null {
  if (!delivery) return null;
  switch (delivery.status) {
    case "scheduled":
      return delivery.attempts > 0
        ? `Retrying after ${delivery.attempts} failed ${delivery.attempts === 1 ? "attempt" : "attempts"}`
        : "Waiting to be sent";
    case "sent":
      return "The activation link was emailed";
    case "failed":
      return delivery.lastError || "The email could not be delivered";
    case "cancelled":
      return "Called off before it was sent";
    default:
      return null;
  }
}

/**
 * Whether a password clears the rules, checked as it is typed.
 *
 * A deliberately partial mirror of utils/passwordPolicy.js rejectionFor(): it
 * catches the two things somebody can fix while looking at the field, and the
 * server catches everything including these. A form that refused things the
 * server would accept, or accepted things it would refuse, would be worse than
 * one that says nothing -- so this only ever reports what the server also
 * reports.
 */
export function localPasswordProblem(
  password: string,
  { minLength, email = "", name = "" }: { minLength: number; email?: string; name?: string },
): string | null {
  if (!password) return null;
  // Worded as a failure, not as the rule. The hint under these fields already
  // states the rule in almost these words, so repeating it verbatim on the
  // error path left the two indistinguishable -- the message only changed
  // colour, and somebody typing quickly saw nothing happen at all.
  if (password.length < minLength) {
    return `Too short — ${minLength - password.length} more character${minLength - password.length === 1 ? "" : "s"} needed.`;
  }
  if (/^(.)\1*$/.test(password)) return "That is one character repeated.";

  const lowered = password.toLowerCase();
  for (const personal of [String(email).split("@")[0], name]) {
    const candidate = String(personal || "").trim().toLowerCase();
    if (candidate.length >= 4 && lowered.includes(candidate)) {
      return "It cannot contain your own name or email address.";
    }
  }
  return null;
}
