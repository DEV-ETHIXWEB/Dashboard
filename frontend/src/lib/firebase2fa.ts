import type { PublicConfig } from "./types";

let firebaseApp: unknown = null;

let firebaseAuthMod: any = null;

// Only ever initializes Firebase with a config the backend actually
// provided (i.e. the operator configured their own Firebase project via
// env vars). There is intentionally no hardcoded fallback project here --
// silently initializing analytics/auth against someone else's Firebase
// project by default would send every visitor's login-page activity to a
// third party the CRM's operator never agreed to, for every deployment
// that hasn't configured its own Firebase.
export async function loadFirebase(config?: NonNullable<PublicConfig["firebaseConfig"]> | null) {
  if (!config) return null;
  if (firebaseApp) return firebaseApp;

  const { initializeApp } = await import("firebase/app");
  firebaseApp = initializeApp(config);

  try {
    const { getAnalytics } = await import("firebase/analytics");
    getAnalytics(firebaseApp as never);
  } catch (err) {
    console.warn("Firebase analytics could not be initialized:", err);
  }

  firebaseAuthMod = await import("firebase/auth");
  return firebaseApp;
}

export function isFirebaseInitialized(): boolean {
  return firebaseApp !== null;
}

export async function signInWithGoogleFirebase(
  config?: NonNullable<PublicConfig["firebaseConfig"]> | null,
): Promise<string> {
  if (config) await loadFirebase(config);
  if (!firebaseApp || !firebaseAuthMod) {
    throw new Error("Firebase is not configured. Ask your admin to set it up first.");
  }
  const auth = firebaseAuthMod.getAuth(firebaseApp);
  const provider = new firebaseAuthMod.GoogleAuthProvider();
  const userCredential = await firebaseAuthMod.signInWithPopup(auth, provider);
  return userCredential.user.getIdToken();
}
