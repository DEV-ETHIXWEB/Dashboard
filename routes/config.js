'use strict';

const express = require('express');
const router = express.Router();
const { getPublicConfig } = require('../config');

// Intentionally not behind requireAuth -- the login page needs this before
// anyone is signed in, to know whether to show "Sign in with Google" etc.
// Only ever returns public-safe values (client IDs, publishable keys,
// booleans) -- never secrets.
router.get('/', (req, res) => {
  res.json(getPublicConfig());
});

module.exports = router;
