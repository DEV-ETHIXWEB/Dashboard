
import type { PublicConfig } from "./types";

let firebaseApp: unknown = null;

let firebaseAuthMod: any = null;

let confirmationResult: any = null;

let recaptchaVerifier: any = null;

export async function loadFirebase(config: NonNullable<PublicConfig["firebaseConfig"]>) {
  if (firebaseApp) return;
  const { initializeApp } = await import(
     "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"
  );
  firebaseAuthMod = await import(
     "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"
  );
  firebaseApp = initializeApp(config);
}

export async function sendPhoneCode(phoneNumber: string, recaptchaContainerId: string) {
  const auth = firebaseAuthMod.getAuth(firebaseApp);
  if (!recaptchaVerifier) {
    recaptchaVerifier = new firebaseAuthMod.RecaptchaVerifier(auth, recaptchaContainerId, { size: "normal" });
  }
  confirmationResult = await firebaseAuthMod.signInWithPhoneNumber(auth, phoneNumber, recaptchaVerifier);
}

export async function confirmPhoneCode(code: string): Promise<string> {
  if (!confirmationResult) throw new Error("Request a code first.");
  const result = await confirmationResult.confirm(code);
  return result.user.getIdToken();
}

export async function sendEmailSignInLink(email: string) {
  const auth = firebaseAuthMod.getAuth(firebaseApp);
  const actionCodeSettings = { url: `${window.location.origin}/verify-email`, handleCodeInApp: true };
  await firebaseAuthMod.sendSignInLinkToEmail(auth, email, actionCodeSettings);
  window.localStorage.setItem("ew_2fa_email", email);
}

export async function completeEmailSignIn(): Promise<string> {
  const auth = firebaseAuthMod.getAuth(firebaseApp);
  if (!firebaseAuthMod.isSignInWithEmailLink(auth, window.location.href)) {
    throw new Error("This does not look like a valid sign-in link.");
  }
  const email = window.localStorage.getItem("ew_2fa_email");
  if (!email) throw new Error("Could not find the email this link was sent to. Please request a new one from the same browser.");
  const result = await firebaseAuthMod.signInWithEmailLink(auth, email, window.location.href);
  return result.user.getIdToken();
}
