# What is new, explained simply

This file explains everything that was added to the dashboard, in plain words.
No jargon. If you read this top to bottom you will know what changed and why.

---

## The short version

Four things were built:

1. **A ClickUp page.** You can now see and run your ClickUp work without opening
   the ClickUp website.
2. **A Slack page.** You can read your Slack channel messages, sorted into
   groups so you are not scrolling forever.
3. **Ticket teamwork.** People can post progress on a ticket, ask someone to
   take it over, or ask someone for help.
4. **A new admin home page.** One page that shows what needs your attention
   today.

---

## 1. The ClickUp page

Think of ClickUp as a big box of to-do lists. Before, you had to open the
ClickUp website to look inside. Now the dashboard opens the box for you.

**Where:** left sidebar, under "Integrations", click **ClickUp**.

### What you can see

The page has three tabs.

**Spaces and lists.** This is your ClickUp folder tree, same shape as ClickUp
itself. On the left you pick a space, then a client company, then a list. The
tasks show up on the right. Client company names are printed in bold capitals
so your eye finds them fast.

**By urgency.** This sorts every open task by how soon it is due:

| Bucket | What it means |
| --- | --- |
| Overdue | The due date already passed |
| Due today | Due before midnight |
| Due this week | Due in the next 6 days |
| Later | Due further out |
| No due date | Nobody set a date |

You click one bucket at a time. This was done on purpose. If you had 100 tasks
all shown at once you would scroll forever, so you pick the pile you care about
and only that pile shows.

**Workload.** A table of who has how many open tasks, and how many of theirs are
late. Handy for spotting the person who is drowning.

### What you can do

You do not need to leave for ClickUp to make changes:

- **Change a task's status** from the dropdown on the task row.
- **Make a new task** with the "New task" button.
- **Edit a task** by clicking it. You can change the name, status, priority,
  due date, and who it belongs to.
- **Comment on a task**, and read comments other people left.
- **Delete a task.** It asks you to confirm first, because deleting is forever.

### Filters

Two filters help you find things:

- **Search box.** Type part of a task name, a list name, or a person's name.
- **Priority chips.** Buttons for Urgent, High, Normal, Low, and No priority.
  Each one shows a count. Click more than one to combine them. Click "All" to
  clear. A chip with zero tasks is greyed out so you do not click a dead end.

### Only 20 at a time

Long lists show 20 tasks, then a button that says something like
"Show 20 more, 37 left". This keeps the page quick and keeps your scrollbar
sane.

---

## 2. The Slack page

**Where:** left sidebar, under "Integrations", click **Slack**.

This reads messages from the Slack channels your bot has been invited to, then
sorts them into groups so you can skim:

| Group | What lands here |
| --- | --- |
| Alerts and app notifications | Messages posted by bots and integrations |
| Announcements | Anything sent to @channel, @here, or @everyone |
| Action items | Messages that ask someone to do something ("please", "can you", "urgent", "blocker", deadlines) |
| Questions | Messages that ask something |
| Links and files | Messages with a document, screenshot, or link |
| Threaded discussion | Messages that started a thread |
| General chatter | Everything else |

You pick which channels to include on the left. If the bot is not in a channel,
the page tells you so plainly instead of silently showing nothing.

This page only reads. It does not post anything to Slack.

---

## 3. Ticket teamwork

This is the biggest change. Before, a ticket was just a title and a status.
Now a ticket has a story.

**Where:** the Tickets page. Every ticket row has an **Open** button.

### A progress bar

Every ticket has a stage and a percentage. Picking a stage fills in the
percentage automatically, so it is one choice, not two:

| Stage | Fills in |
| --- | --- |
| Triage | 0% |
| In progress | 30% |
| Waiting on client | 50% |
| Review | 80% |
| Done | 100% |

You can type your own percentage instead if the stage number is not right.

### Progress updates

Whoever is working the ticket writes short notes as they go. Every note is
stamped with who wrote it and when. The client sees these notes on their own
ticket, so they can see movement without emailing to ask.

Clients can reply on their ticket too, but a client **cannot** move the progress
bar. That bar is the team's account of the work.

### Hand over

Sometimes you pick up a ticket and realise it should be someone else's. Click
**Hand over**, pick a person, and say why.

Important: it does not just dump the ticket on them. They get a request. Nothing
moves until they press **Accept**. If they press **Decline**, the ticket stays
with you.

When someone accepts a handover, two things happen:

- They become the new owner.
- You stay on as a helper, so you keep access to a ticket you know about.

### Ask for help

For a big job you may want help without giving the ticket away. Click
**Ask for help**, pick a person, and they get a request. If they accept, they
become a collaborator: they can see the ticket and post updates, but you stay
the owner.

### Who can do what

Rules are enforced on the server, not just hidden in the screen. Someone cannot
get around them by poking the API directly.

| Action | Who is allowed |
| --- | --- |
| See a ticket | Managers, the owner, collaborators, and the client it belongs to |
| Post a progress update | Managers, the owner, collaborators |
| Reply as a client | Only the client who raised it, and it cannot move the bar |
| Ask for handover or help | Managers and the current owner |
| Accept or decline a request | Only the person being asked (an admin can unblock a stuck one) |

Some extra safety rails:

- You cannot send a request to yourself.
- You cannot send the same request to the same person twice.
- You cannot hand a ticket to the person who already owns it.
- You cannot answer a request that was already answered.

### Notifications for staff

Before, only clients received notifications. That was a problem: a handover
request that never reaches the person is not really a request. Now everyone gets
notifications, and there is a Notifications page in the sidebar for every role.
Each person only ever sees their own.

---

## 4. The new admin home

**Where:** click **Dashboard** in the sidebar, or go to `/portal`.

If you are an admin you now get an operations page instead of the client style
page. Everyone else still sees exactly what they saw before. The web address is
the same, so no links break.

It shows:

- **Four counters** at the top: open tickets, things waiting on you, unassigned
  tickets, active projects.
- **Waiting on you.** Handover and help requests that need your yes or no. This
  card gets a red outline when it is not empty, because someone is blocked until
  you answer.
- **Unassigned tickets.** Open tickets nobody owns.
- **Not started.** Tickets that have an owner but zero progress recorded. These
  are the ones that quietly rot. Anything older than 3 days gets a "stale" flag.
- **ClickUp workload.** Who has the most open tasks and who is late.
- **Team.** Everyone on staff with their open ticket count.

Every ticket in every card has an **Open** button that opens the full story.

---

## 5. Tickets can copy into ClickUp

If you want it, a ticket raised in the dashboard can also become a ClickUp task
automatically. Closing the ticket marks the ClickUp task complete.

This is off until you set one setting. To find the value:

1. Open the list you want in ClickUp.
2. Look at the web address. It will look like
   `app.clickup.com/90161441349/v/li/901609876543`.
3. The number after `/v/li/` is the one you want.

Watch out: `/v/li/` means a list. `/v/o/s/` means a space and `/v/f/` means a
folder. Only the `li` one works.

Then put it in your `.env` file:

```
CLICKUP_TICKETS_LIST_ID=901609876543
```

Restart the server. The reminder banner on the ClickUp page will disappear.

Tip: make a list just for this, called something like "Support Tickets", so
dashboard tickets do not get mixed in with client work.

---

## 6. Settings you can set

All of these go in your `.env` file. All of them are optional. If you skip one,
that feature shows a friendly "not set up yet" screen instead of breaking.

| Setting | What it does |
| --- | --- |
| `CLICKUP_API_TOKEN` | Turns the ClickUp page on. Get it from ClickUp, Settings, Apps, API Token |
| `CLICKUP_TEAM_ID` | Only needed if your token can see more than one workspace |
| `CLICKUP_TICKETS_LIST_ID` | Turns on copying tickets into ClickUp |
| `SLACK_BOT_TOKEN` | Turns the Slack page on. Starts with `xoxb-` |

For Slack the bot also needs these permissions, then the app must be reinstalled:
`channels:read`, `channels:history`, `groups:read`, `groups:history`,
`users:read`. After that, invite the bot to each channel with `/invite @yourbot`.

---

## 7. Things done to keep it fast and safe

Small but worth knowing.

**It does not hammer ClickUp.** ClickUp only allows 100 requests a minute. Go
over and everything stops working. Two protections were added:

- A pacer that queues requests so the app never goes over roughly 90 a minute.
- The status dropdown on a task row only asks ClickUp for its options when you
  actually open the dropdown. Before, a screen of 20 tasks asked 20 times at
  once, which was enough to trip the limit on its own.

**Error messages tell the truth.** There used to be one message,
"ClickUp rejected the API token", shown for several different problems. That
sent you hunting for a broken token when the token was fine. Now the app tells
you which of these actually happened:

- The token really is wrong.
- The token is fine but has no access to that one list or space.
- You hit the rate limit, so wait a minute.
- The thing was deleted or archived.

The failing web address is also written to the server log, so you can see
exactly which item caused it.

**Results are remembered for a short while.** Data is held for about a minute so
several people looking at the same page do not each trigger fresh requests. The
**Refresh** button clears it when you want the latest right now.

**Nothing is stored twice.** ClickUp and Slack data is read live when you open a
page. It is not copied into your database, so it can never go stale or disagree
with the real thing.

---

## 8. Look and feel

- The whole thing uses the same card style, colours, and fonts as the rest of
  the dashboard. Nothing looks bolted on.
- Light mode and dark mode both work.
- Scrollbars inside panels are slim and match your theme instead of being fat
  grey system bars.
- On a phone the space tree folds into a single line you tap to open, so the
  task list stays at the top where you want it.
- Buttons are tall enough to tap comfortably on a phone.
- Nothing scrolls sideways. This was checked at both desktop and phone width.

---

## 9. Files that were added

New files, so you know where to look:

**Server side**

- `utils/clickup.js` talks to ClickUp
- `utils/slack.js` talks to Slack
- `utils/integrationCache.js` remembers results briefly
- `utils/ticketWorkflow.js` all the rules about progress, handover, and help
- `routes/integrations.js` the ClickUp and Slack web addresses

**Screen side**

- `frontend/src/pages/ClickUpTasks.tsx` the ClickUp page
- `frontend/src/pages/SlackMessages.tsx` the Slack page
- `frontend/src/pages/AdminHome.tsx` the new admin home
- `frontend/src/components/clickup/` task rows and task pop ups
- `frontend/src/components/tickets/` the ticket story pop up
- `frontend/src/hooks/useIntegrations.ts` fetching ClickUp and Slack data
- `frontend/src/hooks/useTicketWorkflow.ts` fetching ticket updates

**Database**

Two new tables were added. Existing data was not touched:

- `ticket_updates` every note and every request on a ticket
- `ticket_collaborators` who is helping on which ticket

Two new columns were added to the existing `tickets` table, `progress` and
`stage`. Old tickets simply start at 0 and "Not started".
