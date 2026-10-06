'use strict';

/**
 * The outbound queue's two endpoints.
 *
 * `POST /sweep` is for a scheduler outside the app -- Vercel's cron, or any
 * other thing that can make an HTTPS request on a timer. It exists because on
 * a serverless deployment nothing in this process is alive between requests:
 * `startTimer` in server.js does nothing there, and the request-driven sweep
 * only runs while somebody is using the dashboard. A message that failed at
 * 2am would otherwise sit until the first person signed in.
 *
 * `GET /` is the admin answer to "is mail stuck?", which is the one question
 * worth being able to ask without reading a table by hand.
 *
 * The two have completely different callers, so they have completely different
 * guards: the sweep is authenticated by a shared secret and is deliberately
 * NOT reachable with a session cookie, and the summary is admin-only session
 * auth and cannot be reached with the secret. Neither is a way into the other.
 */

const express = require('express');
const router = express.Router();

const { requireAuth, requireRole } = require('../middleware/auth');
const outbox = require('../utils/outbox');
const cronAuth = require('../utils/cronAuth');

/**
 * Whether this request carries the cron secret.
 *
 * The check itself lives in utils/cronAuth.js, because the service summary
 * sweep in routes/mail.js needs the same one and a second copy of a security
 * check is a second thing to forget to fix. OUTBOX_CRON_SECRET still wins over
 * CRON_SECRET here, so a deployment can keep this endpoint on a secret of its
 * own.
 */
function authorisedCron(req) {
  return cronAuth.authorisedCron(req, ['OUTBOX_CRON_SECRET', 'CRON_SECRET']);
}

/**
 * Run the sweep now.
 *
 * Answers 202 with the counts rather than 200, because what it did is not
 * finished business: a message that is `retrying` will be back. Returns the
 * counts and nothing about the messages themselves -- the caller is a cron
 * job, and a recipient list has no business in a log somewhere else.
 */
async function sweepHandler(req, res) {
  if (!authorisedCron(req)) {
    // No detail. A probe learns only that this is not for them, not whether
    // the secret is unset, the wrong length, or simply wrong.
    return res.status(404).end();
  }

  try {
    const result = await outbox.runSweep();
    // Delivered rows that nobody is coming back for go at the same time, so
    // the table does not grow forever on a deployment with no other sweeper.
    const pruned = await outbox.prune();
    return res.status(202).json({ ...result, pruned });
  } catch (err) {
    console.error('[outbox] the cron sweep failed:', err.message);
    return res.status(500).json({ error: 'The sweep failed. See the server log.' });
  }
}

// GET as well as POST, because Vercel's cron issues a GET and there is no
// setting to change that -- a POST-only route would simply never be called,
// which is the kind of thing that is only noticed weeks later when somebody
// asks why a message was late. A GET that does work is not ideal; it is safe
// here because the secret arrives in a header, so no link, image, form or
// cross-origin page can trigger it, which is what CSRF protection would be
// for. Anything that can set that header already holds the secret.
router.get('/sweep', sweepHandler);
router.post('/sweep', sweepHandler);

/** How the queue looks. Admin-only, and says nothing about message contents. */
router.get('/', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    res.json(await outbox.summary());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
