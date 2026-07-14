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

This runs the whole app against an in-memory Postgres emulator, seeded with
demo data. Great for trying it out, but nothing you do persists between
restarts.

### Option B — a real local Postgres

```bash
npm install
DATABASE_URL="postgres://user:pass@localhost:5432/ethixweb" npm start
```

## Demo logins

The login page has one-click buttons for all five, or use manually:

| Role | Name | Email | Password |
|---|---|---|---|
| Admin | Admin User | admin@ethixweb.local | `Admin#2026!` |
| Sales | Emily Turner | emily.turner@ethixweb.local | `Sales#2026!` |
| Project Manager | Ryan Coleman | ryan.coleman@ethixweb.local | `Manager#2026!` |
| Employee | Jordan Brooks | jordan.brooks@ethixweb.local | `Staff#2026!` |
| Client | David Shaw (BrightPath Retail Co.) | client@brightpath-retail.com | `Client#2026!` |

## Deploy to Vercel (step by step)

### 1. Create a Postgres database

Easiest path — Vercel's own integration:

1. Go to your project on [vercel.com](https://vercel.com), open the **Storage** tab
2. Click **Create Database** → choose **Postgres** (powered by Neon)
3. Once created, Vercel automatically adds a `DATABASE_URL` environment
   variable to your project — you don't need to copy/paste anything

(Alternative: create a free database directly at [neon.tech](https://neon.tech)
or [supabase.com](https://supabase.com) and add the connection string as
`DATABASE_URL` yourself under Project Settings → Environment Variables.)

### 2. Migrate your local data into it

If you've been running this locally and have real data in `db/data/*.json`
that you want to keep, copy the connection string from Vercel's Storage tab
(or Neon/Supabase dashboard) and run, from your own machine:

```bash
DATABASE_URL="postgres://<paste-the-real-connection-string-here>" npm run migrate
```

You'll see output like:

```
- users: migrated 5 / 5 rows
- projects: migrated 3 / 3 rows
- tasks: migrated 4 / 4 rows
...
Done. Migrated 15 total rows into Postgres.
```

Your local `db/data/*.json` files are only read, never modified or deleted
— safe to run once and re-check anytime.

**If you don't have local data yet**, skip this step — the app seeds itself
with demo data automatically the first time it runs against an empty
database.

### 3. Deploy

```bash
npm install -g vercel   # skip if already installed
vercel login
vercel --prod
```

Accept the defaults when asked (it auto-detects everything from
`vercel.json`). You'll get a live URL like
`https://ethixweb-crm.vercel.app`.

### 4. Verify

Open the URL, sign in with one of the demo buttons (or your migrated
account), and confirm your data is there.

## How the Vercel setup works

- `vercel.json` routes `/api/*` requests to a single serverless function
  (`api/index.js`, which just re-exports the same Express app from
  `server.js`) and serves everything else as static files straight from
  `public/`.
- The database connection (`db/setup.js`) uses the standard `pg` driver
  against `DATABASE_URL` — this works identically whether that's Vercel
  Postgres, Neon, Supabase, or a plain self-hosted Postgres box.
- Sessions are stored in the database too (a `sessions` table), not in
  memory or on disk — so logins work correctly no matter which serverless
  instance handles each request, which is what actually makes this
  deployable to Vercel at all (a flat-file/in-memory approach would not
  survive serverless's stateless-between-requests model).

## What each role can actually do

- **Admin** — everything: manage all users, projects, tasks, tickets.
- **Sales** — create projects (new client engagements), view all projects/tickets, can't manage users or tasks.
- **Project Manager** — create/edit/delete projects and tasks, assign employees, manage tickets.
- **Employee** — sees only tasks/tickets assigned to them, can update their own status only.
- **Client** — sees only their own projects (read-only progress) and their own tickets; can create new tickets.

This is enforced **on the server**, verified directly with real HTTP
requests during development: an Employee gets a real 403 trying to create
a project or delete a user, a Client's project list only ever contains
their own projects, etc.

## What's real

- Real password hashing (bcryptjs), real signed session cookies, real CSRF
  token required on every mutating request.
- Real cascading delete: deleting a project deletes its tasks too.
- Real notifications: creating a ticket notifies Admin + PMs; changing a
  task/ticket status notifies the relevant person.
- Real, persistent Postgres storage — verified with an actual migration
  test (seeded a user with a real bcrypt password hash in the old
  flat-file format, ran the migration script, then logged in as that exact
  user through the real HTTP API against the migrated database).

## Honest limitations (by design, for a project this size)

- **No file uploads yet** (ticket attachments, project documents) — `multer`
  is installed and ready, just not wired to a route yet.
- **No email sending** — notifications are in-app only.
- Rate limiting is applied to `/api/auth/login` (20 attempts / 15 min) but
  not yet to other endpoints.
- The DB layer fetches a full table then filters in JS for most list
  queries, rather than hand-written SQL `WHERE` clauses per route. Totally
  fine at this data scale (dozens to low thousands of rows); if this ever
  needs to scale to a large multi-tenant dataset, that's the first thing
  to optimize.

## Project structure

```
ethixweb-crm/
├── server.js                Express app (exports `app`; only calls .listen() when run directly)
├── api/
│   └── index.js              Vercel serverless entrypoint (just re-exports server.js)
├── vercel.json               Routes /api/* to the function, everything else to public/
├── db/
│   ├── setup.js               Postgres layer (async), schema creation, seed data
│   └── data/                  Local JSON "database" for npm start without a real DB (gitignored)
├── scripts/
│   ├── migrate-local-data.js  One-time: copies db/data/*.json into Postgres
│   └── dev-with-pgmem.js      Dev convenience: run against an in-memory Postgres, no setup needed
├── middleware/
│   └── auth.js                Sessions, CSRF, role guards, audit log, notifications
├── routes/
│   ├── auth.js, users.js, projects.js, tasks.js, tickets.js, notifications.js
└── public/
    ├── index.html              Login page
    ├── portal.html             App shell (sidebar/topbar/content mount)
    ├── app.js                  All frontend logic — views, modals, API calls
    ├── styles.css              Design system (shared with EthixWeb OS)
    └── assets/                 Logo + spiderweb watermark
```
