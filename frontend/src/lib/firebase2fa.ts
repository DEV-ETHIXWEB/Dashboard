
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import type { PublicConfig } from "./types";

const FALLBACK_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAkLML1YyzTcLjfzo-ZvcjTYyEyS_wJDdE",
  authDomain: "dashboard-56287.firebaseapp.com",
  projectId: "dashboard-56287",
  storageBucket: "dashboard-56287.firebasestorage.app",
  messagingSenderId: "900652063620",
  appId: "1:900652063620:web:8829b3f68f01ba02869bd1",
  measurementId: "G-ECREFF5W3X",
};

let firebaseApp: ReturnType<typeof initializeApp> | null = null;

let firebaseAuthMod: any = null;

export function getDefaultFirebaseConfig() {
  return FALLBACK_FIREBASE_CONFIG;
}

export async function loadFirebase(config?: NonNullable<PublicConfig["firebaseConfig"]> | null) {
  if (firebaseApp) return firebaseApp;

  const mergedConfig = {
    ...FALLBACK_FIREBASE_CONFIG,
    ...(config ?? {}),
  };

  firebaseApp = initializeApp(mergedConfig as any);

  try {
    getAnalytics(firebaseApp);
  } catch (err) {
    console.warn("Firebase analytics could not be initialized:", err);
  }

  firebaseAuthMod = await import("firebase/auth");
  return firebaseApp;
}

export function isFirebaseInitialized(): boolean {
  return firebaseApp !== null;
}

export async function signInWithGoogleFirebase(config?: NonNullable<PublicConfig["firebaseConfig"]>): Promise<string> {
  if (config) {
    await loadFirebase(config);
  }
  if (!firebaseApp || !firebaseAuthMod) {
    throw new Error("Firebase is not initialized. Please configure Firebase settings.");
  }
  const auth = firebaseAuthMod.getAuth(firebaseApp);
  const provider = new firebaseAuthMod.GoogleAuthProvider();
  const userCredential = await firebaseAuthMod.signInWithPopup(auth, provider);
  return userCredential.user.getIdToken();
}

