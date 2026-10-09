'use strict';

/**
 * The plan catalogue.
 *
 * One endpoint, one job: hand the browser the same object lib/plans.js holds,
 * so the plans modal, the billing page and the upgrade prompts all render from
 * the config rather than from a second copy of the price list compiled into
 * the frontend bundle. Two copies of a price is how a client reads $19 on one
 * screen and is charged $29 on the next.
 *
 * Behind requireAuth like everything else under /api. It is only a price list,
 * but there is no reason for it to be the one endpoint in the app that answers
 * to anybody.
 */

const express = require('express');
const router = express.Router();

const plans = require('../lib/plans');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/', (req, res) => {
  res.json(plans.describeAll());
});

module.exports = router;
