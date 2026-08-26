# EthixWeb CRM

Internal CRM for an IT / web / mobile / digital marketing agency. Express and
PostgreSQL backend with session-based authentication, CSRF protection, and
five user roles: Admin, Sales, Project Manager, Employee, Client.

This repo also contains the frontend (`frontend/`, a React + Vite project)
and serves its build output as static files, so the whole application
deploys as a single service.

> **Recent work:** [CHANGES.md](CHANGES.md) records everything added on this
> branch — the live wire, Stripe mirroring, super admin and approvals, domain
> reminders, client Slack channels — with what is still outstanding.

## Requirements

- Node.js 18+
- PostgreSQL (optional for local development, see below)

## Getting started

### Quick start, no database required

```bash
npm install
npm run dev:pgmem
```

Runs the app against an in-memory Postgres instance, seeded with sample
data. Data resets when the process restarts.

### With a real database

```bash
npm install
DATABASE_URL="postgres://user:pass@host:5432/ethixweb" npm start
```

### Building and serving the frontend

```bash
npm run build
```

Builds the frontend project and copies its output into `public/`, which
this server serves directly. This runs automatically as part of the Vercel
deploy (see `vercel.json`). For local development of both projects together,
see "Local development" below.

## Demo accounts

| Role | Name | Email | Password |
|---|---|---|---|
| Admin | Admin User | admin@ethixweb.local | `Admin#2026!` |
| Sales | Emily Turner | emily.turner@ethixweb.local | `Sales#2026!` |
| Project Manager | Ryan Coleman | ryan.coleman@ethixweb.local | `Manager#2026!` |
| Employee | Jordan Brooks | jordan.brooks@ethixweb.local | `Staff#2026!` |
| Client | David Shaw (BrightPath Retail Co.) | client@brightpath-retail.com | `Client#2026!` |

## Feature overview

- **Projects, Tasks, Tickets, Team** - core CRM entities, scoped per role.
- **Domains** - one record per client website: platform, hosting provider
  and region, registrar, SSL status, expiry, DNS status, and a renew action.
  Clients are reminded by email as the expiry approaches, automatically. See
  [Domain expiry reminders](#domain-expiry-reminders).
- **Reports** - file upload and download, stored in Google Drive when
  configured, otherwise in the database (4MB limit in that mode).
- **Budget** - per-client spend tracking by category, with totals and a
  breakdown view.
- **Billing & payments** - Stripe is the ledger. Invoices, charges, and
  subscriptions are mirrored into the app's own `payments` and `billing`
  tables, and every money figure the portal shows is rendered from that
  mirror -- with a link to Stripe's own receipt beside it. Webhooks keep it
  current; an admin's **Sync from Stripe** button repairs it if one goes
  missing. Card details are entered on Stripe's hosted pages and never touch
  this server. See [Money and Stripe](#money-and-stripe).
- **Notifications** - per-user, with an unread count and a mark-all-read
  action.
- **Super admin, and a second signature** - one account can appoint
  administrators and read the log. An admin nobody has vouched for yet can
  *propose* a sensitive change but not make it: every approver is alerted, and
  nothing touches the data until one of them signs it off. Nobody signs their
  own. See [Super admin and approvals](#super-admin-and-approvals).
- **Audit log** - `/portal/audit`, super admin only. Every write in the app
  already called `audit()`; this is the screen that reads it, with the person
  named rather than an id.
- **Client Access** - the admin-only console (`/portal/client-access`) that
  issues client logins. The admin never types a client's password: the
  server generates it, shows it back exactly once, and stores only a bcrypt
  hash. Each login can carry an expiry date, after which the client is
  locked out until an admin issues a new one. See
  [Client access & credential lifecycle](#client-access--credential-lifecycle).
- **Login codes (OTP)** - *every* login requires a second step, including
  an administrator's: a 6-digit code emailed to the account holder the
  instant the password check succeeds. The admin-only **Login Codes** page
  (`/portal/otp-monitor`) is the fallback for a workspace with no mail
  transport: a trusted admin can reveal one client or staff code at a time
  and read it out. Administrator codes are deliberately absent from that
  page and cannot be revealed by anyone - showing an admin's code to every
  other admin would undo the second factor rather than support it. See
  [Login codes (OTP) flow](#login-codes-otp-flow) below.
- **Backup sign-in codes** - because requiring a code puts the mail
  transport on the critical path of getting in, every administrator holds
  eight one-time backup codes, managed from **Security**
  (`/portal/security`). One takes the place of the emailed code; the
  password step still applies. See
  [Backup codes and getting back in](#backup-codes-and-getting-back-in).
- **One-tap sign-in links** - an admin can mint a single-use link for a
  client from **Client access** and hand it over on WhatsApp, SMS, or
  email. Opening it signs the client straight in: no password, no code.
  Links last 15 minutes, work once, and are admin-issued only - there is no
  self-service "email me a link" button, because a link is a bearer
  credential. Client accounts only. See
  [One-tap sign-in links](#one-tap-sign-in-links).
- **Sign in with Google** - restricted to existing accounts; an admin must
  create the account first.
- **Live updates** - one Server-Sent Events stream per signed-in tab
  (`/api/events`). When staff move a ticket, upload a report, or change what
  a client may open, that client's screen redraws within a second without a
  refresh. The stream carries a topic and a timestamp and never a record, so
  the browser always refetches through the same permission-checked endpoint
  it would have used anyway. See
  [The live wire](#the-live-wire-admin-to-client-updates).
- **Client navigation** - clients get four destinations (Home, Work,
  Requests, Money) plus a More sheet; staff keep the full grouped index.
  Switching a section off for a client removes its tab and promotes the next
  one, so the bar is never short and never has a dead tab in it.
- **Installable on a phone** - a manifest, home-screen shortcuts, and a
  service worker that caches the app shell but never a byte of `/api/`, so
  a signed-out phone has nothing private left on disk.

## Environment variables

Only `DATABASE_URL` is required to run the app. Everything else is optional
and independently feature-gated: if a variable isn't set, the related UI
shows a "not configured yet" state instead of erroring, and the feature
turns on automatically once you add the variable and redeploy.

| Variable | Enables |
|---|---|
| `DATABASE_URL` | Required. Postgres connection string. |
| `GOOGLE_CLIENT_ID` | Sign in with Google (Google Identity Services button) |
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase client SDK (Sign in with Google popup fallback) and the self-service 2FA contact toggle in Settings. **Not** used by the login-time OTP step, the client-access credentials, or password expiry - all of which need no configuration. See [What Firebase is actually used for](#what-firebase-is-actually-used-for). |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Billing |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_DRIVE_FOLDER_ID` | Report storage in Google Drive |

See `.env.example` for the full list with descriptions.

## Email, client progress, and multiple admins

### Email

Every notification is a real message, rendered by `utils/emailMessages.js` on
top of the layout in `utils/emailTemplates.js`: EthixWeb red (`#c20000`, the
same `--primary` the app uses), the emblem from `public/emblem-mark.png`, one
task card, one call to action. The layout follows the shape of a ClickUp
notification because that shape works; the palette and mark are EthixWeb's.

Turn delivery on with any ONE of:

| Transport | Set | Notes |
| --- | --- | --- |
| SMTP2GO (default) | `SMTP2GO_API_KEY` | HTTPS API. Create the key under **Sending → API Keys** with the `/email/send` permission, and verify the sending domain under **Sending → Verified Senders** first. Preferred on Vercel, where outbound SMTP ports are unreliable. |
| SMTP | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | Any mailbox you own -- SMTP2GO's own relay (`mail.smtp2go.com:587`, with an **SMTP user**, not the API key), Gmail/Workspace, Zoho, Outlook 365, SES, cPanel. Gmail and Outlook need an **app password**. |
| Webhook | `MAIL_WEBHOOK_URL` | Receives `POST {from, to, subject, text, html}`. |

Detection order is SMTP2GO, SMTP, webhook; `MAIL_TRANSPORT=smtp2go|smtp|webhook`
forces one when more than one is configured.

Also set `MAIL_FROM` (an address the mailbox may send as) and `APP_BASE_URL`
(the public URL of this dashboard -- the buttons and the emblem in every email
point at it).

With none of them set nothing is delivered, but every message is still rendered
and recorded, so the templates can be reviewed before any credential exists.

**Admin → Mail** (`/portal/mail`) is the control surface: which transport is
live, **Verify connection** (opens a real SMTP session and authenticates),
**Send test**, a preview of all twelve templates rendered by the production
code, and a log of every message the app attempted with the exact HTML that
went out.

Messages sent, and what triggers each:

| Template | Goes to | When |
| --- | --- | --- |
| New ticket | Every admin + the owner | A ticket is raised |
| Ticket receipt | The client | A ticket is raised |
| Ticket assigned | The new owner | Assignment changes |
| Status changed | The client | Status moves |
| New comment | The other side | A note is posted |
| Handover request | The teammate asked | Handover or collaboration request |
| Response due | Owner + admins | First-response deadline approaching or missed |
| Sign-in code | The person signing in | Any non-admin login |
| Login issued | The new user | An admin creates the account or resets the password |
| Admin roster change | Every admin | Someone gains or loses admin |
| Progress summary | The client | Sent on demand from the progress board |

### Client progress (`/portal/progress`)

Clients follow their work without a ClickUp seat or a Slack account. The server
reads both on their behalf and returns only what belongs to them: their tickets
with the live task-board status, the team's notes, the board comments, and the
Slack thread the ticket opened. Replies from this page go back out to the
ticket, the ClickUp task, and the Slack thread in one action.

`CLIENT_SLACK_THREAD` controls how much of the thread a client sees:

* `summary` (default) -- only the updates this dashboard posted.
* `full` -- the whole thread, including the team's own replies.

Admins switch the section on per client under **Client Access**, like any other
client page.

### Multiple administrators

The workspace has a set of administrators, not an owner. Every admin has the
same powers, alerts fan out to all of them, and a roster change emails everyone
who holds the role. The one rule the server enforces is that the last
administrator cannot be deleted or demoted -- that would lock the workspace out
of user management permanently.

### Tests

```bash
npm test
```

Runs both suites against an in-memory Postgres: `scripts/test-app.js` drives the
real HTTP API (sign-in, ticket intake, client progress, page permissions, the
last-admin guard), and `scripts/test-mail.js` stands up an actual SMTP server,
sends through the normal application path, and asserts on the bytes that
arrived.

## Client access & credential lifecycle

Clients never sign themselves up and never choose their own password. An
admin issues the credential, decides how long it stays valid, and can cut it
off at any time. There are two separate admin screens, and the split is
deliberate:

| Screen | Path | Purpose |
|---|---|---|
| **Team** | `/portal/team` | Internal staff only (Admin, Sales, Project Manager, Employee). Its role dropdown deliberately excludes Client, so a client account can't be created here and skip the credential rules below. |
| **Client Access** | `/portal/client-access` | Client logins only: issue, set/change expiry, reissue, revoke. |

### Issuing a login

1. Admin opens **Client Access** → *New Client Login* and enters name, login
   ID (email), company, and an expiry date (or ticks *No expiry*).
2. `POST /api/users` generates a 14-character password server-side with
   `crypto.randomBytes`, drawn from an alphabet that omits visually
   confusable characters (`0/O`, `1/l/I`) because an admin usually reads it
   aloud. The alphabet is 54 characters, so a 14-character password carries
   roughly 80 bits of entropy.
3. The password is hashed with bcrypt (cost factor 10) before it touches the
   database. The plaintext exists only in that one HTTP response.
4. The UI shows it once, with a copy button. There is no endpoint that can
   read it back - if it's lost, the only path forward is issuing a new one.
5. The admin relays it to the client over a separate channel (phone, chat).

### Expiry enforcement

`password_expires_at` is a millisecond timestamp on the `users` row. It is
checked in **three** places, so there's no way around it:

| Where | What it stops |
|---|---|
| `finishLogin()` in `routes/auth.js` | Password sign-in **and** Sign in with Google. Putting the check here rather than in the password branch alone means an expired client can't slip in through the Google button. |
| `requireAuth()` in `middleware/auth.js` | An **already-open session**. Sessions last 7 days, so without this a client who signed in the day before their deadline would keep working past it. The check runs on every authenticated request and deletes the session the moment it fails. |
| `PUT /api/users/:id` | Changing a password deletes that user's sessions, so "reissue" actually cuts off access instead of leaving the old cookie alive. |

Deleting a client (**Revoke**) also removes their sessions and any
outstanding login code in the same request.

An expired client sees a distinct amber "Access expired" state on the login
screen telling them to contact their admin, rather than a generic wrong-password
error.

### Full journey

```
Admin issues login ──► client gets ID + password out-of-band
        │
        ▼
Client enters ID + password ──► POST /api/auth/login
        │                        ├─ wrong password ─────► 401
        │                        └─ expired ────────────► 403 "Access expired"
        ▼
  6-digit OTP generated and emailed to the account holder
        │            (no mail transport? an admin reads it out of Login Codes)
        │
        ▼
Client enters code ──► POST /api/auth/verify-otp ──► session promoted, signed in
        │
        ▼
Every later request re-checks expiry in requireAuth()
```

## Where the data is stored

**Everything is stored server-side, in either PostgreSQL or Firestore.**
Nothing sensitive is in browser storage, and the browser never talks to the
database directly under either driver.

Pick the driver with `DB_DRIVER`:

| `DB_DRIVER` | Backing store | Requires |
|---|---|---|
| `postgres` (default) | PostgreSQL | `DATABASE_URL` |
| `firestore` | Cloud Firestore | `FIREBASE_SERVICE_ACCOUNT_JSON` |

If `DB_DRIVER` is unset the app infers it: Firestore when a service account
is configured *and* `DATABASE_URL` is not, otherwise Postgres. Setting both
without `DB_DRIVER` keeps Postgres — so adding a Firebase key to enable
Google sign-in can't silently relocate an existing deployment's data.

Both drivers implement the same async API
(`find/all/filter/recent/insert/update/remove/removeWhere/incrementIfBelow`),
so **no route file knows which one is active**:

- `db/schemas.js` — the per-collection field whitelist, shared by both.
- `db/setup.js` — Postgres driver + driver selection.
- `db/firestore.js` — Firestore driver (Admin SDK only).

### Firestore specifics

- **Admin SDK only.** No Firestore client SDK is bundled in the frontend.
- **`firestore.rules` denies every client read and write.** That's the whole
  posture and it's deliberate: the Admin SDK bypasses rules by design, so a
  blanket deny costs nothing and means the public web config (`apiKey`,
  `projectId` — which ship to every browser and are *not* secrets) can't be
  used to open a direct connection that reads anything. Deploy it with
  `firebase deploy --only firestore:rules`.
- **The OTP attempt cap uses a Firestore transaction**, mirroring the
  Postgres conditional `UPDATE`. Both close the same race: concurrent verify
  requests reading the same pre-increment value and slipping past the limit.
- Documents store camelCase fields directly, so there's no snake_case
  mapping on this driver.

The table below describes the Postgres schema; the Firestore collections
carry the same names and the same (camelCased) fields.

| Table | Holds | Notes on sensitive fields |
|---|---|---|
| `users` | Accounts: name, email, role, company, password, `password_expires_at` | `password` is a **bcrypt hash**, never plaintext. Stripped from every API response by `safeUser()`. |
| `sessions` | Session id, user id, CSRF token, expiry, `pending` flag | The session id is the only thing in the cookie. `pending` marks a login that passed the password step but not yet OTP. |
| `otp_codes` | 6-digit login codes, user id, IP, expiry, attempt count | Codes are excluded from the list endpoint and fetched one at a time via an audited reveal call. Expired rows are pruned automatically. |
| `login_links` | One-tap sign-in links: user id, SHA-256 of the link secret, IP, 15-minute expiry, single-use flag | Client accounts only. The secret itself is never stored, so a database leak cannot be replayed as a login. |
| `activity_log` | Who did what, when | Every credential issue, password regeneration, and OTP reveal lands here. |
| `projects`, `tasks`, `tickets`, `domains`, `reports`, `budget_items`, `billing`, `notifications` | Core CRM records | Scoped per role at the route layer. |

Set `DATABASE_URL` to any standard Postgres host (Vercel Postgres, Neon,
Supabase, self-hosted). For local development `npm run dev:pgmem` runs an
in-memory Postgres that resets on restart - convenient for demos, not for
real data.

### What Firebase is actually used for

Firebase can play up to three separate roles here, and they're independent —
you can use any one without the others:

1. **Firestore as the database** (`DB_DRIVER=firestore`). Needs
   `FIREBASE_SERVICE_ACCOUNT_JSON`. See above.
2. **A fallback popup for "Sign in with Google."**
3. **The 2FA contact toggle in Settings.**

**Firebase Authentication is *not* used to log anyone in.** Even with
Firestore as the database, the app's own auth is what runs: bcrypt password
hashes, server-side sessions, and the admin-issued OTP. Firebase never
decides who gets in.

A note on the keys, because it trips people up: the four `FIREBASE_*` client
values (`API_KEY`, `AUTH_DOMAIN`, `PROJECT_ID`, `APP_ID`) are **public** —
they ship inside every browser bundle and grant no access on their own. The
only Firebase secret is `FIREBASE_SERVICE_ACCOUNT_JSON`, which is read
server-side only and must never be committed. Having the four public values
is *not* enough to store data in Firestore.

The two optional sign-in features, in detail:

1. **A fallback popup for "Sign in with Google."** The primary path is Google
   Identity Services (`GOOGLE_CLIENT_ID`). If the Firebase config is present,
   `frontend/src/lib/firebase2fa.ts` can open a Firebase Google popup instead
   and hand the resulting ID token to `POST /api/auth/google`. The server
   verifies that token, then looks the email up in **your own database** — if
   there's no account there, sign-in is refused. Firebase can never create an
   account or grant access on its own.
2. **The 2FA contact toggle in Settings**, which uses Firebase to prove a
   user controls a phone number or email. This is currently vestigial — it
   isn't wired into login (see Known limitations).

Leaving all `FIREBASE_*` variables unset is a fully supported configuration
when you're on Postgres: every other feature keeps working.

## Security model

| Control | Implementation |
|---|---|
| Password storage | bcrypt, cost 10. Plaintext never persisted; returned exactly once at generation. |
| Password generation | `crypto.randomBytes` (CSPRNG), ~80 bits of entropy. Never `Math.random()`. |
| Session transport | `httpOnly`, `sameSite: lax`, `secure` in production. The browser can't read the cookie from JavaScript. |
| CSRF | Per-session token required on every mutating request (`requireCSRF`). |
| Authorisation | `requireRole('admin')` on all credential endpoints; role checks again at the route layer, never in the UI alone. |
| Brute force | Rate limits on `/auth/login` (20 per 15 min) and `/auth/verify-otp` (30 per 15 min), on separate buckets so a mistyped OTP can't lock someone out of login itself. |
| OTP guessing | 5-attempt cap enforced with an atomic `UPDATE ... WHERE attempts < max`, so concurrent requests can't race past the limit. Codes compared with `crypto.timingSafeEqual`. |
| Secret exposure | `safeUser()` strips password fields from every response. OTP codes are never in list responses - each reveal is a separate, audited call. |
| Audit trail | `activity_log` records every issue, regeneration, reveal, login, and deletion. |
| Self-registration | Impossible. Both password and Google paths require an account an admin already created. |
| XSS | A real Content-Security-Policy (`server.js`). The bundle has no inline `<script>`, so `script-src 'self'` plus the two Google origins is enough — injected script won't execute even if it reaches the DOM. `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'self'` (no clickjacking). |
| CORS | Off by default. Both supported setups are same-origin (Express serves the SPA; Vite proxies `/api` server-side), so no cross-origin permission is granted at all. Opt in per-origin with `CORS_ORIGINS`. |
| Transport | TLS enforced for any non-localhost database host; HSTS, `nosniff`, and `Referrer-Policy: no-referrer` via helmet. |
| Availability | Pool capped per instance, 10s connection timeout, and an idle-client error handler — without which a routine dropped connection from a hosted provider crashes the Node process. |
| Live stream | `/api/events` is behind `requireAuth`. Events carry a topic only; delivery is filtered per stream by role and by the client's `allowedPages`, and per-account topics (`notifications`, `session`) reach only the named account. Capped at 4 streams per user. |
| Offline cache | The service worker refuses to cache any `/api/` response, and signing out wipes the caches it does hold. |
| Card data | Never touches this server. Checkout and card changes happen on Stripe-hosted pages; the app stores only the brand and last four Stripe reports back. |
| Webhook trust | `stripe.webhooks.constructEvent` verifies the signature before a single field of the body is read. An unsigned or mis-signed request is refused with a 400 and nothing is written. |
| Payment replay | Every mirrored payment is keyed by its Stripe object id, so a replayed webhook updates one row instead of creating a second — and receipt emails only go out on first insert. |
| Admin roster | Only a super admin can create, promote, demote, or delete an administrator. The last super admin cannot step down, and a super admin cannot be deleted by anyone else. |
| Second signature | A sensitive change by an admin who has not been vouched for is written to `approval_requests` and executed only when someone else signs it off. Nobody approves their own; an untrusted admin cannot approve at all. Checked in the route, before the write — the UI hiding a button is a courtesy, not the control. |
| Client channel | The Slack channel a client can read and write is taken from their own user record, never from the request, so there is no id to tamper with. Guarded by the `messages` page toggle, and a `D…` direct-message id is refused outright. |
| Client notification | A closure only emails the client once it is confirmed, and only ever to the address on that ticket. Held closures send nothing. |
| Approval integrity | The stored payload is the only input the executor gets, so what was approved is exactly what runs. The row is claimed before execution, making a double-approval a 409 rather than a second write. |
| Audit reach | The log is readable by a super admin only, and records the released change as well as the decision. |

## Login codes (OTP) flow

1. Anyone submits email + password at `/login` → `POST /api/auth/login`.
2. If the password is correct, the server creates a `pending` session
   (10-minute TTL) and inserts a row into `otp_codes`: a random 6-digit
   code, the user's id, `req.ip`, and a 5-minute expiry. The response is
   `{ requiresOtp: true }` - the code itself is never sent to the client
   that's logging in. This happens for every role, so the reply shape gives
   away nothing about which accounts are administrators.
3. The code is emailed to the account holder straight away, and the
   response carries `codeEmailed` plus a masked `codeDestination` so the
   login screen can say which inbox to look in. If no mail transport is
   configured the send is skipped, `codeEmailed` is false, and the login
   screen says to use a backup code or ask an admin. A **trusted** admin
   then opens **Login Codes** (`/portal/otp-monitor`, `GET
   /api/auth/otp-logs`), finds the row by name/email, clicks the eye icon
   to reveal the code, and relays it. Administrator rows never appear on
   that page and cannot be revealed; IP addresses are shown to a super
   admin only. The account whose code was read is notified.
4. The client types the code into the 6-box input and it's submitted to
   `POST /api/auth/verify-otp`. The server checks it against the newest
   non-consumed `otp_codes` row for that user, enforces a 5-attempt cap and
   the 5-minute expiry, then on success marks the code `consumed`, issues a
   **brand-new session** and destroys the pending one, and logs them in.
   The identifier that existed before the person proved who they were never
   survives into the session that follows.
5. An administrator may type a backup code here instead of the emailed one.
   See [Backup codes and getting back in](#backup-codes-and-getting-back-in).

Delivery is by email only; there is no SMS provider wired up. The server
warns at boot when no mail transport is configured, because that is the one
state where signing in depends on somebody else.

## Backup codes and getting back in

Requiring a code to finish an admin sign-in puts the mail transport on the
critical path of getting into the building. If mail broke while every
administrator happened to be signed out, nobody could get in - and the
Login Codes page is no help, because reaching it means already being signed
in. Two things close that.

**Backup codes.** Every administrator holds eight one-time codes shaped
`XXXXX-XXXXX`, from an alphabet with no look-alike characters because they
get read down a phone line. Managed at **Security** (`/portal/security`);
a new administrator is issued a set alongside their temporary password.

- They replace the *second* factor, not the first. A backup code is only
  accepted against a session that has already passed the password step.
- Only the bcrypt hash is stored, so the table is not a list of working
  credentials and the server cannot re-display them. They are shown once.
- One use each. Generating a new set invalidates every earlier code.
- Using one is announced in-app to every other administrator and written to
  the audit log as `via: recovery_code`. A quiet break-glass would be worse
  than no record at all.
- Administrators only. Everyone else has an admin who can read their code
  off the Login Codes page.

**The break-glass tool**, for the one case backup codes cannot cover: a
deployment where mail has never worked and no administrator has ever signed
in, so nobody holds a code and nobody can generate one.

```bash
npm run admin:recovery -- list
npm run admin:recovery -- issue admin@example.com --reason "mail down" --yes
```

Run on the server. It issues a fresh set for one named administrator and
prints them once. Nothing happens without `--yes`; the bare command is a dry
run. It refuses any account that is not an administrator, never touches a
password, writes an audit entry marked `issued_from_server`, and alerts
every other administrator.

It grants no power that server access did not already carry - anyone who can
run it can already rewrite a password hash in the database by hand. What it
adds is a supported way to do it that leaves a record. Treat shell access to
this server as equivalent to administrator access to the workspace.

## One-tap sign-in links

### Choosing how long a link lives

An admin picks the lifetime when they mint one — 5 minutes to 7 days — because
handing a link over on a call and emailing it to another timezone are different
problems. The choice is remembered between links so somebody issuing several
does not re-pick each time.

`POST /api/auth/login-link/:userId` takes `expiresInMinutes`. The value is
**clamped, not trusted**: this is a bearer credential, and "expires in a year"
is not a choice worth offering however it arrives. `resolveTtl()` in
`utils/loginLinks.js` holds the bounds:

| Asked for | Used |
|---|---|
| 60 | 60 minutes |
| 1 | 5 minutes (floor) |
| a year | 7 days (ceiling) |
| nonsense, or negative | 15 minutes (the default) |
| omitted | 15 minutes |

The lifetime that was actually used is written to the audit log alongside who
issued it, so a long-lived link is a question somebody can answer later.

For clients, a 14-character password plus a 6-digit code is two secrets to
type on a phone keyboard. A sign-in link is neither.

1. An admin opens **Client access** (`/portal/client-access`) and clicks
   **Sign-in link** on a client's row → `POST /api/auth/login-link/:userId`
   (admin-only, CSRF-checked). There is deliberately no public endpoint: a
   link signs in whoever opens it, so an admin decides who gets one.
2. Only **client** accounts are eligible. Staff and admin accounts can issue
   credentials and change other people's access, which a pasteable URL is
   not a strong enough gate for. An expired client is refused with a message
   naming the fix.
3. Any previous unused link for that client is deleted first, so a stale one
   handed over earlier stops working. The new row goes into `login_links`;
   the URL carries `<row id>.<32 random bytes>` and only the SHA-256 of the
   secret half is stored, so the database holds nothing replayable.
4. The response is a **path**, not an absolute URL, and the portal prefixes
   it with `window.location.origin`. That is what makes the link work on
   whatever address the portal is actually served from - in development the
   Vite origin (`http://localhost:5173`), which proxies `/api` to the
   backend. The backend only ever sees the proxy's own host
   (`127.0.0.1:4000`), so a URL built server-side would point at the wrong
   place. `url` in the response is the `APP_BASE_URL` version, for callers
   that are not a browser.
5. Opening the link hits `GET /api/auth/magic-link/verify`, which checks the
   15-minute expiry, compares the secret in constant time, claims the row
   with an `UPDATE ... WHERE consumed = FALSE` (so two clicks racing each
   other cannot both win), mints a full session, and redirects to `/portal`.
   Failures redirect to `/login?linkError=used|expired|invalid|access_expired`
   and the login page explains each one.

Client sessions last 30 days rather than the 7 days staff get, because for
a client every expiry is a sign-in round trip they did not ask for.

### Connecting a real Postgres (Supabase)

Until `DATABASE_URL` is set, `npm run dev:pgmem` runs against an **in-memory**
database that resets on every restart. To make data persist:

1. [supabase.com](https://supabase.com) → New project. Save the database
   password it generates.
2. **Project Settings → Database → Connection string.** Pick the variant that
   matches how you run the app:

   | Variant | Port | Use when |
   |---|---|---|
   | Transaction pooler | 6543 | Vercel / any serverless deploy |
   | Session pooler | 5432 (host contains `pooler`) | long-running `node server.js` |
   | Direct connection | 5432 (`db.<ref>.supabase.co`) | rarely — IPv6-only on newer projects, so it often fails from IPv4 networks and from Vercel |

3. Put it in `.env`, replacing `[YOUR-PASSWORD]`:
   ```
   DATABASE_URL=postgresql://postgres.abcdefgh:PASSWORD@aws-0-eu-west-1.pooler.supabase.com:6543/postgres
   ```
   URL-encode special characters in the password (`@`→`%40`, `#`→`%23`,
   `/`→`%2F`), otherwise the URL parses wrongly and surfaces as a confusing
   authentication error.
4. Verify the connection before starting anything:
   ```bash
   npm run db:check
   ```
   It reports the server version, which tables exist, and row counts — and
   on failure translates the common opaque errors (`ENOTFOUND`, `ETIMEDOUT`,
   `Tenant or user not found`) into the actual fix.
5. Start the app. Tables are created automatically (`CREATE TABLE IF NOT
   EXISTS`) and `seed()` inserts the demo data — no migration step.

`.env` is loaded by the npm scripts via Node's built-in
`--env-file-if-exists=.env` (Node 20.6+). There's no `dotenv` dependency, and
nothing loads `.env` if you run `node server.js` directly — use `npm run dev`
or `npm start`. On Vercel, environment variables come from the project
settings and no `.env` file exists, which the `-if-exists` form handles.

To develop offline against the in-memory database instead, use
`npm run dev:pgmem` (data resets on every restart).

TLS is enabled automatically for any non-localhost host. Connection pooling
is capped per instance (`PG_POOL_MAX`, default 5) so serverless instances
can't collectively exhaust the provider's connection limit.

### Switching storage to Firestore

1. [console.firebase.google.com](https://console.firebase.google.com) → your
   project → **Firestore Database** → Create database → production mode.
2. ⚙️ **Project Settings → Service Accounts → Generate new private key**.
   This downloads a JSON file. It is a secret.
3. Put it in `.env` on one line, and select the driver:
   ```
   DB_DRIVER=firestore
   FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...", ...}
   ```
4. Deploy the lockdown rules:
   ```bash
   firebase deploy --only firestore:rules
   ```
5. Start the app. `seed()` runs on boot and populates the demo data if the
   collections are empty, exactly as it does on Postgres.

If the server exits complaining the key "looks like the public web config,
not a service account key", you pasted the four public `FIREBASE_*` values
instead of the downloaded JSON — go back to step 2.

### Setting up Sign in with Google

1. [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) → Create Credentials → OAuth client ID → Web application.
2. Add the site URL (e.g. `https://your-crm.vercel.app`) under Authorized JavaScript origins.
3. Set the client ID as `GOOGLE_CLIENT_ID`.

### Setting up Firebase (Google sign-in popup fallback + Settings 2FA toggle)

Not required for the login-OTP flow - only for the Firebase-popup path of
Sign in with Google, and the currently-vestigial 2FA contact toggle in
Settings (see Known limitations).

1. [console.firebase.google.com](https://console.firebase.google.com) → create a project.
2. Project Settings → General → add a Web App → copy the config values into `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`.
3. Authentication → Sign-in method → enable Phone and Email link (passwordless sign-in), if you plan to wire the Settings toggle back into login.
4. Project Settings → Service Accounts → Generate new private key → set the downloaded JSON as `FIREBASE_SERVICE_ACCOUNT_JSON`.

### Setting up Stripe billing

1. [dashboard.stripe.com](https://dashboard.stripe.com) → create an account (test mode is fine to start).
2. Products → add a recurring product → copy its Price ID → `STRIPE_PRICE_ID`.
3. Developers → API keys → copy the Secret key (`STRIPE_SECRET_KEY`) and Publishable key (`STRIPE_PUBLISHABLE_KEY`).
4. Developers → Webhooks → add endpoint `https://your-crm.vercel.app/api/billing/webhook`, subscribe to `customer.subscription.created` and `customer.subscription.updated` → copy the signing secret to `STRIPE_WEBHOOK_SECRET`.

### Setting up Google Drive (report storage)

1. [console.cloud.google.com](https://console.cloud.google.com) → enable the Google Drive API on your project.
2. IAM & Admin → Service Accounts → create a key (JSON) → set it as `GOOGLE_SERVICE_ACCOUNT_JSON`.
3. Create a Drive folder for reports, share it with the service account's email (found in the JSON) as Editor.
4. Copy the folder ID from its URL → `GOOGLE_DRIVE_FOLDER_ID`.

## A client's own Slack channel

A client has no Slack account and never needs one. When their login is issued,
an admin names **one** channel; the server reads and writes it on their behalf,
and that channel becomes a two-way chat on their **Messages** page.

### The scoping rule

The channel id is read from the signed-in user's own record, **never from the
request**. There is no parameter for a client to tamper with, because they never
name a channel — they ask for "my channel" and the server knows which that is.
Staff may pass `?clientId=` and get exactly what that client sees.

`GET /api/client/channel` and `POST /api/client/channel/messages` are both
behind the `messages` page toggle, so switching the section off closes reading
*and* writing in one move.

A channel id must look like one (`C…` or `G…`). A direct-message id (`D…`) is
refused: that is one person's inbox, not a room a team shares.

### Everything in the channel is visible

That is the point of designating one — it is the shared room, the way a Slack
Connect channel is. The admin screen says so beside the picker rather than
burying it:

> They can read **everything** in this channel and write into it. Pick one
> shared with them, not an internal room.

Internal chatter belongs in a different channel. This is deliberately not the
per-ticket thread behaviour (`CLIENT_SLACK_THREAD`), which defaults to showing
only what the bot posted.

### Attribution

The client posts through the app's bot, because they have no Slack identity of
their own, so every portal message carries the sender's name explicitly:
`*David Shaw (BrightPath Retail Co.)*`. Without that the team would see an
unattributed line from a bot and have to guess. A zero-width marker on those
messages is what lets the portal tell the client's own words from the team's
and put them on the right side of the conversation.

### The bot joins by itself

`conversations.history` fails with `not_in_channel` until the bot is a member,
which used to mean somebody had to remember `/invite` for every client channel.
Now:

- **When the channel is assigned**, the server calls `conversations.join` right
  away and reports the outcome to the admin who chose it — while they are still
  looking at the screen, rather than as an empty page the client discovers later.
- **On any later `not_in_channel`**, `withChannelAccess()` joins and retries the
  call once, so a channel that was recreated or a bot that was removed heals
  itself on the next read.

This needs the **`channels:join`** scope on the Slack app. Without it the app
says exactly that instead of failing vaguely.

Private channels cannot be self-joined — that is Slack's design, not a
limitation here — so those return an instruction: *"That is a private channel.
Invite the bot to it with /invite."*

### Freshness

Slack has no webhook pointed at this app, so the page polls every 15 seconds
and on window focus — fast enough to read as a conversation, slow enough to sit
well inside Slack's rate limits with a workspace full of clients.

## Domain expiry reminders

A domain lapsing quietly is one of the few failures in this app a client cannot
undo afterwards: the address goes back on the market and somebody else can take
it. So the reminders are automatic.

### The schedule

| Days from expiry | 30 | 14 | 7 | 3 | 1 | 0 | -1 | -7 |
|---|---|---|---|---|---|---|---|---|
| Email the client | yes | yes | yes | yes | yes | yes | yes | yes |
| Also alert admins | | | yes | yes | yes | yes | yes | yes |

One early warning while renewing is still routine, a few in the week it
matters, then the day itself -- and two afterwards, because most registrars
hold a lapsed name for a grace period and it can usually still be recovered.
Admins are only copied once it is genuinely urgent; a monthly heads-up that
pages the whole team teaches everyone to ignore the alerts that matter.

### Each reminder is sent exactly once

The email log is the record, keyed as `domainId#expiryDay#milestone`. Because
the key carries the **expiry date**, renewing the domain changes the key and
starts a fresh series — a renewal resets the reminders rather than silencing
them forever. Re-running the sweep sends nothing new.

A sweep that has not run for a few days would otherwise skip straight past a
milestone and never mention it, so the first milestone *at or below* the days
remaining is used. The once-only key stops that catch-up from firing the whole
series at once.

### What the client reads

The email leads with the date and says plainly what happens if nothing is done.
The fact that decides whether it works is **whether the domain renews itself** —
that is the difference between "act today" and "no action needed", so it is a
field in the panel rather than a line of small print. Once the date has passed
the tone changes rather than escalating: "this can still be saved", not "too
late". Preview it on the Mail page under *Domain expiring*.

It goes to the client on `domains.client_id` and to nobody else. A domain with
no client email falls back to alerting the admins, so it is never silently
dropped.

### When it runs

No scheduler — this app runs on serverless, where background timers do not
survive a cold start. The sweep piggybacks on traffic: a staff request to
`GET /api/domains` may trigger it, at most once an hour, and never blocks the
response. **Check domains** on the Mail page runs it on demand, which is what
you want after correcting an expiry date or when nobody has opened the Domains
page in a while.

Dates parse from both the human form the renew action writes (`Sep 14, 2026`)
and ISO strings. A record with no usable date is skipped rather than crashing
the sweep.

## Testing email before a domain is verified

Most providers refuse to deliver anywhere except the account owner's inbox
until you verify a sending domain. SMTP2GO answers with a 4xx and an
`error_code` such as `E_ApiResponseCodes.SENDER_NOT_VERIFIED`:

> You can only send testing emails to your own email address (...). To send
> emails to other recipients, please verify a domain.

Two things handle this.

**`MAIL_REDIRECT_TO`.** Set it to the address the provider *will* accept, and
every outbound message goes there instead, with the intended recipient in the
subject: `[to: client@example.com] Your weekly summary`. The mail log still
records who the message was for, so the record is never a fiction. Unset it and
delivery behaves exactly as before. This is the way to walk a client-facing
flow end to end before DNS is sorted.

**Readable failures.** `explainSendError()` turns a provider's JSON into one
sentence an admin can act on, and the raw text still goes to the mail log for
whoever debugs it. A 403 about domain verification becomes:

> Your email provider is still in test mode: it will only deliver to
> you@example.com. Verify a sending domain, or set MAIL_REDIRECT_TO to that
> address to keep testing.

The real fix is still to verify a domain with your provider and point
`MAIL_FROM` at an address on it.

## Super admin and approvals

A workspace has one thing it cannot do without: somebody who can appoint
administrators. That is the super admin.

### A super admin is a flagged admin, not a sixth role

`users.is_super_admin` sits on top of `role = 'admin'`. This is the decision the
whole design rests on: every `requireRole('admin')` and every
`role === 'admin'` already written in this app grants a super admin access
without being touched, so a permission cannot be lost by somebody forgetting to
add a role to a list. Only the two genuinely exclusive powers read the flag --
appointing admins, and reading the log. See `utils/roles.js`.

The three states an administrator can be in:

| State | Appoints admins | Reads the log | Acts alone | Can sign off others |
|---|---|---|---|---|
| Super admin | yes | yes | yes | yes |
| Trusted admin | no | no | yes | yes |
| New admin | no | no | **no** | no |

A newly appointed admin starts **untrusted**. That is the point: the account
created five minutes ago is the one worth a second pair of eyes. A super admin
lifts it from **Team** once they know the person.

### What happens when a new admin changes something important

```
new admin proposes  ->  202, nothing written  ->  every approver alerted (bell + email)
                                              ->  approver signs off  ->  the change runs, once
```

The route calls one line before it writes:

```js
const gate = await approvals.gate(req, res, {
  action: 'user.delete',
  summary: `Delete the account for ${target.name}`,
  payload: { userId: target.id },
});
if (gate.held) return;   // 202 already sent; nothing has changed
```

Anyone entitled to act alone falls straight through and the route behaves
exactly as it did before. Guarded today: creating, changing, and deleting
accounts; deleting a project, domain, document, or ticket; and **closing a
ticket**.

### Closing a ticket is guarded, because it emails the client

Marking a ticket `Resolved` or `Closed` tells the client their request is
finished — by email, in their bell, and in the Slack thread. That is not a
message you un-send, so an admin who has not been vouched for proposes it and a
trusted admin confirms. Everything else about the ticket (priority, assignee,
description) still saves immediately; only the closure waits.

The subtle part is *where* the client email lives. It used to sit in the route,
which the approval path skips — a ticket could have been closed through the
queue while the client was never told. `utils/ticketStatus.js` now owns the
whole status change (update, bell, client email, Slack echo, ClickUp sync,
`resolved_notified_at`) and **both** paths call it, so the two cannot drift. The
route's own copy was deleted rather than left alongside it.

The client email always goes to the account on `ticket.client_id` and to nobody
else — the dedicated client for that ticket, never an admin and never a shared
inbox. The announcement is made in the name of whoever *proposed* the closure,
not whoever countersigned it: the client should read "Ryan closed your ticket",
which is true, rather than the name of an approver they have never dealt with.

**The response is a 202, not a 200.** `fetch` treats both as success, so every
gated mutation in the UI runs its result through `wasHeld()` -- otherwise the
person is told "done" about a change that has not happened, and does it twice.

### The rules that no approval can unlock

Some things are not gated, they are refused outright:

- Only a super admin may create, promote, demote, or delete an **administrator**.
- Nobody approves their own request, however senior.
- A super admin cannot be deleted; they are stepped down first.
- The last super admin cannot step down -- appoint another one first.
- An untrusted admin cannot approve, or two fresh accounts could wave each
  other through.
- Admin standing changes through its own endpoint (`POST /api/users/:id/standing`),
  never as a field on an ordinary profile update.

### Execution happens exactly once

Approving claims the row (`pending -> approved`) *before* running anything, so
two approvers racing cannot both execute it, and a second approval of a decided
row is a 409. If the change fails after the signature, the row is marked
`failed` with the error -- both facts stay on the record rather than one being
quietly dropped. A proposal nobody answers expires by itself after 48 hours.

### The log

`GET /api/approvals/audit-log`, super admin only, backed by `activity_log`.
Approving writes **two** rows: the decision, and the change it released --
attributed to whoever proposed it, with `meta.approvedBy` naming who let it
through. A log that only recorded decisions could not answer what actually
happened.

### Getting a super admin

Set `SUPER_ADMIN_EMAIL` to name the account. Otherwise the first boot after
this feature shipped promotes the longest-standing admin, so an existing
deployment gains one without anyone running a script (`ensureSuperAdmin()`).

## The live wire (admin to client updates)

A client watching their dashboard should not have to refresh to find out that
their ticket moved. One stream per tab handles that.

```
admin writes  ->  middleware/live.js  ->  utils/liveBus.js  ->  /api/events  ->  browser refetches
```

**What travels.** A frame is `{"topic":"budget","at":1723...}` and nothing
else. No amount, no name, no id. The browser reacts by invalidating the
matching React Query keys, which refetch through the ordinary endpoints --
`requireAuth`, `requireRole`, and `requirePage` all still apply. That is the
whole security argument: the stream cannot leak what it never carries, and it
cannot bypass a check it never performs.

**Who hears it.** `utils/liveBus.js` filters every event per open stream:

- Staff hear everything their role covers, because their screens are the
  operations view of the whole workspace.
- A client hears a section-wide topic only if the admin left that section
  switched on for them (`allowedPages`), and only if the change is theirs --
  routes set `res.locals.liveAudience = [clientId]` where they know it.
- `notifications` and `session` are about one person and reach only the
  account named in the event.

**When it is not there.** Serverless hosts and buffering proxies cannot hold a
stream open. The browser notices, gives up after four failed attempts, and
falls back to polling every 30 seconds plus a refetch whenever the tab regains
focus or the device comes back online. Nothing on screen depends on the stream
existing -- it only makes updates fast.

**Wiring a new route.** Nothing to do, as long as it lives under a prefix in
`PATH_TOPICS` (`middleware/live.js`). Every successful non-GET response
publishes the topic for its prefix. Set `res.locals.liveAudience` when the
handler knows whose data it just touched.

**Sources outside this app.** A write here can announce itself; a change in
Slack or ClickUp cannot. Those need something to ask:

| Source | How it becomes live |
|---|---|
| This app's own writes | `middleware/live.js`, on every successful response |
| Notifications, approvals, sessions | published at the point of the change |
| Emails (`mail`), login codes (`otp`) | published when the row is written |
| **Slack client channels** | `utils/slackWatch.js` polls **server-side** and publishes `messages` |
| ClickUp task state | still a 60s refetch on the progress board — nothing tells us |

`slackWatch` is the pattern worth copying. Ten tabs watching one channel used
to mean ten polls every fifteen seconds and a fifteen-second wait each; now one
watcher asks once per channel every eight seconds and pushes the answer, so the
cost stops growing with the audience and everybody sees a reply together. It
does nothing at all when `liveBus.stats().streams` is zero — a workspace nobody
has open makes no Slack calls.

Client-side `refetchInterval`s that remain are **safety nets for a dead
stream**, not the mechanism: 120s where a topic covers the data, 60s only on
the progress board, which mirrors ClickUp.

## Money and Stripe

Every amount a client reads -- the dashboard headline, "Where your money went",
the payment history, the plan card -- comes from a Stripe object. Nothing is
typed in by hand, and nothing is reconciled by hand.

```
Stripe  ->  webhook / sync  ->  utils/stripeSync.js  ->  payments + billing  ->  the portal
```

**Two ways in, and they agree.** `POST /api/billing/webhook` handles the moment
something happens; `POST /api/billing/sync` (admin only) pulls a client's whole
history over the API. Both land in the same upsert, keyed by the Stripe object
id, so a webhook replayed three times updates one row three times rather than
billing anyone three times over. If webhooks are not set up at all, the sync
button alone keeps the portal correct.

**What is stored.** One `payments` row per invoice or standalone charge: amount
in major units, currency, status, the period it covers, the Stripe receipt and
invoice URLs, and the card brand and last four. The `billing` row caches the
subscription's price, interval, renewal date, and default card so the plan card
renders without a round trip.

**What is never stored.** Card numbers, and anything else that would make this
server part of the cardholder data environment. Checkout and the "Manage
payment method" button both hand off to Stripe's hosted pages.

**Emails.** A first-time `invoice.paid` sends the client a receipt; an
`invoice.payment_failed` sends the one email in the system that asks for
something. Both are idempotent on the mirror, so a retried webhook does not
re-thank or re-nag anyone. Preview them on the admin **Mail** page under
*Payment received* and *Payment failed*.

**Two different questions.** `budget_items` is what the team tracked spending on
a client's behalf -- ad spend, project costs. `payments` is what the payment
processor actually took from them. The portal shows both, labelled, and never
adds them together.

## Deploying to Vercel

1. Create a Postgres database: Vercel dashboard → project → Storage → Create Database → Postgres. This sets `DATABASE_URL` automatically.
   If you use Prisma Postgres instead of plain Postgres, copy the connection string that starts with `postgres://` into a variable named `DATABASE_URL`.
2. Add any of the optional environment variables listed above that you're ready to use.
3. Optional - migrate local data: `DATABASE_URL="<connection-string>" npm run migrate` copies `db/data/*.json` into the real database, preserving IDs.
4. Deploy:
   ```bash
   npm install -g vercel
   vercel login
   vercel --prod
   ```
   `vercel.json` runs `npm run build` as part of the deploy, which builds `frontend/` and copies its output into `public/`. Set the Vercel project's Root Directory to the repo root (not a subfolder) so this works out of the box.

## Database schema

All tables are defined in `db/setup.js` (`SCHEMAS` + `initSchema()`), and
created automatically on startup (`CREATE TABLE IF NOT EXISTS`) - there's no
separate migration step for a fresh database. Route code never writes raw
SQL; everything goes through `db.find/all/filter/insert/update/remove`
(see below), which maps camelCase JS objects to the snake_case columns
listed here.

| Table | Columns | Notes |
|---|---|---|
| `users` | `id, name, email, role, company, password, google_id, two_factor_enabled, two_factor_contact, password_expires_at, allowed_pages, is_super_admin, admin_trusted, admin_trusted_at, admin_trusted_by` | `role` is one of `admin, sales, project_manager, employee, client`. `password` is a bcrypt hash. `password_expires_at` is a millisecond timestamp (or `NULL` for no expiry) set from the Client Access console - see [Expiry enforcement](#expiry-enforcement). `two_factor_enabled`/`two_factor_contact` back the self-service toggle in Settings only - unrelated to the login OTP step below. |
| `projects` | `id, name, type, client_id, assigned_pm_id, status, description, created_at` | |
| `tasks` | `id, project_id, name, assignee_id, status, priority, due` | |
| `tickets` | `id, subject, category, client_id, assignee_id, status, description, created_at` | |
| `notifications` | `id, user_id, message, type, read, created_at` | |
| `sessions` | `id, user_id, csrf_token, created_at, expires_at, pending` | `pending` sessions (10 min TTL) exist between the password step and OTP verification; promoted to a full 7-day session on success. |
| `otp_codes` | `id, user_id, code, ip_address, created_at, expires_at, consumed, attempts` | One row per login attempt past the password step (non-admins only). 5-minute expiry, 5-attempt cap. Surfaced to admins via `GET /api/auth/otp-logs`. |
| `activity_log` | `id, actor_id, action, entity, entity_id, meta, created_at` | Generic audit trail, written by `middleware/auth.js`'s `audit()`. |
| `domains` | `id, client_id, domain_name, platform, hosting_provider, hosting_region, registrar, ssl_status, expires_at, auto_renew, dns_status, notes` | |
| `reports` | `id, client_id, name, category, storage_type, drive_file_id, drive_link, content_base64, mime_type, size_bytes, uploaded_by, created_at` | `storage_type` is `drive` or `database`; only one of `drive_file_id`/`content_base64` is populated depending on which. |
| `budget_items` | `id, client_id, label, amount, color, month` | |
| `billing` | `id, client_id, stripe_customer_id, stripe_subscription_id, plan, status, updated_at, currency, amount, interval, current_period_end, cancel_at_period_end, card_brand, card_last4, latest_invoice_url, synced_at` | One row per client (`client_id` is `UNIQUE`). Everything after `updated_at` is cached from Stripe so the plan card renders without a round trip. |
| `approval_requests` | `id, action, summary, payload, status, requested_by, requested_at, expires_at, decided_by, decided_at, decision_note, executed_at, execution_error` | One proposal awaiting a second signature. `action` names an entry in `utils/approvals.js` ACTIONS; `payload` is the only input its executor gets. `status` is `pending`, `approved`, `rejected`, `cancelled`, `expired`, or `failed`. See [Super admin and approvals](#super-admin-and-approvals). |
| `payments` | `id, client_id, stripe_customer_id, stripe_object_id, kind, description, amount, currency, status, paid_at, period_start, period_end, invoice_url, receipt_url, invoice_number, card_brand, card_last4, failure_message, created_at` | One row per Stripe invoice or standalone charge, never written by hand. `stripe_object_id` is `UNIQUE`, which is what makes a replayed webhook idempotent. `amount` is in major units. See [Money and Stripe](#money-and-stripe). |

### The `db` data-access layer

`db/setup.js` exports a small async API used by every route file instead of
raw queries:

- `db.all(collection)` - all rows.
- `db.find(collection, id)` - one row by id, or `null`.
- `db.filter(collection, predicate)` - `db.all()` + a JS `.filter()` (no SQL
  `WHERE`; fine at current scale, see Known limitations).
- `db.insert(collection, obj)` - `obj.id` defaults to a new UUID if omitted.
- `db.update(collection, id, patch)` - partial update, returns the new row.
- `db.remove(collection, id)` / `db.removeWhere(collection, predicate)`.
- `db.recent(collection, limit)` - like `all()`, but sorts/limits in SQL
  (`ORDER BY created_at DESC LIMIT`) instead of fetching everything into
  JS first. Use this instead of `all()` for anything read on a tight
  polling interval, like the OTP monitor.
- `db.incrementIfBelow(collection, id, field, max)` - atomically increments
  a counter only if it's still under `max`, in one SQL statement, and
  returns the updated row (or `null` if already at the cap). Used for the
  OTP attempt counter, where a plain read-then-write would race.

`collection` must be a key in `SCHEMAS`; any object key not listed in that
collection's column array is silently dropped on insert/update, so adding a
new column means adding it to both `SCHEMAS` and the matching
`CREATE TABLE`/`ALTER TABLE` statement in `initSchema()`.

## Roles and permissions

| Role | Access |
|---|---|
| Admin | Full access: users, projects, tasks, tickets, domains, budget, billing. |
| Sales | Create projects and domains, view all tickets and reports. |
| Project Manager | Manage projects, tasks, tickets, domains, and budget for assigned clients. |
| Employee | Tasks and tickets assigned to them only. |
| Client | Their own projects, domains, budget, tickets, and billing; can create tickets. |

All of the above is enforced server-side in `middleware/auth.js` and the
individual route handlers, not just hidden in the UI.

## Project structure

`frontend/` is the React + Vite app, in this same repo. `npm run build` (at
the repo root) builds it and copies the output into `public/`, which this
server serves as static files. `public/` is generated; don't edit it
directly.

```
./
├── server.js              Express app. Serves the API and the built frontend,
│                           with an SPA fallback route for client-side paths.
├── api/index.js            Vercel serverless entrypoint
├── vercel.json             API routing, SPA fallback, and build command for Vercel
├── config.js                Reads env vars, exposes public-safe config to the frontend
├── db/
│   ├── setup.js              Postgres data layer, schema, seed data
│   └── data/                 Local JSON fallback store (gitignored)
├── scripts/
│   ├── migrate-local-data.js  Copies db/data/*.json into Postgres
│   ├── dev-with-pgmem.js      Runs against an in-memory Postgres
│   └── build-frontend.js      Builds frontend/ and copies output into public/
├── middleware/auth.js       Sessions, CSRF, role guards
├── utils/
│   ├── googleAuth.js         Verifies Google ID tokens
│   ├── firebaseAdmin.js      Verifies Firebase ID tokens (2FA)
│   └── googleDrive.js        Uploads report files to Drive
├── routes/                  auth, users, projects, tasks, tickets, domains,
│                             reports, budget, billing, notifications, config
├── public/                  Build output (generated, do not edit)
└── frontend/                React + Vite SPA (its own package.json, see frontend/README.md)
```

## Local development with both projects

From `frontend/`, `npm run dev` starts this backend (against pg-mem) and
the Vite dev server together, with API requests proxied to the backend.
To run them separately:

```bash
npm run dev:pgmem          # at the repo root
npm run dev:frontend-only  # in frontend/
```

## Known limitations

- List endpoints generally read a full table and filter in application
  code rather than using SQL `WHERE` clauses. This is fine at the current
  scale; revisit if the dataset grows significantly.
- Rate limiting: `/api/auth/login` and `/api/auth/google` share a strict
  limit (20 attempts / 15 min per IP). `/api/auth/verify-otp` has its own,
  separate limit (30 attempts / 15 min per IP) - kept apart so retyping a
  mistyped code can't lock someone out of the password step itself. The
  rest of the API has a general limit (600 requests / 15 min per IP) -
  generous enough not to affect normal use, but bounded.
- The self-service 2FA toggle in Settings (`users.js`'s `/me/2fa/enable` /
  `/me/2fa/disable`, backed by `users.two_factor_enabled` /
  `two_factor_contact`) no longer affects login - it predates the OTP flow
  above and is currently vestigial. Either wire it into `finishLogin` as an
  extra check, or remove it, depending on whether you want per-user opt-in
  on top of the blanket OTP requirement.
- Password expiry has no automatic warning: nobody is emailed as a client's
  deadline approaches. The Client Access console surfaces it visually
  ("Expiring ≤ 7d" counter and an amber row badge), but an admin has to be
  looking. Wire a scheduled job into `notifications` if you want proactive
  alerts.
- Report uploads accept any file type up to the configured size limit;
  there's no MIME-type allowlist. Downloads are served with
  `Content-Disposition: attachment`, so browsers won't execute uploaded
  content - add a stricter allowlist if you need it for compliance reasons.
- CORS currently reflects any request origin (`cors({ origin: true })`).
  Session cookies are `SameSite=Lax`, so this doesn't expose authenticated
  cross-site requests in practice, but once you have a fixed production
  domain, restricting `origin` to an explicit allowlist is a reasonable
  hardening step.
- There's no self-service "forgot password" flow; only an admin can reset
  another user's password (`PUT /api/users/:id`). Adding one would need a
  transactional email provider, same as a typed-code email 2FA would.
