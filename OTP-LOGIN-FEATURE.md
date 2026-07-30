# Login OTP feature (what we built today)

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
in (name, email) and where from (IP address). The code stays hidden behind
a click to reveal button so an admin has to consciously choose to look at
it. The admin then reads that code out to the person over some other
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
   requested, whether it's still active, expired, or already used, and the
   code itself, hidden behind dots until the admin clicks the eye icon next
   to it.

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
  been replaced with `POST /verify-otp`, which checks the plain 6 digit
  code against what's stored in `otp_codes`, enforces the expiry and the
  attempt limit, and promotes the session on success.
- A new route, `GET /otp-logs`, is admin only and returns the list of
  recent codes joined with the requester's name and email, for the Login
  Codes page to display.

### Frontend

**`src/pages/Login.tsx`**
Removed all the old Firebase phone and email verification UI (the
recaptcha box, the "send SMS code" button, the "email me a link" button).
Replaced it with a simple screen: six boxes for the code, a confirm
button, and a note telling the person to ask their admin for the code.
Also gave the surrounding background of the page (not the actual card or
form, just everything around it) a more polished look: layered gradients,
soft glowing shapes, a subtle grid pattern, and a couple of small trust
signals on the left panel like "every login is verified with a second
step." The email and password inputs and the OTP boxes themselves were
left structurally the same, this was a visual pass, not a functional one.

**`src/pages/OtpMonitor.tsx`** (new file)
The admin facing Login Codes page. Shows each generated code as a row with
the person's name, email, IP address, when it was requested, a status
badge (Active, Expired, or Used), and the code itself masked with dots
until you click the eye icon to reveal it. Refreshes automatically every
5 seconds so new requests show up without a manual refresh.

**`src/lib/types.ts`**
Swapped the old `requires2FA` / `twoFactorContact` fields on the login
response type for a simpler `requiresOtp` flag, and added a new
`OtpLogEntry` type describing what the Login Codes page receives from the
server.

**`src/lib/firebase2fa.ts`**
Trimmed out the phone code and email link functions that are no longer
used by the login flow (`sendPhoneCode`, `confirmPhoneCode`,
`sendEmailSignInLink`, `completeEmailSignIn`). What's left is just the
piece still needed for the "Sign in with Google" popup button.

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
