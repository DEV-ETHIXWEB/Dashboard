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
 * Deliberately **not** behind requireAuth, which is a change from the first
 * cut and the reason for this paragraph.
 *
 * The public Terms page renders its prices from this endpoint, and that page
 * exists to be read by somebody deciding whether to buy -- reached from the
 * footer of every email we send, as likely to be opened signed out as in. With
 * a session required, every one of those visitors was shown a Plans section
 * with no plans in it, which is worse than having no section at all.
 *
 * What is actually here is a price list we print on a public web page, put in
 * emails and read out on calls. There is nothing in it that is not already
 * public, and the only thing gating it bought was a broken page.
 *
 * Rate-limited with everything else under /api, so it is not a free scraping
 * target either.
 */

const express = require('express');
const router = express.Router();

const plans = require('../lib/plans');

router.get('/', (req, res) => {
  // Cacheable: this changes when lib/plans.js changes, which is a deploy.
  res.set('Cache-Control', 'public, max-age=300');
  res.json(plans.describeAll());
});

module.exports = router;
