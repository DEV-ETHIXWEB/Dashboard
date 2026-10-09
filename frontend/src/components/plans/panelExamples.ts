/**
 * What each locked panel shows instead of real rows.
 *
 * These are examples and are labelled as examples on every single row. They
 * exist because a cover over an empty box tells a client nothing about what
 * they would be buying, and a screenshot of somebody else's dashboard tells
 * them less. What they must never do is read as this client's own data -- so
 * the dates are relative words rather than plausible timestamps, the figures
 * are round, and the "Example" tag travels with each row rather than sitting
 * once at the top where it scrolls away.
 *
 * A client who upgrades sees this panel again with their own rows in it, or an
 * honest empty state if we have not done the work yet. Never these.
 */

export interface PanelExample {
  title: string;
  detail: string;
  when: string;
  status?: string;
}

export interface PanelCopy {
  /** The panel's own heading, the same one a paying client sees. */
  title: string;
  /** One line on what it is for. */
  description: string;
  /** One line on why it is worth paying for. Shown only in the locked state. */
  benefit: string;
  /** What a paying client sees before we have logged anything. */
  empty: string;
  examples: PanelExample[];
}

export const PANEL_COPY: Record<string, PanelCopy> = {
  daily_backups: {
    title: "Backups",
    description: "A copy of your whole site, taken every day.",
    benefit:
      "If anything goes wrong, we put yesterday's site back. Without backups, a bad update means rebuilding.",
    empty: "No backups recorded yet. Your first one appears here within a day.",
    examples: [
      { title: "Full site backup", detail: "Files and database", when: "Yesterday", status: "Stored" },
      { title: "Full site backup", detail: "Files and database", when: "2 days ago", status: "Stored" },
      { title: "Full site backup", detail: "Files and database", when: "3 days ago", status: "Stored" },
    ],
  },

  uptime_monitoring: {
    title: "Uptime",
    description: "We check your site is answering, around the clock.",
    benefit:
      "If your site goes down at 2am, we know before your customers do. Nobody has to notice and call us.",
    empty: "No checks recorded yet. Monitoring starts within a day of your plan.",
    examples: [
      { title: "All checks passed", detail: "Checked every 5 minutes", when: "Last 30 days", status: "100%" },
      { title: "Brief slowdown", detail: "Recovered on its own after 2 minutes", when: "Last month", status: "Resolved" },
    ],
  },

  advanced_security: {
    title: "Security",
    description: "Firewall, malware scans and security patches.",
    benefit:
      "Most sites are attacked by machines, not people, and the fix is cheap before and expensive after.",
    empty: "No scans recorded yet. Your first scan runs within a week.",
    examples: [
      { title: "Malware scan", detail: "Nothing found", when: "This week", status: "Clean" },
      { title: "Security patch applied", detail: "Contact form library", when: "Last month", status: "Patched" },
      { title: "Firewall blocked 1,200 attempts", detail: "Automated login attempts", when: "Last month" },
    ],
  },

  organic_seo: {
    title: "SEO work log",
    description: "On-page fixes, meta tags and sitemaps, written down.",
    benefit:
      "Your site keeps bringing in calls because somebody keeps working on it, and you can see exactly what that was.",
    empty: "No SEO work logged yet. We write up each change here as we make it.",
    examples: [
      { title: "Page titles rewritten", detail: "Services and contact pages", when: "This month" },
      { title: "Sitemap submitted", detail: "Resubmitted after the new pages went live", when: "This month" },
      { title: "Image alt text added", detail: "28 images across the gallery", when: "Last month" },
    ],
  },

  speed_optimisation: {
    title: "Performance",
    description: "How fast your site loads, and what we did about it.",
    benefit:
      "A slow site loses people before it has said anything. We keep it quick as it grows.",
    empty: "No performance checks recorded yet. Your first one runs within a week.",
    examples: [
      { title: "Images compressed", detail: "Home page now loads about a second faster", when: "This month" },
      { title: "Page speed check", detail: "Home page, mobile", when: "This month", status: "Good" },
    ],
  },

  software_plugin_updates: {
    title: "Maintenance log",
    description: "Software and plugin updates, as we apply them.",
    benefit:
      "Out-of-date plugins are how most sites get broken into. We keep them current so you do not have to.",
    empty: "No updates logged yet. We write up each one here as we apply it.",
    examples: [
      { title: "5 plugins updated", detail: "Checked the site afterwards, all working", when: "This month", status: "Done" },
      { title: "Platform update applied", detail: "Security release", when: "Last month", status: "Done" },
    ],
  },

  monthly_report: {
    title: "Monthly reports",
    description: "What we did last month, and what it changed.",
    benefit:
      "One page a month telling you what the site did and what we did to it, instead of wondering.",
    empty: "No monthly reports yet. Your first one arrives at the end of the month.",
    examples: [
      { title: "Monthly report", detail: "Visits, calls, and the work we did", when: "Last month", status: "PDF" },
      { title: "Monthly report", detail: "Visits, calls, and the work we did", when: "2 months ago", status: "PDF" },
    ],
  },

  monthly_health_check: {
    title: "Health check",
    description: "A look over the whole site, once a month.",
    benefit:
      "Small problems get found while they are still small, instead of the week your busy season starts.",
    empty: "No health checks recorded yet. Your first one happens within the month.",
    examples: [
      { title: "Monthly health check", detail: "Links, forms, speed and backups all checked", when: "This month", status: "All clear" },
      { title: "Monthly health check", detail: "Found and fixed a broken contact form", when: "Last month", status: "Fixed" },
    ],
  },
};
