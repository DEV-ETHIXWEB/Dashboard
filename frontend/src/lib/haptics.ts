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

/** A tab change, a button press: the lightest thing the motor can do. */
export function tapFeedback() {
  if (permitted()) navigator.vibrate(8);
}

/**
 * Crossing a detent: a pull-to-refresh arming, a segmented control landing on a
 * new option. A touch crisper than a plain tap, so the thumb feels the "click".
 */
export function selectionFeedback() {
  if (permitted()) navigator.vibrate(12);
}

/** A refresh landing, a sheet snapping shut, something that succeeded. */
export function successFeedback() {
  if (permitted()) navigator.vibrate([8, 40, 12]);
}

/**
 * Something went wrong: a save that was refused, a form that would not submit.
 * Two firm buzzes -- the pattern a phone uses for "no", distinct from success
 * so the thumb can tell the outcome without the eyes.
 */
export function errorFeedback() {
  if (permitted()) navigator.vibrate([16, 60, 16, 60, 24]);
}
