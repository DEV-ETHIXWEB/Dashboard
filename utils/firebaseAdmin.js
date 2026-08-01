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

async function verifyFirebaseIdToken(idToken) {
  const admin = require('firebase-admin');
  getApp();
  return admin.auth().verifyIdToken(idToken);
}

module.exports = { isFirebaseAdminConfigured, verifyFirebaseIdToken };
