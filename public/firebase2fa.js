'use strict';

// Thin wrapper around the Firebase client SDK for 2FA. Loaded dynamically
// (via ES module import from Firebase's CDN) only when APP_CONFIG says
// Firebase is configured -- pages that never touch 2FA never pay for this.
//
// Phone: real 6-digit SMS code via Firebase Phone Auth (reCAPTCHA + SMS).
// Email: Firebase's native email-based second factor is a secure sign-in
// LINK, not a typed code (a real numeric email code would need a separate
// transactional email provider wired up server-side) -- this is labeled
// clearly in the UI so it isn't presented as something it's not.

let firebaseApp = null;
let firebaseAuthMod = null;
let confirmationResult = null;
let recaptchaVerifier = null;

async function loadFirebase(config) {
  if (firebaseApp) return;
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
  firebaseAuthMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
  firebaseApp = initializeApp(config);
}

async function sendPhoneCode(phoneNumber, recaptchaContainerId) {
  const auth = firebaseAuthMod.getAuth(firebaseApp);
  if (!recaptchaVerifier) {
    recaptchaVerifier = new firebaseAuthMod.RecaptchaVerifier(auth, recaptchaContainerId, { size: 'normal' });
  }
  confirmationResult = await firebaseAuthMod.signInWithPhoneNumber(auth, phoneNumber, recaptchaVerifier);
}

async function confirmPhoneCode(code) {
  if (!confirmationResult) throw new Error('Request a code first.');
  const result = await confirmationResult.confirm(code);
  return result.user.getIdToken();
}

async function sendEmailSignInLink(email) {
  const auth = firebaseAuthMod.getAuth(firebaseApp);
  const actionCodeSettings = { url: `${window.location.origin}/verify-email.html`, handleCodeInApp: true };
  await firebaseAuthMod.sendSignInLinkToEmail(auth, email, actionCodeSettings);
  window.localStorage.setItem('ew_2fa_email', email);
}

async function completeEmailSignIn() {
  const auth = firebaseAuthMod.getAuth(firebaseApp);
  if (!firebaseAuthMod.isSignInWithEmailLink(auth, window.location.href)) {
    throw new Error('This does not look like a valid sign-in link.');
  }
  const email = window.localStorage.getItem('ew_2fa_email');
  if (!email) throw new Error('Could not find the email this link was sent to. Please request a new one from the same browser.');
  const result = await firebaseAuthMod.signInWithEmailLink(auth, email, window.location.href);
  return result.user.getIdToken();
}

window.EWFirebase2FA = { loadFirebase, sendPhoneCode, confirmPhoneCode, sendEmailSignInLink, completeEmailSignIn };
