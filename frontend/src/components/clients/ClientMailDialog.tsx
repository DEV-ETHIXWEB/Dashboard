import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Mail, MailX, Send, X } from "lucide-react";
import { useClientMail, useSaveClientMail, useSendWelcome } from "@/hooks/useData";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { UserRecord } from "@/lib/entities";

/**
 * What one client is sent, and whether they are sent anything at all.
 *
 * Two levels, and they are deliberately not the same control. The switch at
 * the top is the one that matters for a client we have not yet agreed terms
 * with: off means nothing reaches them, no matter what any of the rows below
 * say or what a cron job decides at three in the morning. The rows are the
 * ordinary preference -- a paying client who does not want the monthly ads
 * digest -- and they are greyed out while the switch is off, because offering
 * somebody a choice that has no effect is a lie about what the screen does.
 *
 * The list is whatever the server says exists, grouped the way the Mail page
 * groups it. Nothing here is hard-coded, so a template added to the app shows
 * up on this screen without anybody remembering to come back and add it.
 */
export function ClientMailDialog({
  client,
  onClose,
}: {
  client: UserRecord | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useClientMail(client?.id ?? null);
  const save = useSaveClientMail();
  const welcome = useSendWelcome();

  const [enabled, setEnabled] = useState(false);
  const [optOuts, setOptOuts] = useState<string[]>([]);

  // Seeded from the server each time a client is opened, not held across two
  // of them: the draft belongs to the client on screen.
  useEffect(() => {
    if (!data) return;
    setEnabled(data.mailEnabled);
    setOptOuts(data.optOuts);
  }, [data]);

  const dirty = Boolean(
    data && (data.mailEnabled !== enabled || data.optOuts.join() !== [...optOuts].sort().join()),
  );

  function toggleTemplate(key: string, on: boolean) {
    setOptOuts((prev) => {
      const next = new Set(prev);
      if (on) next.delete(key);
      else next.add(key);
      return [...next].sort();
    });
  }

  function commit() {
    if (!client) return;
    save.mutate(
      { id: client.id, mailEnabled: enabled, optOuts },
      {
        onSuccess: (r) => {
          toast.success(
            r.mailEnabled
              ? `${client.name} will now receive email from us.`
              : `${client.name} will not be emailed.`,
          );
          onClose();
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save that"),
      },
    );
  }

  return (
    <Dialog open={Boolean(client)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-xl p-0 gap-0 overflow-hidden border border-border/60 shadow-2xl rounded-2xl bg-card"
      >
        <div className="relative p-6 pb-4 border-b border-border/40 bg-gradient-to-br from-primary/10 via-background to-background">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-xs">
                <Mail className="size-5" />
              </div>
              <div>
                <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
                  Email settings
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  For {client?.name}. Applies to every message this app sends.
                </DialogDescription>
              </div>
            </div>
            <DialogClose className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors">
              <X className="size-4" />
            </DialogClose>
          </div>
        </div>

        <div className="no-scrollbar max-h-[62svh] overflow-y-auto overscroll-contain p-6 space-y-5">
          {isLoading || !data ? (
            <div className="space-y-3">
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-40 w-full rounded-xl" />
            </div>
          ) : (
            <>
              {/* A switch rather than a tick, because this is not one more
                  preference in the list below it: it is whether we are in
                  contact with this client at all. A switch reads as a state
                  the account is in, which is what this is, where a checkbox
                  reads as one item chosen out of several.

                  It sits on the right, apart from the message rows, so the
                  eye does not take it for the first of them. */}
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-4 rounded-xl border p-4 transition-colors select-none",
                  enabled
                    ? "border-primary/30 bg-primary/5"
                    : "border-warning/40 bg-warning/5",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {enabled ? (
                      <Mail className="size-3.5 text-primary" />
                    ) : (
                      <MailX className="size-3.5 text-warning" />
                    )}
                    {enabled ? "This client receives email" : "This client is not emailed"}
                  </span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                    {enabled
                      ? "Everything ticked below is sent as it happens."
                      : "Nothing at all reaches them: no welcome, no reminders, no automatic updates. Held messages are listed on the Mail page so you can see what they would have had."}
                  </span>
                </span>
                <Switch
                  checked={enabled}
                  onCheckedChange={(v: boolean) => setEnabled(v)}
                  aria-label={`Email ${client?.name ?? "this client"}`}
                  className="mt-0.5 shrink-0"
                />
              </label>

              {/* Turning the switch on sends nothing by itself, so the one
                  message that is triggered by an account existing rather than
                  by something happening has to be sendable by hand. */}
              {enabled && data.mailEnabled && !data.welcomeEmailSentAt && (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/20 p-3">
                  <p className="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
                    They have never been welcomed. Turning email on does not send a backlog, so
                    send the welcome when you are ready.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={welcome.isPending}
                    onClick={() =>
                      client &&
                      welcome.mutate(client.id, {
                        onSuccess: () => toast.success("Welcome email sent"),
                        onError: (err) =>
                          toast.error(err instanceof Error ? err.message : "Could not send it"),
                      })
                    }
                    className="h-8 shrink-0 gap-1.5 text-xs"
                  >
                    {welcome.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Send className="size-3.5" />
                    )}
                    Send welcome
                  </Button>
                </div>
              )}

              <div className={cn("space-y-4", !enabled && "pointer-events-none opacity-45")}>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Messages they get
                </p>
                {data.groups.map((group) => (
                  <div key={group.heading} className="rounded-xl border border-border/60 bg-muted/10 p-3">
                    <p className="mb-2 text-xs font-medium">{group.heading}</p>
                    <div className="space-y-1.5">
                      {group.templates.map((template) => {
                        const on = !optOuts.includes(template.key);
                        return (
                          <label
                            key={template.key}
                            className="flex cursor-pointer items-start gap-2.5 rounded-lg px-1 py-1 select-none hover:bg-muted/40"
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={!enabled}
                              onChange={(e) => toggleTemplate(template.key, e.target.checked)}
                              className="mt-0.5 size-3.5 shrink-0 accent-primary cursor-pointer"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block text-xs font-medium">{template.label}</span>
                              {template.description && (
                                <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                                  {template.description}
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <DialogFooter className="m-0 px-6 py-4 bg-muted/30 border-t border-border/40 flex flex-row items-center justify-end gap-2.5 rounded-b-2xl">
          <DialogClose
            render={
              <Button variant="ghost" className="h-9 text-xs px-3.5 text-muted-foreground hover:text-foreground" />
            }
          >
            Cancel
          </DialogClose>
          <Button
            onClick={commit}
            disabled={save.isPending || !dirty}
            className="h-9 px-4 text-xs font-medium gap-1.5 shadow-xs"
          >
            {save.isPending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save email settings"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
