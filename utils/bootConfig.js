'use strict';

/**
 * The settings without which this application does not work correctly, checked
 * once, at import.
 *
 * Every one of these failed silently. The app booted, served pages, and was
 * wrong in a way only a customer would find:
 *
 *   OTP_ENCRYPTION_KEY   unset, each instance invents its own key at startup.
 *                        A sign-in code encrypted by one Vercel instance is
 *                        "Incorrect code" on another, so clients are rejected
 *                        at random while typing the right six digits.
 *   APP_BASE_URL         unset, and every link in every email is built from
 *                        whatever Host header the request arrived with.
 *   a database           unset, and the app runs on whatever the fallback is
 *                        rather than the workspace's real data.
 *
 * Checked at import rather than inside `app.listen`, because on a serverless
 * platform nothing ever calls `listen`: the function imports the app and
 * handles a request. Every one of the existing boot warnings sits inside that
 * branch and has therefore never run in the environment they were written for.
 *
 * In production a missing setting throws, which fails the deployment rather
 * than the customer. Everywhere else it warns, because a developer running
 * this locally should not have to set a production key to see a page.
 *
 * ALLOW_INCOMPLETE_CONFIG=on turns the error back into a warning. It exists
 * because "the deployment will not start" is occasionally the wrong answer at
 * two in the morning, and an operator who knows what is missing should be able
 * to say so out loud rather than by deleting this file.
 */

/** Whether a Firestore service account is configured. Mirrors db/firestore.js. */
function firestoreConfigured() {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT
    || process.env.GOOGLE_APPLICATION_CREDENTIALS
    || process.env.FIREBASE_PROJECT_ID,
  );
}

/** Each requirement, with the sentence that says what goes wrong without it. */
function problems() {
  const found = [];

  if (!String(process.env.OTP_ENCRYPTION_KEY || '').trim()) {
    found.push(
      'OTP_ENCRYPTION_KEY is not set. Each instance then invents its own key at '
      + 'startup, so a sign-in code issued by one instance cannot be read by another '
      + 'and clients are told "Incorrect code" while typing the right one.',
    );
  }

  if (!String(process.env.APP_BASE_URL || '').trim()) {
    found.push(
      'APP_BASE_URL is not set. Every link in every email is then built from the '
      + 'Host header of whatever request happened to trigger it.',
    );
  }

  if (!String(process.env.DATABASE_URL || '').trim() && !firestoreConfigured()) {
    found.push(
      'Neither DATABASE_URL nor a Firebase service account is set, so there is no '
      + 'database to read the workspace from.',
    );
  }

  return found;
}

/**
 * Run the check. Returns the list of problems so a caller can report them;
 * throws first in production unless the escape hatch is set.
 */
function verify({ exitOnFailure = true } = {}) {
  const found = problems();
  if (found.length === 0) return found;

  const production = process.env.NODE_ENV === 'production';
  const allowed = String(process.env.ALLOW_INCOMPLETE_CONFIG || '').trim().toLowerCase() === 'on';

  const label = production ? '[config] REFUSING TO START' : '[config]';
  for (const problem of found) console.error(`${label} ${problem}`);

  if (production && !allowed && exitOnFailure) {
    throw new Error(
      `Missing required configuration: ${found.length} setting`
      + `${found.length === 1 ? '' : 's'}. See the messages above, or set `
      + 'ALLOW_INCOMPLETE_CONFIG=on to start anyway.',
    );
  }

  if (production && allowed) {
    console.warn('[config] ALLOW_INCOMPLETE_CONFIG=on, so starting despite the above.');
  }

  return found;
}

module.exports = { verify, problems, firestoreConfigured };
