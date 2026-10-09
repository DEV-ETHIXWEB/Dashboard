import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { IconEmblem } from "@/components/icons/ethix";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The frame the Terms and the Privacy Policy share.
 *
 * Deliberately outside AppShell. Both pages are linked from emails, from the
 * plans modal and from the footer of every message we send, and the person
 * opening one is as likely to be signed out as in -- a page that bounced them
 * to a login screen would be a page nobody could read before deciding whether
 * to buy.
 *
 * Plain reading column, the app's own type scale, no sidebar. There is nothing
 * to do on these pages except read them.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-svh bg-secondary/30">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link to="/" className="focus-clear flex items-center gap-2.5" aria-label="Ethixweb">
            <IconEmblem className="size-7 text-primary" />
            <span className="t-heading">Ethixweb</span>
          </Link>
          <Link
            to="/portal"
            className={cn(buttonVariants({ variant: "outline" }), "h-9 px-3.5")}
          >
            Open dashboard
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        {/* The whole point of this notice: nobody should act on this text, or
            publish it, until somebody qualified has read it. It is written to
            describe what the product actually does, which is the useful half
            of the job, and it is not legal advice. */}
        <div className="mb-6 rounded-xl bg-attention-surface px-4 py-3 ring-1 ring-attention-border">
          <p className="t-body font-medium text-attention">Draft, for internal review</p>
          <p className="mt-1 t-body text-attention">
            This text describes how the service actually works and has not been reviewed by a
            lawyer. It needs checking against the law where you operate before it is relied on.
          </p>
        </div>

        <h1 className="t-title">{title}</h1>
        <p className="mt-1 t-caption text-muted-foreground">Last updated {updated}</p>

        <div className="mt-6 flex flex-col gap-6">{children}</div>

        <footer className="mt-10 border-t border-border pt-5">
          <p className="t-caption text-muted-foreground">
            Questions about any of this? Email{" "}
            <a href="mailto:yash@ethixweb.com" className="text-link underline underline-offset-2">
              yash@ethixweb.com
            </a>
            .
          </p>
          <p className="mt-2 t-caption text-muted-foreground">
            <Link to="/terms" className="text-link underline underline-offset-2">
              Terms of Service
            </Link>
            {" · "}
            <Link to="/privacy" className="text-link underline underline-offset-2">
              Privacy Policy
            </Link>
          </p>
        </footer>
      </main>
    </div>
  );
}

/** One numbered section. The heading is what somebody scans for. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="t-heading">{title}</h2>
      <div className="mt-2 flex flex-col gap-2.5 [&_p]:t-prose [&_p]:text-muted-foreground [&_p]:max-w-none">
        {children}
      </div>
    </section>
  );
}

/** A plain list inside a section, with the app's own marker rather than a disc. */
export function Points({ items }: { items: ReactNode[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5">
          <span aria-hidden className="mt-[0.55rem] size-[5px] shrink-0 rounded-[1px] bg-primary" />
          <span className="t-body flex-1 text-muted-foreground">{item}</span>
        </li>
      ))}
    </ul>
  );
}
