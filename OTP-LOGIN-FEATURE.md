# Login OTP feature (what we built today)

> **Update, since this was written.** Two things changed, and they change the
> premise of this document rather than adding to it:
>
> 1. **The code is emailed now.** An admin reading it out is the fallback for a
>    workspace with no mail transport configured, not the plan. The sections
>    below that describe the admin as the delivery mechanism "on purpose"
>    describe the first version, not the current one.
> 2. **Clients can skip the password and the code entirely.** An admin can
>    mint a one-tap sign-in link for them from Client access and hand it over
>    -- see "One-tap sign-in links" in the README. Staff and admin accounts
>    still use password + code.

This document explains the login OTP system we added to
the CRM today: why it exists, how it works end to end, what changed in the
codebase, and how the database is laid out to support it. It also covers
the visual refresh we gave the login page while we were in there.


## The problem we were solving

Before today, logging in was just email and password, with an optional
Firebase based two factor step (SMS code or an email link) that a user
could turn on for themselves from Settings. Most accounts never turned
that on, so in practice almost everyone logged in with just a password.

What was asked for instead: every login should require a second step where the person logging in types in a
6 digit code. But this code should not be sent automatically by SMS or
email. Instead, it should be generated the moment the password is accepted,
and shown to an admin on a dedicated page, along with who is trying to log
in (name, email) and where from (IP address). The code itself is never
sent to the browser until an admin explicitly asks for it -- clicking the
reveal button makes a real, audit-logged request for that one code, rather
than just un-hiding something already downloaded to the page. The admin
then reads that code out to the person over some other
channel, like a phone call or a chat message, and that person types it in
to finish logging in.

This is a manual, human in the loop verification step. It is not meant to
replace something like SMS delivery infrastructure. It is meant to give an
admin visibility and control over every login attempt.

## Why admins are exempt

If every login required this OTP step, admins would be stuck. An admin is
the only person who can open the page that shows the generated codes, and
that page is behind a login. So if an admin's own login also required a
code that only an admin could see, nobody could ever get in for the very
first time, or after a session expired. To avoid that lockout, admin
accounts skip the OTP step completely and log in with just their password,
exactly like before. Every other role (sales, project manager, employee,
client) goes through the OTP step.

## How the flow works, step by step

1. Someone opens the login page and types in their email and password.
   This posts to `POST /api/auth/login` just like before.

2. The server checks the password. If it's wrong, the person gets the
   usual "invalid email or password" error, nothing new here.

3. If the password is correct and the account is not an admin, the server
   does two things at once:
   - It creates a "pending" session (a session that is not fully logged in
     yet, expires in 10 minutes) and sets that as a cookie in the
     browser.
   - It generates a random 6 digit code and saves it to a new database
     table called `otp_codes`, along with the user's id, their IP address,
     the time it was created, and an expiry timestamp 5 minutes out.

   The response back to the browser is just `{ requiresOtp: true }`. The
   code itself is never sent to the person logging in. This is the whole
   point: they have to go get it from an admin.

4. If the password is correct and the account is an admin, none of the
   above happens. The server just logs them in immediately, same as the
   old flow.

5. On the frontend, the login page sees `requiresOtp: true` and switches to
   a second screen with six boxes to type a code into, one digit per box.

6. Meanwhile, an admin who is already logged in can visit a new page in the
   admin sidebar called "Login Codes" (`/portal/otp-monitor`). This page
   lists every code that has been generated recently: who requested it
   (name and email), what IP address they came from, when it was
   requested, whether it's still active, expired, or already used, and how
   many wrong guesses it's already had. The code itself isn't in that list
   at all -- clicking the eye icon fetches it from the server on demand.

7. The admin finds the right row (usually the most recent one, or matched
   by name/email), reveals the code, and tells the person who's trying to
   log in what it is, out loud or over chat.

8. That person types the 6 digits into the boxes on the login page and
   submits. This posts to `POST /api/auth/verify-otp` with the code.

9. The server looks up the newest code for that user that hasn't been used
   yet. If the code has expired, or if there have already been 5 wrong
   guesses against it, the attempt is rejected and the person has to log in
   again from scratch to get a fresh code. If the code matches, the server
   marks it as used, promotes the pending session into a real, fully logged
   in session, and the person is taken to the dashboard.

That's the entire loop. No SMS provider, no email provider, no third party
service involved. The admin is the delivery mechanism, on purpose.

## What changed in the code

### Backend

**`db/setup.js`**
Added a new table, `otp_codes`, and registered its columns in the schema
map so the database access layer knows about it. See the schema section
below for the exact columns.

**`routes/auth.js`**
This is where most of the logic lives.
- `finishLogin()` used to check a `twoFactorEnabled` flag on the user and,
  if set, kick off the old Firebase 2FA step. It now checks the user's
  role instead. Admins get logged in immediately. Everyone else gets a
  pending session plus a freshly generated OTP code saved to the database.
- The old `POST /verify-2fa` route (which checked a Firebase ID token) has
  been replaced with `POST /verify-otp`, which checks the submitted code
  against what's stored in `otp_codes`, enforces the expiry and the
  attempt limit atomically (see "Hardening" below), and promotes the
  session on success.
- A new route, `GET /otp-logs`, is admin only and returns the list of
  recent codes joined with the requester's name and email, for the Login
  Codes page to display. It does not include the code itself.
- Another new route, `POST /otp-logs/:id/reveal`, is also admin only and
  is the only way to actually get a code's value. Every call is written
  to `activity_log` via the existing `audit()` helper, so there's a real
  record of which admin looked at which code and when.

### Frontend

**`src/pages/Login.tsx`**
Removed all the old Firebase phone and email verification UI (the
recaptcha box, the "send SMS code" button, the "email me a link" button).
Replaced it with a simple screen: six boxes for the code, a live countdown
showing time left before it expires, a confirm button, and a note telling
the person to ask their admin for the code. Digit entry supports pasting
a full 6-digit code (e.g. copied from a chat message) and backspace
correctly moves back to the previous box when the current one is empty.
Also gave the surrounding background of the page (not the actual card or
form, just everything around it) a more polished look: layered gradients,
soft glowing shapes, a subtle grid pattern, and a couple of small trust
signals on the left panel like "every login is verified with a second
step."

**`src/pages/OtpMonitor.tsx`** (new file)
The admin facing Login Codes page. Shows each generated code as a row with
the person's name, email, IP address, when it was requested, how many
attempts it's had, and a status badge (Active, Expired, or Used). The code
itself is masked with dots by default; clicking the eye icon calls
`POST /otp-logs/:id/reveal` and shows the real value only after that
request succeeds. Refreshes automatically every 5 seconds so new requests
show up without a manual refresh.

**`src/lib/types.ts`**
Swapped the old `requires2FA` / `twoFactorContact` fields on the login
response type for a simpler `requiresOtp` flag (plus `otpExpiresAt`, used
to drive the countdown), and added a new `OtpLogEntry` type describing
what the Login Codes page receives from the server.

**`src/lib/firebase2fa.ts`**
Trimmed out the phone code and email link functions that are no longer
used by the login flow (`sendPhoneCode`, `confirmPhoneCode`,
`sendEmailSignInLink`, `completeEmailSignIn`). What's left is just the
piece still needed for the "Sign in with Google" popup button, and it
only ever initializes Firebase with a config the backend actually
provided -- see "Hardening" below.

**`src/pages/VerifyEmail.tsx`** (deleted)
This page only existed to finish the old email sign in link flow. Since
that flow doesn't exist anymore, the page and its route were removed.

**`src/App.tsx` and `src/components/AppShell.tsx`**
Added the new `/portal/otp-monitor` route (admin only) and a matching
"Login Codes" entry in the admin sidebar navigation, right next to "Team."

## The database schema

Everything lives in Postgres. Tables are created automatically on startup
if they don't already exist, there's no separate migration step to run.
The one new table for this feature is `otp_codes`:

| Column | Type | What it's for |
|---|---|---|
| `id` | text, primary key | Unique id for the row, generated automatically. |
| `user_id` | text | Which user this code belongs to. |
| `code` | text | The actual 6 digit code, stored as plain text. |
| `ip_address` | text | The IP address the login attempt came from, taken from the request. |
| `created_at` | text | Timestamp of when the code was generated. |
| `expires_at` | number (stored as a big integer) | Timestamp of when the code stops being valid, 5 minutes after creation. |
| `consumed` | boolean | Set to true once the code has been used successfully. A used code can't be reused. |
| `attempts` | number | Counts how many wrong guesses have been made against this code. Capped at 5. |

For context, here's the rest of the schema too, since it all lives in the
same file and works the same way:

| Table | What it stores |
|---|---|
| `users` | Accounts: name, email, role, company, hashed password, Google id, and two leftover columns (`two_factor_enabled`, `two_factor_contact`) from the old self-service 2FA toggle, which no longer affects login. |
| `projects` | Client projects: name, type, status, which client and project manager it belongs to. |
| `tasks` | Work items under a project, with an assignee, status, priority, and due date. |
| `tickets` | Support tickets from clients, with a category, status, and description. |
| `notifications` | Per-user notification messages, with a read/unread flag. |
| `sessions` | Login sessions. Includes a `pending` flag, which is what makes the OTP step possible: a pending session means "password checked out, waiting on the code." |
| `otp_codes` | The new table described above. |
| `activity_log` | A general audit trail of actions taken across the app. |
| `domains` | Client website records: hosting provider, SSL status, DNS status, expiry date, and so on. |
| `reports` | Uploaded report files, either stored directly in the database or in Google Drive depending on configuration. |
| `budget_items` | Per-client spend line items, used for the budget breakdown views. |
| `billing` | One row per client, tracking their Stripe subscription and plan. |

### How the code talks to the database

Nothing in the route files writes raw SQL directly. There's a small helper
object called `db` in `db/setup.js` with methods like `db.find`,
`db.all`, `db.filter`, `db.insert`, `db.update`, and `db.remove`. You pass
it a table name and it handles the actual query, plus converts between
JavaScript's camelCase naming (like `userId`) and Postgres's snake_case
column naming (like `user_id`) automatically. So when the OTP code does
`db.insert('otp_codes', { userId: user.id, code, ipAddress: req.ip, ... })`,
it's really writing a row with `user_id`, `code`, and `ip_address` columns
under the hood.

If you ever add a new column to `otp_codes` or any other table, you need
to add it in two places: the `SCHEMAS` list at the top of `db/setup.js`
(so the mapping layer knows the column exists) and the matching
`CREATE TABLE` statement further down (so it actually gets created in a
fresh database).

## Hardening (after review, before merge)

A few things in the first version of this feature got fixed based on
review before it merged:

- **Attempt limiting had a race condition.** The original code read
  `attempts`, checked it in JavaScript, then wrote `attempts + 1` as a
  separate step. Concurrent requests could all read the same value before
  any of the writes landed, letting more than 5 guesses through. It's now
  a single atomic SQL statement (`db.incrementIfBelow` in `db/setup.js`):
  `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1 AND attempts
  < $2 RETURNING *`. Verified by firing 10 concurrent wrong guesses at a
  code and confirming exactly 5 get through, not 6+.
- **Codes were sent to the browser in full, not actually gated.** The
  first version of `/otp-logs` returned every code's real value on every
  fetch (polled every 5 seconds), and the "reveal" button just toggled
  whether the already-downloaded value was displayed. There was also no
  record of who looked at what. Fixed by moving the code out of the list
  response entirely and adding the audited `/otp-logs/:id/reveal`
  endpoint described above.
- **A hardcoded, third-party Firebase project was a silent fallback.**
  `firebase2fa.ts` originally had a `FALLBACK_FIREBASE_CONFIG` with real
  credentials for a specific Firebase project, used automatically
  whenever the backend hadn't configured its own -- meaning every
  unconfigured deployment of this CRM would silently initialize Firebase
  Analytics against that one project on every login page visit. Removed
  entirely; Firebase now only loads when the backend actually supplies a
  config, and is dynamically imported so it isn't even fetched otherwise.
- **`firebase` was a dependency of the backend, not the frontend**, even
  though only frontend code imports it. It worked locally by accident
  (Node's module resolution found it in the backend's `node_modules` one
  directory up), but broke a genuinely standalone build of `frontend/`
  outright. Moved to `frontend/package.json`.
- **`otp_codes` had no cleanup and was fully scanned on every read**,
  including the 5-second admin poll. Every login attempt added a row
  forever. Added indexes on `user_id` and `created_at`, a `db.recent()`
  helper that does the sort/limit in SQL instead of JavaScript, and
  opportunistic pruning of expired rows plus invalidation of a user's
  prior unconsumed code whenever a new one is issued (which also means
  there's only ever one "current" code per user for an admin to read out
  -- no more guessing which of two active-looking rows is the real one).
- `/verify-otp` now has its own rate limit, separate from `/login` and
  `/google`, so retyping a mistyped code can't lock someone out of the
  password step itself. The code comparison is also constant-time now
  (`crypto.timingSafeEqual`), and `app.set('trust proxy', 1)` was added
  in production so the IP column reflects the real client instead of
  Vercel's edge address.

## Things worth knowing if you keep working on this

- There is genuinely no SMS or email provider wired up for the OTP codes.
  That's not an oversight, it's the design: an admin is the one who reads
  the code out. If you ever want automatic delivery instead, you'd swap
  step 6 and 7 above for a call to a provider like Twilio or an email
  service, right after the code is generated in `finishLogin()`.

- The old self-service 2FA toggle still exists in Settings and in the
  `users` table (`two_factor_enabled`, `two_factor_contact`), but it no
  longer does anything to the login flow. It's leftover from before this
  change. Either wire it back in as an extra layer on top of the OTP step,
  or remove it later so it stops being confusing.

- Codes expire after 5 minutes and lock out after 5 wrong guesses. Both of
  those numbers live as constants near the top of `routes/auth.js`
  (`OTP_TTL_MS` and `MAX_OTP_ATTEMPTS`) if you want to tune them.

- The Login Codes admin page currently shows the last 100 codes, sorted
  newest first. That limit is set in the `/otp-logs` route in
  `routes/auth.js`.
