'use strict';

/**
 * Budgets for the handful of operations that hand over somebody else's account
 * if they are ground through in bulk.
 *
 * The dashboard as a whole gets 600 requests per fifteen minutes, which is the
 * right size for a person clicking around and far too generous for walking a
 * list of sign-in codes or password resets. These are deliberately small enough
 * to be felt by a script and large enough that nobody doing the actual job
 * notices them.
 *
 * All limits are counted per IP address, so behind a proxy they are only as
 * honest as `trust proxy` -- which server.js sets in production.
 */

const rateLimit = require('express-rate-limit');

/** Revealing a sign-in code, minting a sign-in link, changing admin standing. */
const sensitiveAdminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sensitive admin actions from this address. Try again in a few minutes.' },
});

/** Issuing credentials: account creation and password resets. */
const credentialIssueLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many credential changes from this address. Try again in a few minutes.' },
});

/**
 * Generating backup codes gets its own budget, deliberately not shared.
 *
 * These are the recovery path for an administrator who cannot receive an
 * emailed code. Counting them against the same allowance as revealing OTP
 * codes would mean somebody grinding that endpoint could starve the one
 * feature whose whole purpose is preventing a lockout -- an availability
 * problem handed to us by our own rate limiting.
 */
const recoveryCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many backup-code requests from this address. Try again in a few minutes.' },
});

module.exports = { sensitiveAdminLimiter, credentialIssueLimiter, recoveryCodeLimiter };
