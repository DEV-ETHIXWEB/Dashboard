'use strict';

function isFirebaseAdminConfigured() {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
}

let app = null;
function getApp() {
  if (app) return app;
  const admin = require('firebase-admin');
  const credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(credentials) });
  return app;
}

/**
 * Verifies a Firebase ID token (issued client-side after a successful
 * phone or email-link verification) and returns the decoded token, which
 * includes `phone_number` and/or `email` depending on which method was used.
 */
async function verifyFirebaseIdToken(idToken) {
  const admin = require('firebase-admin');
  getApp();
  return admin.auth().verifyIdToken(idToken);
}

module.exports = { isFirebaseAdminConfigured, verifyFirebaseIdToken };
