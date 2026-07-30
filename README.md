# EthixWeb CRM

Internal CRM for an IT / web / mobile / digital marketing agency. Express and
PostgreSQL backend with session-based authentication, CSRF protection, and
five user roles: Admin, Sales, Project Manager, Employee, Client.

This repo also contains the frontend (`frontend/`, a React + Vite project)
and serves its build output as static files, so the whole application
deploys as a single service.

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

- **Projects, Tasks, Tickets, Team** — core CRM entities, scoped per role.
- **Domains** — one record per client website: platform, hosting provider
  and region, registrar, SSL status, expiry, DNS status, and a renew action.
- **Reports** — file upload and download, stored in Google Drive when
  configured, otherwise in the database (4MB limit in that mode).
- **Budget** — per-client spend tracking by category, with totals and a
  breakdown view.
- **Billing** — client subscription management via Stripe Checkout.
- **Notifications** — per-user, with an unread count and a mark-all-read
  action.
- **Login codes (OTP)** — every non-admin login requires a second step: a
  6-digit code the client types in. The code isn't emailed or texted — it's
  generated the instant the password check succeeds and shown, masked, in
  the admin-only **Login Codes** page (`/portal/otp-monitor`), alongside the
  requester's name, email, and IP address. An admin reveals it and reads it
  out to the client over another channel (phone/chat). Admin accounts skip
  this step entirely — they're the only ones who can see the panel, so
  gating their own login behind it would lock everyone out. See
  [Login codes (OTP) flow](#login-codes-otp-flow) below.
- **Sign in with Google** — restricted to existing accounts; an admin must
  create the account first.

## Environment variables

Only `DATABASE_URL` is required to run the app. Everything else is optional
and independently feature-gated: if a variable isn't set, the related UI
shows a "not configured yet" state instead of erroring, and the feature
turns on automatically once you add the variable and redeploy.

| Variable | Enables |
|---|---|
| `DATABASE_URL` | Required. Postgres connection string. |
| `GOOGLE_CLIENT_ID` | Sign in with Google (Google Identity Services button) |
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase client SDK (Sign in with Google popup fallback) and the self-service 2FA contact toggle in Settings — **not** used by the login-time OTP step, which needs no configuration |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Billing |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_DRIVE_FOLDER_ID` | Report storage in Google Drive |

See `.env.example` for the full list with descriptions.

## Login codes (OTP) flow

1. Client submits email + password at `/login` → `POST /api/auth/login`.
2. If the password is correct and the account is **not** an admin, the
   server creates a `pending` session (10-minute TTL) and inserts a row
   into `otp_codes`: a random 6-digit code, the user's id, `req.ip`, and a
   5-minute expiry. The response is `{ requiresOtp: true }` — the code
   itself is never sent to the client that's logging in.
3. An admin opens **Login Codes** (`/portal/otp-monitor`,
   `GET /api/auth/otp-logs`, admin-only) and finds the row by name/email/IP,
   clicks the eye icon to reveal the code, and relays it to the client
   through another channel (phone call, chat, in person).
4. The client types the code into the 6-box input and it's submitted to
   `POST /api/auth/verify-otp`. The server checks it against the newest
   non-consumed `otp_codes` row for that user, enforces a 5-attempt cap and
   the 5-minute expiry, then on success marks the code `consumed`, promotes
   the pending session to a full one, and logs the client in.
5. Admin accounts skip steps 2–4 entirely (see `finishLogin` in
   `routes/auth.js`) — otherwise no admin could ever reach the panel needed
   to unlock their own login.

This intentionally has no automatic delivery channel (no SMS/email
provider integrated) — the admin is the delivery mechanism, by design.

### Setting up Sign in with Google

1. [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) → Create Credentials → OAuth client ID → Web application.
2. Add the site URL (e.g. `https://your-crm.vercel.app`) under Authorized JavaScript origins.
3. Set the client ID as `GOOGLE_CLIENT_ID`.

### Setting up Firebase (Google sign-in popup fallback + Settings 2FA toggle)

Not required for the login-OTP flow — only for the Firebase-popup path of
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

## Deploying to Vercel

1. Create a Postgres database: Vercel dashboard → project → Storage → Create Database → Postgres. This sets `DATABASE_URL` automatically.
   If you use Prisma Postgres instead of plain Postgres, copy the connection string that starts with `postgres://` into a variable named `DATABASE_URL`.
2. Add any of the optional environment variables listed above that you're ready to use.
3. Optional — migrate local data: `DATABASE_URL="<connection-string>" npm run migrate` copies `db/data/*.json` into the real database, preserving IDs.
4. Deploy:
   ```bash
   npm install -g vercel
   vercel login
   vercel --prod
   ```
   `vercel.json` runs `npm run build` as part of the deploy, which builds `frontend/` and copies its output into `public/`. Set the Vercel project's Root Directory to the repo root (not a subfolder) so this works out of the box.

## Database schema

All tables are defined in `db/setup.js` (`SCHEMAS` + `initSchema()`), and
created automatically on startup (`CREATE TABLE IF NOT EXISTS`) — there's no
separate migration step for a fresh database. Route code never writes raw
SQL; everything goes through `db.find/all/filter/insert/update/remove`
(see below), which maps camelCase JS objects to the snake_case columns
listed here.

| Table | Columns | Notes |
|---|---|---|
| `users` | `id, name, email, role, company, password, google_id, two_factor_enabled, two_factor_contact` | `role` is one of `admin, sales, project_manager, employee, client`. `two_factor_enabled`/`two_factor_contact` back the self-service toggle in Settings only — unrelated to the login OTP step below. |
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
| `billing` | `id, client_id, stripe_customer_id, stripe_subscription_id, plan, status, updated_at` | One row per client (`client_id` is `UNIQUE`). |

### The `db` data-access layer

`db/setup.js` exports a small async API used by every route file instead of
raw queries:

- `db.all(collection)` — all rows.
- `db.find(collection, id)` — one row by id, or `null`.
- `db.filter(collection, predicate)` — `db.all()` + a JS `.filter()` (no SQL
  `WHERE`; fine at current scale, see Known limitations).
- `db.insert(collection, obj)` — `obj.id` defaults to a new UUID if omitted.
- `db.update(collection, id, patch)` — partial update, returns the new row.
- `db.remove(collection, id)` / `db.removeWhere(collection, predicate)`.
- `db.recent(collection, limit)` — like `all()`, but sorts/limits in SQL
  (`ORDER BY created_at DESC LIMIT`) instead of fetching everything into
  JS first. Use this instead of `all()` for anything read on a tight
  polling interval, like the OTP monitor.
- `db.incrementIfBelow(collection, id, field, max)` — atomically increments
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
  separate limit (30 attempts / 15 min per IP) — kept apart so retyping a
  mistyped code can't lock someone out of the password step itself. The
  rest of the API has a general limit (600 requests / 15 min per IP) —
  generous enough not to affect normal use, but bounded.
- The self-service 2FA toggle in Settings (`users.js`'s `/me/2fa/enable` /
  `/me/2fa/disable`, backed by `users.two_factor_enabled` /
  `two_factor_contact`) no longer affects login — it predates the OTP flow
  above and is currently vestigial. Either wire it into `finishLogin` as an
  extra check, or remove it, depending on whether you want per-user opt-in
  on top of the blanket OTP requirement.
- Report uploads accept any file type up to the configured size limit;
  there's no MIME-type allowlist. Downloads are served with
  `Content-Disposition: attachment`, so browsers won't execute uploaded
  content — add a stricter allowlist if you need it for compliance reasons.
- CORS currently reflects any request origin (`cors({ origin: true })`).
  Session cookies are `SameSite=Lax`, so this doesn't expose authenticated
  cross-site requests in practice, but once you have a fixed production
  domain, restricting `origin` to an explicit allowlist is a reasonable
  hardening step.
- There's no self-service "forgot password" flow; only an admin can reset
  another user's password (`PUT /api/users/:id`). Adding one would need a
  transactional email provider, same as a typed-code email 2FA would.
