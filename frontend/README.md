# EthixWeb CRM — Frontend

React + TypeScript + Vite single-page app for the EthixWeb CRM. Talks to
the Express backend in the parent folder over a session-cookie + CSRF
authenticated REST API.

## Requirements

- Node.js 18+

## Getting started

Run this alongside the backend (see the repo root README for backend
setup). From this folder:

```bash
npm install
npm run dev
```

This starts the backend (against an in-memory Postgres instance) and the
Vite dev server together, with API requests proxied to the backend on port
4000. Sign in with any of the demo accounts listed in the root README.

To run only the frontend against a backend you're already running
elsewhere:

```bash
npm run dev:frontend-only
```

By default it talks to `/api` on its own origin. To point it at a backend
on a different origin, set `VITE_API_BASE_URL` (see `.env.example`).

## Scripts

- `npm run dev` — backend + frontend together, for local development
- `npm run dev:frontend-only` — just the Vite dev server
- `npm run build` — type-checks (`tsc -b`) then builds to `dist/`
- `npm run lint` — oxlint
- `npm run preview` — serve the production build locally

## Structure

```
src/
├── pages/          One component per route (Dashboard, Projects, Tasks, ...)
├── components/      Shared UI: AppShell (nav/layout), CreateTicketModal,
│                     StatusBadge, money/ (panels, charts, data rows), ui/ (shadcn primitives)
├── context/          AuthContext — current user, session, public config
├── hooks/useData.ts  React Query hooks, one per backend resource
├── lib/
│   ├── api.ts         fetch wrapper: CSRF header, error handling, apiUrl() helper
│   ├── entities.ts     Types mirroring the backend's data shapes
│   ├── types.ts        Auth/session/config types
│   ├── money.ts, format.ts  Formatting helpers
│   └── firebase2fa.ts  Client-side wrapper for Firebase phone/email 2FA
```

## Notes

- Route-level code splitting: every page in `App.tsx` is lazy-loaded.
- There's no mock or offline mode — every request goes to the real
  backend. If the backend is unreachable, pages show a real error state
  with a retry button rather than fabricated data.
- The demo-account autofill buttons on the login page only render in
  development builds (`import.meta.env.DEV`); they're excluded from
  production builds.
