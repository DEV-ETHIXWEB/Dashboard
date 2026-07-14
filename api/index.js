'use strict';

// Vercel serverless entrypoint. vercel.json rewrites every /api/* request
// here; the Express app inside server.js still does its own internal
// routing based on the full path (e.g. /api/auth/login), so nothing about
// the route files needed to change for this.
module.exports = require('../server');
