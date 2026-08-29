import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, FileWarning, Loader2 } from "lucide-react";
import { useReports } from "@/hooks/useData";
import { useAuth } from "@/context/AuthContext";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button, buttonVariants } from "@/components/ui/button";
import { apiUrl } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { plainDate } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * What an iframe can actually render. Everything else is a download.
 *
 * Must stay in step with VIEWABLE in routes/reports.js -- the server decides
 * what it will serve inline, and a type listed only here renders an empty
 * frame. SVG is on neither list: it is a document that can carry script, and
 * the upload allowlist no longer accepts one.
 */
const VIEWABLE = [
  "application/pdf",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/**
 * A document, on its own page.
 *
 * "Open" used to be a link to the file with `Content-Disposition: inline`,
 * which is the correct header and still downloads for anybody whose browser is
 * set to "download PDFs instead of opening them" -- a default in some Chrome
 * builds. A header is a request; this is not.
 *
 * Rendering it here also gives Open something to mean that Download does not:
 * you stay inside the portal, with the document's name, size, and date around
 * it, and a way back to the list.
 */
export default function DocumentView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: reports, isLoading, isError, error, refetch } = useReports();

  const report = useMemo(() => (reports ?? []).find((r) => r.id === id), [reports, id]);

  const isStaff = user != null && user.role !== "client";
  // `hasFile === false` means the record outlived its bytes -- seeded or
  // migrated rows do this. Showing the frame anyway renders a browser error
  // page inside the app, which reads as the app being broken.
  const missingFile = report?.hasFile === false;
  const viewable = report ? VIEWABLE.includes(report.mimeType || "") && !missingFile : false;
  const src = report ? apiUrl(`/reports/${report.id}/download?disposition=inline`) : "";

  if (isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <ErrorState error={error} onRetry={() => refetch()} />
      </div>
    );
  }

  if (!report) {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <EmptyState
          icon={FileWarning}
          title="That document is not here"
          description="It may have been deleted, or it belongs to another account."
          action={
            <Button variant="secondary" className="mt-2 h-10 px-4" onClick={() => navigate("/portal/reports")}>
              Back to documents
            </Button>
          }
        />
      </div>
    );
  }

  const meta = [
    report.category,
    isStaff ? null : null,
    formatBytes(report.sizeBytes),
    `Added ${plainDate(report.createdAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mx-auto w-full max-w-5xl">
      <Link
        to="/portal/reports"
        className="focus-clear -ml-2 mb-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 t-caption text-muted-foreground hover:text-foreground coarse:h-11"
      >
        <ArrowLeft aria-hidden className="size-4" />
        All documents
      </Link>

      <PageHeader
        title={report.name}
        description={meta}
        actions={
          <a
            href={apiUrl(`/reports/${report.id}/download`)}
            download={report.name}
            className={cn(buttonVariants({ variant: "outline" }), "h-10 gap-1.5 px-4 coarse:h-11")}
          >
            <Download aria-hidden className="size-4" />
            Download
          </a>
        }
      />

      {missingFile ? (
        <EmptyState
          icon={FileWarning}
          title="The file itself is missing"
          description="This document is on the record but its contents were never stored. Ask whoever added it to upload it again."
        />
      ) : viewable ? (
        <>
          {/*
            An iframe, not <object>: the app's CSP sets `object-src 'none'`, so
            an <object> would render nothing at all here.

            This used to carry sandbox="allow-scripts", which was a mistake in
            two directions. A sandbox without allow-same-origin gives the frame
            an opaque origin, and a SameSite=Lax session cookie will not travel
            into one -- so this request arrived unauthenticated and the frame
            showed a 401 in every Chromium browser. Brave went further and
            refused to run its PDF viewer in an opaque-origin frame at all,
            which is the "blocked by Brave" panel people were seeing.

            It was also guarding a door that is already shut. The sandbox was
            added when an SVG could be uploaded and served back inline; today
            ALLOWED_UPLOADS in routes/reports.js will not accept one, and
            VIEWABLE will not serve one. What is left -- PDF, text, CSV, and
            raster images -- cannot execute in a document context. The PDF is
            the only one carrying a scripting engine, and it runs inside the
            browser's own viewer, with no reach into this page.

            The boundary that actually holds is on the server: a MIME
            allowlist, unknown types forced to application/octet-stream, and a
            global nosniff header.
          */}
          <iframe
            src={src}
            title={report.name}
            referrerPolicy="no-referrer"
            className="h-[75svh] w-full rounded-2xl border border-border bg-card"
          />
          {/* Both Brave and Chrome have a setting that downloads PDFs instead
              of ever rendering them, and no attribute here overrides it. When
              that is on, the frame above is blank and this is the way out. */}
          <p className="mt-2 t-caption text-muted-foreground">
            Not showing?{" "}
            <a
              href={src}
              target="_blank"
              rel="noreferrer"
              className="focus-clear rounded underline underline-offset-2 hover:text-foreground"
            >
              Open it in a new tab
            </a>{" "}
            — some browsers are set to download documents rather than display them.
          </p>
        </>
      ) : (
        <EmptyState
          icon={FileWarning}
          title="This one cannot be shown here"
          description={`${report.mimeType || "This file type"} needs to be opened in its own application. Downloading it takes a second.`}
          action={
            <a
              href={apiUrl(`/reports/${report.id}/download`)}
              download={report.name}
              className={cn(buttonVariants(), "mt-2 h-11 gap-1.5 px-4")}
            >
              <Download aria-hidden className="size-4" />
              Download it
            </a>
          }
        />
      )}
    </div>
  );
}
