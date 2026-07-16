# EthixWeb CRM

An internal CRM for an IT / mobile / web / digital marketing agency — real
Express backend, real Postgres database, session auth with CSRF
protection, and five roles: **Admin, Sales, Project Manager, Employee,
Client**. Fully deployable to Vercel with persistent data.

## Run it locally

Requires [Node.js](https://nodejs.org) 18+.

### Option A — no database needed yet (quick look around)
```bash
npm install
npm run dev:pgmem
```
Runs the whole app against an in-memory Postgres emulator, seeded with demo
data. Nothing persists between restarts, but every feature works.

### Option B — a real local/remote Postgres
```bash
npm install
DATABASE_URL="postgres://user:pass@host:5432/ethixweb" npm start
```

## Demo logins

| Role | Name | Email | Password |
|---|---|---|---|
| Admin | Admin User | admin@ethixweb.local | `Admin#2026!` |
| Sales | Emily Turner | emily.turner@ethixweb.local | `Sales#2026!` |
| Project Manager | Ryan Coleman | ryan.coleman@ethixweb.local | `Manager#2026!` |
| Employee | Jordan Brooks | jordan.brooks@ethixweb.local | `Staff#2026!` |
| Client | David Shaw (BrightPath Retail Co.) | client@brightpath-retail.com | `Client#2026!` |

## What's in this version

Everything below was added on top of the original Projects/Tasks/Tickets/Team CRM:

- **Domains & Website Info** — one page per domain showing the platform it's
  built on (WordPress, Shopify, custom, etc.), hosting provider/region,
  registrar, SSL status, expiry, DNS, and a renew button. Includes a
  tooltip explaining what a "domain" is, for less technical clients.
- **Card / List view toggle** on Projects, Tasks, Tickets, and Domains —
  remembered per-page via the browser (localStorage), so everyone's
  preference sticks.
- **Reports** — real file upload/download. Stores to Google Drive if
  configured; otherwise falls back to the database with a 4MB limit and a
  visible banner explaining why.
- **Marketing Budget** — a proper stacked bar chart showing exactly how
  much is spent per channel (Google Ads, LSA, Social, etc.) with real
  dollar amounts, not just a plain donut. Add/remove line items per client.
- **Billing** — a $5/mo-style subscription page for clients, backed by
  real Stripe Checkout when configured.
- **Notifications** — moved from a separate sidebar tab into a bell icon
  in the topbar (next to the dark/light toggle), with a live unread badge
  and dropdown panel.
- **Accessibility widget** — a floating button (bottom-left, any page)
  with text size, high contrast, dyslexia-friendly font, reduce motion,
  and underline-links controls. Fully custom-built, no third-party
  account needed.
- **Sign in with Google** — a full-size Google-rendered button on the
  login page. Only shown once configured; existing accounts only (an
  admin has to add someone before they can use Google to sign in — this
  prevents random Google accounts from self-registering into your CRM).
- **Two-factor authentication** — via Firebase: a real SMS code for phone,
  or a secure sign-in link for email (see the note on email 2FA below).
  Users turn it on themselves from Settings.

## ⚠️ Before these are "real" (not just UI), you need accounts

Every integration below is **feature-gated** — if its environment
variables aren't set, the UI shows a clear "not configured yet" message
instead of a broken button. Nothing crashes; you can add these one at a
time, whenever you're ready, and each flips on automatically after you
add its variables and redeploy.

### 1. Sign in with Google
1. Go to [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
2. Create Credentials → OAuth client ID → Web application
3. Add your site's URL (e.g. `https://your-crm.vercel.app`) to "Authorized JavaScript origins"
4. Copy the Client ID → set as `GOOGLE_CLIENT_ID`

### 2. Two-factor authentication (Firebase)
1. Go to [console.firebase.google.com](https://console.firebase.google.com) → Create a project
2. Project Settings → General → add a Web App → copy the config values into `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`
3. Authentication → Sign-in method → enable **Phone** and **Email link (passwordless sign-in)**
4. Project Settings → Service Accounts → Generate new private key → paste the whole downloaded JSON as `FIREBASE_SERVICE_ACCOUNT_JSON`

**Honest note on email 2FA:** Firebase's native email-based verification
is a secure sign-in **link** (click it to confirm), not a typed 6-digit
code — a real numeric email code would need a separate transactional
email provider wired up server-side (e.g. SendGrid/Resend/Postmark). The
phone method is a real, typed SMS code. This is clearly labeled in the UI
either way — happy to wire up a true email-code flow if you'd rather have
that; it just needs one more account (an email-sending provider).

### 3. Stripe billing
1. Go to [dashboard.stripe.com](https://dashboard.stripe.com) → create an account (test mode is fine to start)
2. Products → add a $5/mo recurring product → copy its Price ID → `STRIPE_PRICE_ID`
3. Developers → API keys → copy Secret key (`STRIPE_SECRET_KEY`) and Publishable key (`STRIPE_PUBLISHABLE_KEY`)
4. Developers → Webhooks → add endpoint `https://your-crm.vercel.app/api/billing/webhook`, select events `customer.subscription.created` and `customer.subscription.updated` → copy the signing secret → `STRIPE_WEBHOOK_SECRET`

### 4. Google Drive (report storage)
1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create/select a project → enable the **Google Drive API**
2. IAM & Admin → Service Accounts → Create → Keys → Add key → JSON → download it, paste the whole file as `GOOGLE_SERVICE_ACCOUNT_JSON`
3. In Google Drive, create a folder for reports, share it with the service account's email (found inside that JSON, looks like `...@...iam.gserviceaccount.com`) as an Editor
4. Copy the folder's ID from its URL → `GOOGLE_DRIVE_FOLDER_ID`

## Deploy to Vercel

### 1. Create a Postgres database
Vercel dashboard → your project → **Storage** → **Create Database** → **Postgres**. This auto-adds `DATABASE_URL`.

**Gotcha:** if you used Vercel's **Prisma Postgres** product instead of
plain Postgres, it gives you three connection strings — only the one
starting with `postgres://` (usually named `POSTGRES_URL`) works with this
app. Copy that value into a variable literally named `DATABASE_URL`.

### 2. Add whichever integration variables you're ready for
Project Settings → Environment Variables → add any from the list above.
Skip whatever you don't have yet — the app works fine without them.

### 3. Migrate local data (optional)
```bash
DATABASE_URL="<paste-real-connection-string>" npm run migrate
```
Copies your local `db/data/*.json` into the real database, keeping IDs.
Safe to run once; your local files are never modified.

### 4. Deploy
```bash
npm install -g vercel
vercel login
vercel --prod
```

## What each role can do

- **Admin** — everything: manage all users, projects, tasks, tickets, domains, budget, billing.
- **Sales** — create projects/domains, view all tickets/reports.
- **Project Manager** — manage projects, tasks, tickets, domains, budget for their clients.
- **Employee** — sees only tasks/tickets assigned to them.
- **Client** — sees only their own projects, domains, budget, tickets, and billing; can create tickets.

Enforced on the server — verified directly with real HTTP requests during
development (an Employee gets a real 403 trying to create a project, a
Client's data is always scoped to just their own account, etc).

## Project structure

```
ethixweb-crm/
├── server.js                Express app (exports `app`; only calls .listen() when run directly)
├── api/index.js              Vercel serverless entrypoint
├── vercel.json               Routes /api/* to the function, everything else to public/
├── config.js                 Reads env vars, exposes only public-safe config to the frontend
├── db/
│   ├── setup.js               Postgres layer (async), schema, seed data
│   └── data/                  Local JSON "database" for npm start without a real DB (gitignored)
├── scripts/
│   ├── migrate-local-data.js  Copies db/data/*.json into Postgres
│   └── dev-with-pgmem.js      Run against an in-memory Postgres, zero setup
├── middleware/auth.js          Sessions (incl. pending 2FA sessions), CSRF, role guards
├── utils/
│   ├── googleAuth.js           Verifies Google ID tokens
│   ├── firebaseAdmin.js        Verifies Firebase ID tokens (2FA)
│   └── googleDrive.js          Uploads report files to Drive
├── routes/
│   ├── auth.js, users.js, projects.js, tasks.js, tickets.js
│   ├── domains.js, reports.js, budget.js, billing.js, notifications.js, config.js
└── public/
    ├── index.html              Login (Google button, demo logins, 2FA step)
    ├── portal.html             App shell (sidebar/topbar/bell/content)
    ├── verify-email.html       Landing page for Firebase email-link 2FA
    ├── app.js                  All frontend views, modals, API calls
    ├── firebase2fa.js           Firebase client SDK wrapper for 2FA
    ├── accessibility.js         Self-contained accessibility widget
    ├── styles.css               Design system
    └── assets/                  Logo + spiderweb watermark
```

## Honest limitations

- The DB layer fetches a full table then filters in JS for most list
  queries rather than hand-written SQL `WHERE` clauses. Fine at this
  scale (dozens–low thousands of rows); worth optimizing only if this
  grows into a large multi-tenant dataset.
- Rate limiting is applied to `/api/auth/login` (20 attempts / 15 min)
  but not yet to other endpoints.
- Email 2FA is a sign-in link, not a typed code (see the Firebase section
  above for why, and the alternative if you want a true code).
