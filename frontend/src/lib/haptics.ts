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

/*
 * On durations.
 *
 * These started at 8-12ms and could not be felt through a case, which is the
 * same as not being there. A phone's motor is not a speaker: it has to spin up
 * and settle, and anything under roughly 15ms is spent doing that rather than
 * moving. iOS's own taps land around 20-30ms and its notification patterns run
 * past 100ms end to end, so the numbers below are aimed at that, not at the
 * shortest pulse the API will accept.
 *
 * The four levels stay distinguishable by shape as well as length -- one pulse
 * versus three, short gaps versus long -- so a thumb can tell an error from a
 * success without looking. Making them all merely longer would have made them
 * all merely the same.
 */

/** A tab change, a button press: the lightest thing worth feeling. */
export function tapFeedback() {
  if (permitted()) navigator.vibrate(18);
}

/**
 * Crossing a detent: a pull-to-refresh arming, a segmented control landing on a
 * new option. A touch crisper than a plain tap, so the thumb feels the "click".
 */
export function selectionFeedback() {
  if (permitted()) navigator.vibrate(28);
}

/**
 * A decision that cannot be taken back by tapping again -- signing out, or
 * confirming a destructive action. One long thump rather than a pattern: it is
 * meant to land like a switch being thrown, and to be obviously heavier than
 * the tap that opened the dialog.
 */
export function impactFeedback() {
  if (permitted()) navigator.vibrate(55);
}

/** A refresh landing, a sheet snapping shut, something that succeeded. */
export function successFeedback() {
  if (permitted()) navigator.vibrate([22, 45, 36]);
}

/**
 * It worked, but read this: a backup code spent, a quota nearly gone.
 *
 * Warnings used to borrow the error pattern, which was survivable while that
 * pattern was faint. It is not faint any more, and signing in successfully
 * should not buzz like being turned away -- so warnings get their own shape,
 * two pulses between success's rise and error's flat refusal.
 */
export function warningFeedback() {
  if (permitted()) navigator.vibrate([30, 55, 30]);
}

/**
 * Something went wrong: a sign-in refused, a save that would not go through.
 * Three firm buzzes with real gaps -- the pattern a phone uses for "no", and
 * the one thing here that should be impossible to mistake for success.
 */
export function errorFeedback() {
  if (permitted()) navigator.vibrate([45, 70, 45, 70, 60]);
}
