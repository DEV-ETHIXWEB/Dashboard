/**
 * Whether this browser has ever had a session here.
 *
 * The session cookie is httpOnly, which is the point of it -- but it also
 * means the app cannot look at the cookie to work out whether the person
 * arriving is signed in. So every visit had to ask the server, and the login
 * screen sat behind a spinner until the answer came back. On a warm API that
 * is a couple of hundred milliseconds and nobody notices. On a cold one it was
 * thirteen seconds of watching a spinner to be shown a form that never needed
 * the answer in the first place.
 *
 * This is the cheap local half of that question. It is a hint, never an
 * authority: it says only "somebody signed in on this browser at some point",
 * and the server is still the only thing that decides whether they are signed
 * in now. Nothing is stored beyond the flag -- no identity, no token, nothing
 * that matters if it is read.
 *
 * `localStorage` rather than `sessionStorage` deliberately: the case worth
 * fixing is the person opening a new tab, which is exactly what
 * `sessionStorage` forgets.
 */
const KEY = "ew:had-session";

/** Storage throws outright in some locked-down and private-window contexts. */
export function rememberSessionHint(): void {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    /* The hint is an optimisation; losing it costs a spinner, not correctness. */
  }
}

export function clearSessionHint(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* As above. */
  }
}

/**
 * Reading falsely as "no session" is the safe direction: it shows the login
 * form to somebody who may turn out to be signed in, and the moment `/auth/me`
 * answers they are redirected to the portal as before. The opposite mistake --
 * assuming a session -- only ever costs a spinner nobody needed.
 */
export function hadSessionHint(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
