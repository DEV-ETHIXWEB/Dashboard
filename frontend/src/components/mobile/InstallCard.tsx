import { useEffect, useState } from "react";
import { Share, SquarePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isIos, isStandalone, type InstallPromptEvent } from "@/lib/pwa";
import { tapFeedback } from "@/lib/haptics";

const DISMISSED_KEY = "ethixweb.install-dismissed";

/**
 * The one nudge toward the home screen, and only after the app has earned it.
 *
 * Nobody installs a portal they have opened once, so this waits for a third
 * visit. Dismissing it is permanent -- a prompt that comes back is an advert.
 */
export function InstallCard() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined" || isStandalone()) return;
    if (localStorage.getItem(DISMISSED_KEY) === "1") return;

    const visits = Number(localStorage.getItem("ethixweb.visits") ?? "0") + 1;
    localStorage.setItem("ethixweb.visits", String(visits));
    if (visits < 3) return;

    setDismissed(false);
    // iOS never fires the install event; it needs the Share-sheet wording.
    if (isIos()) setShowIosHint(true);

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const close = () => {
    setDismissed(true);
    localStorage.setItem(DISMISSED_KEY, "1");
  };

  if (dismissed || (!prompt && !showIosHint)) return null;

  return (
    <div className="mt-4 rounded-2xl border border-border bg-card p-4 md:hidden">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-zinc-950 p-1.5 ring-1 ring-primary/20">
          <img src="/emblem-mark.png" alt="" className="size-full object-contain" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-tight font-semibold">Keep this on your home screen</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {showIosHint ? (
              <>
                Tap <Share aria-hidden className="inline size-3.5 align-[-2px]" /> then{" "}
                <SquarePlus aria-hidden className="inline size-3.5 align-[-2px]" /> Add to Home Screen.
              </>
            ) : (
              "Opens full screen, straight to your account. No app store."
            )}
          </p>
          {prompt && (
            <Button
              size="sm"
              className="mt-3 h-9 px-4 text-xs font-medium"
              onClick={async () => {
                tapFeedback();
                await prompt.prompt();
                const choice = await prompt.userChoice;
                if (choice.outcome === "accepted") close();
                setPrompt(null);
              }}
            >
              Add to home screen
            </Button>
          )}
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Not now"
          className="tap-target focus-clear -mt-2 -mr-2 inline-flex shrink-0 items-center justify-center rounded-xl text-muted-foreground active:bg-secondary"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  );
}
