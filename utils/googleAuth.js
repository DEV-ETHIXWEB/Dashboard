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
  return { googleId: payload.sub, email: payload.email, name: payload.name };
}

module.exports = { isGoogleSignInConfigured, verifyGoogleIdToken };
