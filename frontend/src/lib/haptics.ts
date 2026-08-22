/**
 * The little confirmation a native app gives your thumb.
 *
 * Android fires the vibration motor; iOS Safari has no Vibration API and simply
 * does nothing, which is the correct outcome -- nobody notices a missing tap,
 * everybody notices a buzz they did not ask for. Anyone who has turned motion
 * down in their OS gets silence too.
 */

let allowed: boolean | null = null;

function permitted(): boolean {
  if (allowed != null) return allowed;
  if (typeof window === "undefined" || typeof navigator.vibrate !== "function") {
    allowed = false;
  } else {
    allowed = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  return allowed;
}

/** A tab change, a toggle: the lightest thing the motor can do. */
export function tapFeedback() {
  if (permitted()) navigator.vibrate(8);
}

/** A refresh landing, a sheet snapping shut. */
export function successFeedback() {
  if (permitted()) navigator.vibrate([8, 40, 12]);
}
