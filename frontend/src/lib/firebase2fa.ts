import type { PublicConfig } from "./types";

let firebaseApp: unknown = null;

let firebaseAuthMod: any = null;

export async function loadFirebase(config?: NonNullable<PublicConfig["firebaseConfig"]> | null) {
  if (!config) return null;
  if (firebaseApp) return firebaseApp;

  const { initializeApp } = await import("firebase/app");
  firebaseApp = initializeApp(config);

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
