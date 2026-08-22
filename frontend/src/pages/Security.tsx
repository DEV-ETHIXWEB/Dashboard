import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Copy, Download, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useRecoveryCodeStatus, useRegenerateRecoveryCodes } from "@/hooks/useData";
import { useAuth } from "@/context/AuthContext";
import { formatDateTime } from "@/lib/format";
import { tapFeedback } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/**
 * Backup sign-in codes, for administrators.
 *
 * The page exists because of one scenario: the mail transport is down, every
 * admin happens to be signed out, and the emailed code that finishes an admin
 * sign-in never arrives. The Login Codes page is no help — reaching it means
 * already being signed in. These codes are the way back into the building.
 *
 * They are shown exactly once, here, at the moment they are generated. The
 * server keeps only their hashes, so nothing can re-display them afterwards —
 * which is the point. A screen that could show them again would be as good as
 * the codes themselves.
 */
export default function Security() {
  const { user } = useAuth();
  const { data: status, isLoading, isError, error, refetch } = useRecoveryCodeStatus();
  const regenerate = useRegenerateRecoveryCodes();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const remaining = status?.remaining ?? 0;
  const hasCodes = (status?.total ?? 0) > 0;
  const runningLow = hasCodes && remaining <= 2;

  async function doRegenerate() {
    tapFeedback();
    try {
      const result = await regenerate.mutateAsync();
      setCodes(result.codes);
      setConfirming(false);
      setCopied(false);
      toast.success("New backup codes generated. Save them now — this is the only time they are shown.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not generate backup codes");
    }
  }

  function copyAll() {
    if (!codes) return;
    navigator.clipboard.writeText(codes.join("\n")).then(
      () => {
        setCopied(true);
        toast.success("Copied to the clipboard");
      },
      () => toast.error("Could not copy — select the codes and copy them by hand"),
    );
  }

  function downloadAll() {
    if (!codes) return;
    const body = [
      `EthixWeb CRM — backup sign-in codes for ${user?.email ?? "your account"}`,
      `Generated ${formatDateTime(Date.now())}`,
      "",
      "Each code works once, in place of the emailed sign-in code.",
      "Keep them somewhere you can reach without this dashboard.",
      "",
      ...codes,
    ].join("\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "ethixweb-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (isError) return <ErrorState error={error} onRetry={refetch} />;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageHeader
        title="Security"
        description="Backup codes that get you into your account when email is not working."
      />

      {/* The codes, the one time they are ever visible. */}
      {codes && (
        <Card className="mb-5 border-primary/40 bg-primary/[0.03]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4 text-primary" />
              Your new backup codes
            </CardTitle>
            <CardDescription>
              Save these somewhere you can reach <strong>without</strong> this dashboard — a password manager, or
              printed and locked away. They are not shown again, and any earlier set has stopped working.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {codes.map((code) => (
                <li
                  key={code}
                  className="rounded-md border border-border/70 bg-background px-3 py-2 text-center font-mono text-sm tracking-widest"
                >
                  {code}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={copyAll} className="cursor-pointer">
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy all"}
              </Button>
              <Button type="button" variant="outline" onClick={downloadAll} className="cursor-pointer">
                <Download className="size-4" />
                Download
              </Button>
              <Button type="button" variant="ghost" onClick={() => setCodes(null)} className="cursor-pointer">
                I have saved them
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-primary" />
            Backup sign-in codes
          </CardTitle>
          <CardDescription>
            You sign in with your password and a code emailed to you. If email is not reaching you, a backup code
            takes the place of that emailed code. Each one works once.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div
              className={cn(
                "rounded-md border px-4 py-3",
                hasCodes && !runningLow && "border-success/30 bg-success/5",
                runningLow && "border-warning/40 bg-warning/5",
                !hasCodes && "border-destructive/40 bg-destructive/5",
              )}
            >
              {!hasCodes ? (
                <p className="flex items-start gap-2 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    <strong>You have no backup codes.</strong> If email stops reaching you while you are signed
                    out, you will not be able to get back in. Generate a set now.
                  </span>
                </p>
              ) : (
                <p className="text-sm">
                  <strong>
                    {remaining} of {status?.total} codes remaining
                  </strong>
                  {status?.used ? ` — ${status.used} already used` : null}
                  {status?.generatedAt ? (
                    <span className="block text-muted-foreground">
                      Generated {formatDateTime(new Date(status.generatedAt).getTime())}
                    </span>
                  ) : null}
                  {runningLow && (
                    <span className="mt-1 block text-warning">
                      Running low. Generate a fresh set before you run out.
                    </span>
                  )}
                </p>
              )}
            </div>
          )}

          {/* While a fresh set is on screen it is the only copy that will ever
              exist -- so replacing it is not offered at all until the reader
              says they have saved it. Neither a confirm prompt nor a button
              that quietly regenerates belongs under codes nobody has written
              down yet. */}
          {codes ? (
            <p className="text-sm text-muted-foreground">
              Save the codes above, then choose <strong>I have saved them</strong>. Replacing the set again is
              offered once they are out of the way.
            </p>
          ) : confirming ? (
            <div className="rounded-md border border-border bg-secondary/40 px-4 py-3">
              <p className="text-sm">
                Generating a new set <strong>immediately stops every code you already have</strong> from working.
                If you have an old list written down, throw it away afterwards.
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  type="button"
                  onClick={doRegenerate}
                  disabled={regenerate.isPending}
                  className="cursor-pointer"
                >
                  {regenerate.isPending && <Loader2 className="size-4 animate-spin" />}
                  Yes, replace them
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setConfirming(false)}
                  className="cursor-pointer"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button
                type="button"
                onClick={() => (hasCodes ? setConfirming(true) : doRegenerate())}
                disabled={regenerate.isPending}
                className="cursor-pointer"
              >
                {regenerate.isPending && <Loader2 className="size-4 animate-spin" />}
                {hasCodes ? "Generate a new set" : "Generate backup codes"}
              </Button>
              <p className="mt-2 text-xs text-muted-foreground">
                The other administrators are told whenever a set is generated or used. That is deliberate: a
                backup code being used is worth somebody noticing.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
