'use strict';

// Every "big" integration (Google Sign-In, Firebase 2FA, Stripe billing,
// Google Drive storage) is feature-gated on whether its env vars are set.
// Nothing in the app assumes these exist -- the UI checks the *Enabled
// flags from GET /api/config and shows a "not set up yet" state instead of
// a broken button when they're missing. The moment real credentials are
// added to Vercel's Environment Variables and redeployed, these flip on
// automatically -- no code changes needed.

function getPublicConfig() {
  const googleClientId = process.env.GOOGLE_CLIENT_ID || null;

  const firebaseConfig = (
    process.env.FIREBASE_API_KEY &&
    process.env.FIREBASE_AUTH_DOMAIN &&
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_APP_ID
  ) ? {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    appId: process.env.FIREBASE_APP_ID,
  } : null;

  const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || null;

  const driveEnabled = Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_DRIVE_FOLDER_ID);

  return {
    googleSignInEnabled: Boolean(googleClientId),
    googleClientId,
    firebaseEnabled: Boolean(firebaseConfig),
    firebaseConfig,
    stripeEnabled: Boolean(stripePublishableKey),
    stripePublishableKey,
    stripePriceId: process.env.STRIPE_PRICE_ID || null,
    driveEnabled,
  };
}

module.exports = { getPublicConfig };
