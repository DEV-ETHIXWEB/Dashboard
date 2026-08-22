# What changed

A record of the work done on this branch, in the order it was asked for. The
reference documentation for each feature lives in [README.md](README.md); this
file is the story of what moved and why.

**Where the project ended up:** 191 backend tests and 36 mail tests, both green.
Typecheck, lint, and production build clean.

| | Before | After |
|---|---|---|
| Backend tests | 64 | **191** |
| Mail tests | 20 | **36** |
| Client navigation | 10 items, 4 groups | **4 tabs + More** |
| Live updates | none | **13 topics over SSE** |
| Routes with sub-36px touch targets | 12 of 16 | **0** |

---

## 1. Client navigation, simplified

A client had ten destinations across four headed groups. They now have four,
plus a More sheet.

The words changed too, to the ones a client would use: **Home · Work ·
Requests · Money**, with Projects, Websites, Documents, Spending, Chat and
Alerts behind More. Nobody outside the office calls an invoice a billing
record.

Staff keep the full grouped index — seventeen destinations is a lot, but every
one is a job somebody does daily, and hiding them behind a menu costs more than
it saves.

- `frontend/src/lib/nav.ts` — one model, two shapes
- Switching a client's section off removes its tab and **promotes the next
  destination**, so the bar is never short and never has a dead tab
- A hard `slice(0, 4)` cap means a future addition can't silently overflow a
  five-slot bar

## 2. Mobile

### The shell

- **Bottom tab bar** — blurred, safe-area aware, with a pill that *slides*
  between tabs. That sliding is the single cue separating an app from a website
  with buttons at the bottom.
- **More is a sheet**, not a left drawer — it rises from the edge the thumb is
  already near and can be thrown back down.
- **Pull-to-refresh**, collapsing top bar, page transitions, haptics.
- **Service worker** offline shell that never caches a byte of `/api/`, so a
  shared phone has nothing private left on disk after sign-out.

### Touch targets

Measured every route at 375px rather than guessing. Twelve of sixteen admin
routes had controls under 36px; the worst had seventeen.

The fix was one custom variant rather than a hundred edits:

```css
@custom-variant coarse (@media (pointer: coarse));
```

It keys off **input device, not viewport**, so a narrow desktop window stays
dense and a large tablet still gets real targets. Applied at the primitives —
Button, Select, Input, Textarea, Tabs — which fixed every page at once.

Verified at 1280px: `pointer: coarse` is false and icon buttons measure 24px
again. Desktop density is untouched.

### Two real bugs found by measuring

- **`AnimatePresence` never unmounted the sheet.** It animated away and left an
  invisible full-screen layer swallowing every tap. Rebuilt on a timer-driven
  mount.
- **A truncating flex child with no `min-w-0`** set the minimum width of the
  whole page, which is why the app scrolled sideways on a phone.

### Tables

`/portal/tasks` rendered a six-column table on a 375px screen. Below `md` those
rows are cards now; the table returns from `md` up. Shrinking six columns just
gives you six unreadable columns.

## 3. The live wire

Admin and client screens stay in step over Server-Sent Events.

```
admin writes  ->  middleware/live.js  ->  utils/liveBus.js  ->  /api/events  ->  browser refetches
```

**What travels is a topic and a timestamp — never a record.** The browser
reacts by refetching through the ordinary endpoints, where `requireAuth`,
`requireRole` and `requirePage` all still apply. That is the whole security
argument: the stream cannot leak what it never carries, and cannot bypass a
check it never performs.

**Delivery is filtered per stream.** Staff hear what their role covers; a client
hears a section-wide topic only if that section is switched on for them, and
only when the change is theirs. Four topics (`users`, `approvals`, `mail`,
`otp`) never reach a client at all.

**When it isn't there** — serverless, buffering proxies — the browser gives up
after four attempts and falls back to polling plus a refetch on focus. Nothing
on screen depends on the stream existing.

- `utils/liveBus.js`, `routes/events.js`, `middleware/live.js`
- `frontend/src/hooks/useLiveUpdates.ts`, `frontend/src/context/LiveContext.tsx`

## 4. Everything real time

The gap was that only *this app's own writes* were live. Seven places still
polled.

| Source | Before | Now |
|---|---|---|
| Slack client channels | every tab polled, 15s | **server-side watcher**, pushed |
| Emails / mail log | 30s poll | pushed on write (`mail`) |
| Login codes | **5s poll** | pushed on write (`otp`) |
| Notifications | 30s poll | already pushed; interval now a fallback |
| Ticket requests | 60s poll | covered by `tickets` |
| ClickUp board state | 60s poll | **still 60s — nothing tells us** |

`utils/slackWatch.js` is the pattern worth copying. Ten tabs on one channel used
to mean ten polls every fifteen seconds and a fifteen-second wait each; one
watcher now asks per *channel* every eight seconds and pushes the answer, so
cost stops growing with the audience and everybody sees a reply together. It
makes **no Slack calls at all** when nobody is connected.

The `refetchInterval`s that remain are safety nets for a dead stream, not the
mechanism.

## 5. Stripe — real money, real records

Stripe is the ledger. Invoices, charges and subscriptions are mirrored into
`payments` and `billing`, and every figure the portal shows is rendered from
that mirror with a link to Stripe's own receipt beside it.

- Keyed by Stripe object id, so **a replayed webhook updates one row** rather
  than double-billing or re-emailing
- `POST /api/billing/sync` repairs a missed webhook
- Card details never touch this server
- "Where your money went" draws real Stripe categories; hand-tracked ad spend
  keeps its own labelled panel — the two are **never added together**

`utils/stripeSync.js`, `routes/billing.js`, `frontend/src/components/money/Payments.tsx`

## 6. Super admin, and a second signature

A super admin is **a flagged admin, not a sixth role**. `is_super_admin` sits on
top of `role = 'admin'`, so every existing admin check grants it automatically
and no permission can be lost by omission. Only two powers read the flag:
appointing admins, and reading the log.

| State | Appoints admins | Reads log | Acts alone | Signs off others |
|---|---|---|---|---|
| Super admin | yes | yes | yes | yes |
| Trusted admin | no | no | yes | yes |
| **New admin** | no | no | **no** | no |

A newly appointed admin starts **untrusted**: their sensitive changes are
written down, every approver is alerted, and nothing touches the data until
somebody else signs off. Guarded actions cover creating, changing and deleting
accounts; deleting a project, domain, document or ticket; and **closing a
ticket**.

Rules no approval can unlock: only a super admin touches the admin roster;
nobody approves their own request; a super admin cannot be deleted; the last one
cannot step down; an untrusted admin cannot approve at all.

Execution happens **exactly once** — the row is claimed before the action runs,
so a race is a 409 rather than a second write.

`utils/roles.js`, `utils/approvals.js`, `routes/approvals.js`,
`frontend/src/pages/Approvals.tsx`, `frontend/src/pages/AuditLog.tsx`

### The audit log

`/portal/audit`, super admin only. Approving writes **two** rows — the decision,
and the change it released, attributed to whoever proposed it. A log recording
only decisions cannot answer what actually happened.

## 7. Closing a ticket tells the client

Marking a ticket Resolved or Closed emails the client, so it needs a second
signature. Everything else about the ticket still saves immediately.

The subtle part was *where the email lived*. It sat in the route — the exact
path the approval flow skips — so a ticket closed through the queue would have
been marked Resolved with the client never told. `utils/ticketStatus.js` now
owns the whole status change and **both** paths call it. The route's copy was
deleted rather than left to drift.

## 8. Domain expiry reminders

| Days from expiry | 30 | 14 | 7 | 3 | 1 | 0 | −1 | −7 |
|---|---|---|---|---|---|---|---|---|
| Email the client | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Also alert admins | | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Keyed `domainId#expiryDay#milestone`, so **renewing starts a fresh series**
instead of silencing the domain forever. A sweep that missed a few days catches
up to the nearest milestone rather than skipping it.

The email leads with the date and says whether the domain **renews itself** —
that single fact is the difference between "act today" and "no action needed".

Verified end to end against a real inbox: five milestones, five deliveries,
second sweep sent zero.

`utils/domainWatch.js`

## 9. A client's own Slack channel

An admin names **one** channel when issuing a client login. That becomes the
client's Messages page — a two-way chat. The client never needs a Slack account.

The channel id is read from **the signed-in user's own record, never from the
request**, so there is no parameter to tamper with. Guarded by its own
`messages` page toggle. A `D…` direct-message id is refused: that is one
person's inbox, not a shared room.

The bot **joins by itself** (`conversations.join`) when the channel is assigned,
and again on any later `not_in_channel`, so a public channel just works.
Private channels return an instruction instead of a stack trace.

`routes/client.js`, `utils/slack.js`, `utils/slackWatch.js`,
`frontend/src/pages/Messages.tsx`

## 10. Email

- **Dark theme**, committed in both modes — an inverted light email is a
  lottery across clients, and brand colours come out of it looking wrong
- **The wordmark carries the brand**, on the masthead and in the footer. Zero
  "EthixWeb" as typed text outside `alt` attributes
- **New templates**: payment received, payment failed, payment summary, approval
  requested, approval decided, domain expiring
- **`MAIL_REDIRECT_TO`** — send everything to one inbox while a provider is in
  sandbox, with the intended recipient in the subject. The log still records who
  it was *for*, so the record is never a fiction
- **Readable failures** — provider JSON becomes one sentence an admin can act
  on; the raw text still goes to the log

A watermark behind the masthead was tried and removed: email cannot fade a
background image, so a white wordmark rendered at full strength and fought the
logo in front of it.

## 11. Documents open in the app

"Open" downloaded instead of opening. The server was sending
`Content-Disposition: inline` correctly — but that is a *request*, and Chrome's
"download PDFs instead of opening them" setting overrides it.

So it stopped depending on that: `/portal/reports/:id` renders the document in
an iframe with its name, size and date around it. Files a browser cannot render
skip the frame and offer a download.

Also caught: two seeded documents have **no file bytes at all**. The list now
reports `hasFile`, and the viewer says so plainly rather than showing a browser
error page inside the app.

## 12. Typography

The audit found ten different recipes for the same uppercase label, 82 arbitrary
pixel sizes, and four weights doing the job of one.

One scale, where each role carries size, leading, tracking **and** weight
together — because they are one decision. 24px at the wrong tracking is not
"nearly right", it is a different typeface.

`.t-title` · `.t-heading` · `.t-prose` · `.t-label` · `.t-caption` · `.numeric`

Also enabled app-wide: `font-optical-sizing: auto`, Inter's `cv05` (lowercase
`l` gets a tail — telling `l` from `1` from `I` in a dashboard full of IDs is
not a stylistic nicety), `text-wrap: balance` on headings and `pretty` on
paragraphs, and **tabular figures** on every number that sits in a column.
Verified: `111111`, `000000` and `888888` all measure 62px, so totals no longer
jitter as they update.

## 13. Custom expiry on sign-in links

An admin now picks how long a one-tap link lives — 5 minutes to 7 days —
instead of every link lasting 15.

The value is **clamped rather than trusted**: a link is a bearer credential, so
a year becomes 7 days, one minute becomes 5, and nonsense falls back to the
default rather than erroring. The lifetime actually used is audited next to who
issued it.

Fixed while testing it: closing one dialog as another opened left the first
**mounted and fully visible** — two modals stacked, the dead one still taking
clicks. It now unmounts with its state rather than lingering at `open={false}`.

## 14. Login page on mobile

A 500px marketing panel pushed the email field to y=577 on an 812px screen —
you landed on the pitch and the Sign in button was below the fold.

| | Before | After |
|---|---|---|
| Email field top | 577px | **330px** |
| Page height | 912px (scroll needed) | **720px = viewport** |
| Sign in button | below the fold | **visible on load** |

The panel is hidden below `md`; its brand and two trust lines reappear compactly
around the form. Desktop is unchanged.

---

## Still outstanding

Honest list of what is not finished, and why.

1. **Resend is in sandbox.** `onboarding@resend.dev` only delivers to the
   account owner, so clients get no sign-in codes, ticket receipts or expiry
   reminders. Verify a domain at resend.com/domains and point `MAIL_FROM` at an
   address on it. Until then, `MAIL_REDIRECT_TO` lets you see what *would* have
   been sent.

2. **Slack needs the `channels:join` scope.** Add it under OAuth & Permissions,
   reinstall the app to the workspace (Slack requires a reinstall for new
   scopes), and update `SLACK_BOT_TOKEN`. Without it the bot cannot add itself
   to a client's channel.

3. **ClickUp is not live.** The progress board still refetches every 60 seconds
   because ClickUp tells this app nothing. Making it live needs a ClickUp
   webhook pointed at a public URL.

4. **`APP_BASE_URL` is unset.** Email buttons have nowhere to link back to. Set
   it to the deployed origin.

5. **The self-service 2FA panel is gone** with the Settings page. The
   `/api/users/me/2fa/*` endpoints still exist but nothing reaches them. Either
   fold the control into the More sheet or delete the endpoints.

6. **Two seeded documents have no file bytes.** *June Performance Report* and
   *SEO Audit - Q2 2026* need re-uploading; the content was never stored and
   cannot be recovered.

## Schema added

Applied automatically on boot (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF
NOT EXISTS`) — no migration step.

| Table | What |
|---|---|
| `payments` | one row per Stripe invoice or charge |
| `approval_requests` | proposals awaiting a second signature |
| `billing` +9 columns | plan price, interval, renewal, card, sync time |
| `users` +7 columns | super admin flag, admin trust, Slack channel |

## Running the checks

```bash
npm test
```

Backend and mail suites. For the frontend, from `frontend/`:

```bash
npx tsc -b && npx oxlint && npm run build
```
