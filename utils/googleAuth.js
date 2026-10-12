'use strict';

const { OAuth2Client } = require('google-auth-library');

function isGoogleSignInConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID);
}

let client = null;
function getClient() {
  if (!client) client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  return client;
}

async function verifyGoogleIdToken(idToken) {
  const ticket = await getClient().verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  // `email_verified` travels with the rest. Without it the caller is trusting
  // an address claim Google itself has not confirmed. See routes/auth.js.
  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name,
    emailVerified: payload.email_verified !== false,
  };
}

module.exports = { isGoogleSignInConfigured, verifyGoogleIdToken };
