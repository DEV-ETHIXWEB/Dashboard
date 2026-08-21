/**
 * Home-screen install and the offline shell.
 *
 * The service worker only exists in a real build. In dev it is skipped, and any
 * worker left over from a previous build is unregistered, so a stale bundle can
 * never shadow what Vite is serving.
 */

export function registerServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  if (import.meta.env.DEV) {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // No offline shell then. Everything else works exactly as before.
    });
  });
}

/** Called on sign-out: leave nothing warm behind on a shared phone. */
export function clearOfflineCaches() {
  navigator.serviceWorker?.controller?.postMessage({ type: "clear-caches" });
}

/** True when the app is running from the home screen rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari predates display-mode and still reports this instead.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** iOS has no install prompt event; it needs the Share-sheet instructions. */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
