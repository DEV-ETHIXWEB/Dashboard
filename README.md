# EthixWeb CRM

An internal CRM for an IT / mobile / web / digital marketing agency — real
Express backend, file-based database, session auth with CSRF protection,
and five roles: **Admin, Sales, Project Manager, Employee, Client**.

Same visual system as the EthixWeb OS client portal (dark/light theme, red
accent, glassmorphism cards, spiderweb + logo watermark) — but this is a
genuinely separate, full-stack app: real login, a real server, and data
that persists across restarts (as JSON files on disk).

## Run it locally

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Then open **http://localhost:4000**

The database seeds itself automatically on first run (see `db/data/*.json`
after that — delete that folder any time to reset to the demo data).

## Demo logins

The login page has one-click buttons for all five, or use manually:

| Role | Name | Email | Password |
|---|---|---|---|
| Admin | Admin User | admin@ethixweb.local | `Admin#2026!` |
| Sales | Emily Turner | emily.turner@ethixweb.local | `Sales#2026!` |
| Project Manager | Ryan Coleman | ryan.coleman@ethixweb.local | `Manager#2026!` |
| Employee | Jordan Brooks | jordan.brooks@ethixweb.local | `Staff#2026!` |
| Client | David Shaw (BrightPath Retail Co.) | client@brightpath-retail.com | `Client#2026!` |

## What each role can actually do

- **Admin** — everything: manage all users, projects, tasks, tickets.
- **Sales** — create projects (new client engagements), view all projects/tickets, can't manage users or tasks.
- **Project Manager** — create/edit/delete projects and tasks, assign employees, manage tickets.
- **Employee** — sees only tasks/tickets assigned to them, can update their own status only.
- **Client** — sees only their own projects (read-only progress) and their own tickets; can create new tickets.

This is enforced **on the server**, not just hidden in the UI — every route
checks `req.user.role` before returning or mutating data (verified with
curl during development: an Employee gets a real 403 trying to create a
project or delete a user, a Client only ever sees their own projects, etc).

## What's real

- Real password hashing (bcryptjs), real signed session cookies, real CSRF
  token required on every mutating request (verified: a POST without the
  `X-CSRF-Token` header gets rejected with 403).
- Real cascading delete: deleting a project deletes its tasks too.
- Real notifications: creating a ticket notifies Admin + PMs; changing a
  task/ticket status notifies the relevant person.
- Data persists in `db/data/*.json` across server restarts — this is a
  genuine (if simple) database, not in-memory mock data.

## Honest limitations (by design, for a demo-weight project)

- **Storage is flat JSON files, not a real database** (SQLite/Postgres/etc).
  This avoids native-module build issues entirely (no `better-sqlite3`, no
  `bcrypt` — both need a C++ compiler; this uses pure-JS `bcryptjs`
  instead), so `npm install` works everywhere without a build toolchain.
  For production, swap `db/setup.js`'s functions for real SQL queries —
  every route only talks to `db.find/insert/update/remove`, so the
  swap is contained to one file.
- **No file uploads yet** (ticket attachments, project documents) — `multer`
  is installed and ready, just not wired to a route yet.
- **No email sending** — notifications are in-app only.
- Rate limiting is applied to `/api/auth/login` (20 attempts / 15 min) but
  not yet to other endpoints.

## Project structure

```
ethixweb-crm/
├── server.js                Express app entrypoint
├── db/
│   ├── setup.js              JSON-file database engine + seed data
│   └── data/                 Generated on first run (gitignored)
├── middleware/
│   └── auth.js               Sessions, CSRF, role guards, audit log, notifications
├── routes/
│   ├── auth.js, users.js, projects.js, tasks.js, tickets.js, notifications.js
└── public/
    ├── index.html             Login page
    ├── portal.html            App shell (sidebar/topbar/content mount)
    ├── app.js                 All frontend logic — views, modals, API calls
    ├── styles.css             Design system (shared with EthixWeb OS)
    └── assets/                Logo + spiderweb watermark
```

## Deploying this (important)

This needs a **Node server host**, not a static host like the plain Vercel
static hosting used for the EthixWeb OS portal — e.g. Render, Railway,
Fly.io, or a VPS. Vercel *can* run this via its Node.js serverless
functions, but the flat-file database won't persist between serverless
invocations there (each request may hit a different, ephemeral instance) —
so for Vercel specifically, swap in a real hosted database first (see
above).
