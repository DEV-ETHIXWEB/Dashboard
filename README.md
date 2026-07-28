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
- **Two-factor authentication** — via Firebase: SMS code for phone, or a
  sign-in link for email. Users enable it themselves from Settings.
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
| `GOOGLE_CLIENT_ID` | Sign in with Google |
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON` | Two-factor authentication |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Billing |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_DRIVE_FOLDER_ID` | Report storage in Google Drive |

See `.env.example` for the full list with descriptions.

### Setting up Sign in with Google

1. [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) → Create Credentials → OAuth client ID → Web application.
2. Add the site URL (e.g. `https://your-crm.vercel.app`) under Authorized JavaScript origins.
3. Set the client ID as `GOOGLE_CLIENT_ID`.

### Setting up two-factor authentication (Firebase)

1. [console.firebase.google.com](https://console.firebase.google.com) → create a project.
2. Project Settings → General → add a Web App → copy the config values into `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`.
3. Authentication → Sign-in method → enable Phone and Email link (passwordless sign-in).
4. Project Settings → Service Accounts → Generate new private key → set the downloaded JSON as `FIREBASE_SERVICE_ACCOUNT_JSON`.

Note: Firebase's email-based verification is a sign-in link, not a typed
code. A typed email code would require a separate transactional email
provider (e.g. SendGrid, Resend, Postmark). The phone method is a typed SMS
code.

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
- Rate limiting: `/api/auth/login`, `/api/auth/google`, and
  `/api/auth/verify-2fa` have a strict limit (20 attempts / 15 min per IP).
  The rest of the API has a general limit (600 requests / 15 min per IP) —
  generous enough not to affect normal use, but bounded.
- Report uploads accept any file type up to the configured size limit;
  there's no MIME-type allowlist. Downloads are served with
  `Content-Disposition: attachment`, so browsers won't execute uploaded
  content — add a stricter allowlist if you need it for compliance reasons.
- CORS currently reflects any request origin (`cors({ origin: true })`).
  Session cookies are `SameSite=Lax`, so this doesn't expose authenticated
  cross-site requests in practice, but once you have a fixed production
  domain, restricting `origin` to an explicit allowlist is a reasonable
  hardening step.
- Email-based two-factor authentication uses a sign-in link rather than a
  typed code (see the Firebase setup section above).
- There's no self-service "forgot password" flow; only an admin can reset
  another user's password (`PUT /api/users/:id`). Adding one would need a
  transactional email provider, same as a typed-code email 2FA would.
