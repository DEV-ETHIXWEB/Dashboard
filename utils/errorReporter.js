'use strict';

/**
 * Where an unhandled failure goes.
 *
 * Everything in this application reported failures with `console.error`, which
 * on a serverless platform means a line in a log nobody opens. The practical
 * effect is that the first person to learn about a broken deploy is a client,
 * by telephone -- and whatever they say will be less precise than the stack
 * trace that was written at the time and thrown away.
 *
 * This is deliberately a seam rather than an integration. It still writes to
 * the console, which is what a local run wants, and it posts to a webhook when
 * one is configured. `ERROR_WEBHOOK_URL` takes a Sentry store endpoint, a
 * Slack incoming webhook, or anything else that accepts a JSON POST -- the
 * point is that a deployment can route errors somewhere a person looks without
 * this repository taking on a vendor SDK, and without a second place in the
 * code that has to be remembered when one is chosen.
 *
 * Three rules, because an error reporter that makes things worse is worse than
 * none at all:
 *
 *   never throws     a failure to report a failure must not become the
 *                    failure. Every path here swallows.
 *   never blocks     the report is sent after the response, with a short
 *                    timeout. Nobody waits on it.
 *   never leaks      the payload carries the message, the stack and the route,
 *                    and nothing from the request body, the headers or the
 *                    session. A crash report is not a place to find out what a
 *                    client typed.
 */

const DEFAULT_TIMEOUT_MS = 3000;

/** Noisy repeats, suppressed. The same stack twice a second says nothing new. */
const RECENT = new Map();
const REPEAT_WINDOW_MS = 60 * 1000;

function configured() {
  return String(process.env.ERROR_WEBHOOK_URL || '').trim() || null;
}

/**
 * Whether this is the first time lately we have seen this exact failure.
 *
 * Keyed on the message and the top frame rather than the whole stack: a loop
 * that throws on every row produces a thousand identical reports, which buries
 * everything else that happened that minute.
 */
function firstInAWhile(key) {
  const now = Date.now();
  for (const [seen, at] of RECENT) {
    if (now - at > REPEAT_WINDOW_MS) RECENT.delete(seen);
  }
  if (RECENT.has(key)) return false;
  RECENT.set(key, now);
  return true;
}

/**
 * Report one failure.
 *
 * `context` is for what makes the error findable -- the route, the sweep, the
 * entity id. Never the request body, never a header, never anything a client
 * typed; the caller decides, and the callers in this codebase pass a method
 * and a path.
 */
function report(error, context = {}) {
  const err = error instanceof Error ? error : new Error(String(error));
  const topFrame = String(err.stack || '').split('\n')[1] || '';
  const key = `${err.message}::${topFrame.trim()}`;

  // The console first and always: it is the one sink that is always there, and
  // a local run has nowhere else to look.
  console.error('[error]', err.message, JSON.stringify(context), err.stack || '');

  const url = configured();
  if (!url) return;
  if (!firstInAWhile(key)) return;

  const payload = {
    message: err.message,
    name: err.name,
    stack: String(err.stack || '').slice(0, 4000),
    context,
    environment: process.env.NODE_ENV || 'development',
    at: new Date().toISOString(),
  };

  // Not awaited by callers, and timed out here: a reporting endpoint that has
  // gone down must not hold a function open until the platform kills it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
    .catch(() => { /* See the note at the top: reporting never throws. */ })
    .finally(() => clearTimeout(timer));
}

/**
 * The Express handler, so an unhandled route error is reported before the
 * generic 500 goes out.
 */
function middleware(err, req, res, next) { // eslint-disable-line no-unused-vars
  report(err, {
    method: req.method,
    // The path pattern where Express knows one, so a thousand different ids do
    // not look like a thousand different bugs.
    route: req.route?.path || req.path,
    // Who, not what: an id is enough to reproduce, and nothing they typed.
    userId: req.user?.id || null,
    role: req.user?.role || null,
  });
  res.status(500).json({ error: 'Something went wrong on the server.' });
}

/**
 * Catch what escapes everything else.
 *
 * An unhandled rejection is the failure mode of a codebase with this many
 * `void somethingAsync()` calls, and Node's default is to print and, from v15,
 * exit. Reporting first means the stack reaches somebody.
 */
function install() {
  process.on('unhandledRejection', (reason) => {
    report(reason, { kind: 'unhandledRejection' });
  });
  process.on('uncaughtException', (error) => {
    report(error, { kind: 'uncaughtException' });
    // Deliberately not swallowed. A process in an unknown state should be
    // replaced, and both the platform and the local runner will do that.
    throw error;
  });
}

module.exports = { report, middleware, install, configured };
