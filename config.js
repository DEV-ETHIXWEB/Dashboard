'use strict';

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

  // The password rules the browser needs in order to say what they are before
  // somebody types something that gets refused. Rules only -- the server checks
  // every one of them again, so a stale or edited copy buys nothing.
  const policy = require('./utils/passwordPolicy').config();

  return {
    passwordPolicy: {
      enabled: policy.enabled,
      minLength: policy.minLength,
      maxAgeDays: policy.maxAgeDays,
      warnDays: policy.warnDays,
    },
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
