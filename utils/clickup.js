'use strict';

// ClickUp API v2 client. Auth is a single workspace-level personal API token
// (CLICKUP_API_TOKEN) shared by the whole dashboard -- there is no per-user OAuth.

const { cached, invalidate: cacheInvalidate, mapWithLimit } = require('./integrationCache');

const BASE = 'https://api.clickup.com/api/v2';
const TTL_TASKS = 60 * 1000;
const TTL_TREE = 10 * 60 * 1000; // spaces/folders/lists change rarely

/**
 * How long an expired answer may still be served while its replacement is
 * fetched behind it. See `integrationCache.cached`.
 *
 * The workspace structure barely moves, so it gets a long window. Tasks get a
 * short one: it is enough to spare whoever opens the page at the wrong moment
 * from paying for everybody's refresh, without letting the board drift far
 * enough that somebody acts on a task that has already been closed.
 */
const STALE_TREE = 30 * 60 * 1000;
const STALE_TASKS = 45 * 1000;

function isEnabled() {
  return Boolean(process.env.CLICKUP_API_TOKEN);
}

class ClickUpError extends Error {
  constructor(message, status, { code = null, endpoint = null } = {}) {
    super(message);
    this.name = 'ClickUpError';
    this.status = status;
    this.code = code;       // ClickUp's ECODE, e.g. OAUTH_027, APP_002
    this.endpoint = endpoint;
  }
}

// ClickUp answers 401 for a bad token but ALSO for a token that simply cannot
// see one particular resource, so the status alone can't tell them apart --
// the ECODE can. OAUTH_0xx here means "this token is not valid at all".
const TOKEN_CODES = new Set(['OAUTH_017', 'OAUTH_021', 'OAUTH_025', 'OAUTH_026', 'OAUTH_027', 'OAUTH_077']);

// ClickUp allows 100 requests/minute per token. Browsing a busy workspace can
// burst past that, and the whole page then fails, so pace ourselves: a token
// bucket that refills continuously and never lets more than MAX_CONCURRENT
// requests be in flight at once.
const RATE_LIMIT_PER_MIN = 90; // leave headroom for other callers of the token
const MAX_CONCURRENT = 6;

const rateState = { tokens: RATE_LIMIT_PER_MIN, updatedAt: Date.now(), active: 0, queue: [] };

function refillTokens() {
  const now = Date.now();
  const gained = ((now - rateState.updatedAt) / 60_000) * RATE_LIMIT_PER_MIN;
  if (gained > 0) {
    rateState.tokens = Math.min(RATE_LIMIT_PER_MIN, rateState.tokens + gained);
    rateState.updatedAt = now;
  }
}

function pump() {
  refillTokens();
  while (rateState.queue.length > 0 && rateState.tokens >= 1 && rateState.active < MAX_CONCURRENT) {
    rateState.tokens -= 1;
    rateState.active += 1;
    rateState.queue.shift()();
  }
  if (rateState.queue.length > 0) {
    // Wake up when the next token is due, rather than busy-waiting.
    const waitMs = rateState.tokens >= 1 ? 50 : Math.ceil((1 - rateState.tokens) * (60_000 / RATE_LIMIT_PER_MIN));
    setTimeout(pump, Math.max(waitMs, 25)).unref?.();
  }
}

function acquireSlot() {
  return new Promise((resolve) => {
    rateState.queue.push(resolve);
    pump();
  });
}

function releaseSlot() {
  rateState.active -= 1;
  pump();
}

/**
 * One path segment, safe to interpolate.
 *
 * The list and task ids in these paths arrive from the browser's own URL. Glued
 * in raw, an id carrying `?`, `#`, or `../` rewrites the request: it can add
 * query parameters ClickUp will honour, truncate the path, or climb out of the
 * endpoint that was meant and land on a different one under the same token.
 * Encoding turns every one of those back into an ordinary character in an id
 * that simply does not exist.
 */
function seg(value) {
  return encodeURIComponent(String(value ?? ''));
}

async function request(path, params, options = {}) {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new ClickUpError('ClickUp is not connected. Set CLICKUP_API_TOKEN.', 503);

  // Second lock on the same door, for any caller that builds a path by hand.
  if (String(path).includes('..')) {
    throw new ClickUpError('Refusing to build a ClickUp request from that identifier.', 400);
  }

  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(`${key}[]`, String(v));
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { Authorization: token, Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  await acquireSlot();
  let res;
  try {
    res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ClickUpError('Could not reach ClickUp. Check the server connection.', 502);
  } finally {
    releaseSlot();
  }

  if (res.ok) {
    // DELETE and some PUTs answer with an empty body.
    return res.json().catch(() => ({}));
  }

  const body = await res.json().catch(() => ({}));
  const code = body.ECODE || null;
  const detail = body.err || null;

  // Always log the endpoint -- without it "ClickUp rejected the token" is
  // unactionable when only one list out of forty is the problem.
  console.error(`ClickUp ${options.method || 'GET'} ${path} -> ${res.status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`);

  const fail = (message, status) => new ClickUpError(message, status, { code, endpoint: path });

  // Rate limiting is APP_002; ClickUp usually sends 429 but not always.
  if (res.status === 429 || code === 'APP_002') {
    throw fail('ClickUp rate limit reached. Wait a minute and hit Refresh.', 429);
  }
  if (res.status === 401 && TOKEN_CODES.has(code)) {
    throw fail('ClickUp rejected the API token. Check CLICKUP_API_TOKEN.', 502);
  }
  if (res.status === 401 || res.status === 403) {
    throw fail(
      `The ClickUp token has no access to ${path}. Its user needs to be a member of that space or list.`,
      502,
    );
  }
  if (res.status === 404) {
    throw fail(`ClickUp has no such item (${path}). It may have been deleted or archived.`, 404);
  }

  throw fail(detail || `ClickUp request failed (${res.status})`, 502);
}

/** The workspace ("team") this dashboard reads. Pinned by env, else the first one. */
async function getTeam() {
  return cached('clickup:team', async () => {
    const data = await request('/team');
    const teams = data.teams || [];
    if (teams.length === 0) throw new ClickUpError('No ClickUp workspace is visible to this token.', 502);
    const pinned = process.env.CLICKUP_TEAM_ID;
    const team = pinned ? teams.find((t) => String(t.id) === String(pinned)) : teams[0];
    if (!team) throw new ClickUpError(`ClickUp workspace ${pinned} not found for this token.`, 502);
    return team;
  }, TTL_TREE, STALE_TREE);
}

// --- normalisers -----------------------------------------------------------

function toMillis(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const PRIORITY_LABELS = { 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };

function normaliseTask(raw) {
  const due = toMillis(raw.due_date);
  return {
    id: raw.id,
    name: raw.name || '(untitled)',
    url: raw.url || null,
    status: raw.status?.status || 'unknown',
    statusType: raw.status?.type || 'open', // open | custom | closed | done
    statusColor: raw.status?.color || null,
    priority: raw.priority?.priority ? String(raw.priority.priority) : null,
    priorityLabel: raw.priority?.orderindex ? PRIORITY_LABELS[Number(raw.priority.orderindex)] || null : null,
    dueAt: due,
    startAt: toMillis(raw.start_date),
    createdAt: toMillis(raw.date_created),
    updatedAt: toMillis(raw.date_updated),
    timeEstimate: toMillis(raw.time_estimate),
    assignees: (raw.assignees || []).map((a) => ({
      id: String(a.id),
      name: a.username || a.email || 'Unassigned',
      email: a.email || null,
      initials: a.initials || null,
      color: a.color || null,
    })),
    listId: raw.list?.id ? String(raw.list.id) : null,
    listName: raw.list?.name || null,
    folderName: raw.folder?.hidden ? null : raw.folder?.name || null,
    spaceId: raw.space?.id ? String(raw.space.id) : null,
    tags: (raw.tags || []).map((t) => t.name).filter(Boolean),
  };
}

// --- bucketing -------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Bucket a task by urgency, relative to `now` in the server's local day. */
function bucketFor(task, now = Date.now()) {
  if (task.dueAt === null) return 'no_due_date';

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = startOfToday.getTime() + DAY_MS;

  if (task.dueAt < startOfToday.getTime()) return 'overdue';
  if (task.dueAt < endOfToday) return 'due_today';
  if (task.dueAt < endOfToday + 6 * DAY_MS) return 'due_this_week';
  return 'later';
}

const BUCKET_ORDER = ['overdue', 'due_today', 'due_this_week', 'later', 'no_due_date'];

// --- public queries --------------------------------------------------------

/**
 * Every open (non-closed) task in the workspace. ClickUp caps the filtered team
 * view at 100 tasks per page, so we walk pages until one comes back short.
 */
async function fetchOpenTasks({ spaceId } = {}) {
  const key = `clickup:open-tasks:${spaceId || 'all'}`;
  return cached(key, async () => {
    const team = await getTeam();
    const MAX_PAGES = 20; // 2000 tasks -- a hard stop so a huge workspace can't hang the request
    const PAGE_SIZE = 100; // ClickUp's cap on the filtered team view
    const PAGE_BATCH = 4; // pages read at once once we know there are more

    const readPage = async (page) => {
      const data = await request(`/team/${seg(team.id)}/task`, {
        page,
        subtasks: true,
        include_closed: false,
        order_by: 'due_date',
        space_ids: spaceId ? [spaceId] : undefined,
      });
      return data.tasks || [];
    };

    // The first page on its own, because most workspaces only have one and
    // speculatively asking for four would be three wasted requests against a
    // token that is rate limited to ninety a minute. Only once ClickUp says
    // there is more does it become worth reading ahead.
    const tasks = [];
    let page = 0;
    let first = await readPage(page);
    tasks.push(...first);

    while (first.length === PAGE_SIZE && page + 1 < MAX_PAGES) {
      const pages = [];
      for (let p = page + 1; p < Math.min(page + 1 + PAGE_BATCH, MAX_PAGES); p += 1) pages.push(p);

      // In one wave rather than one after another: a workspace deep enough to
      // need twenty pages was twenty round trips of waiting, and the pages do
      // not depend on each other.
      const batches = await mapWithLimit(pages, PAGE_BATCH, readPage);

      let ended = false;
      for (const batch of batches) {
        tasks.push(...batch);
        // A short page is the last one. Anything this wave read past it is
        // empty, and is dropped rather than appended.
        if (batch.length < PAGE_SIZE) {
          ended = true;
          break;
        }
      }

      if (ended) break;
      page += pages.length;
      first = batches[batches.length - 1];
    }

    return tasks
      .map(normaliseTask)
      .filter((t) => t.statusType !== 'closed' && t.statusType !== 'done');
  }, TTL_TASKS, STALE_TASKS);
}

/** Open tasks plus the derived urgency buckets and per-assignee workload. */
async function fetchOverview({ spaceId } = {}) {
  const tasks = await fetchOpenTasks({ spaceId });
  const now = Date.now();

  const buckets = Object.fromEntries(BUCKET_ORDER.map((b) => [b, []]));
  const workload = new Map();

  for (const task of tasks) {
    buckets[bucketFor(task, now)].push(task);

    const holders = task.assignees.length > 0
      ? task.assignees
      : [{ id: '__unassigned__', name: 'Unassigned', email: null, initials: null, color: null }];

    for (const person of holders) {
      if (!workload.has(person.id)) {
        workload.set(person.id, { ...person, total: 0, overdue: 0, dueToday: 0 });
      }
      const row = workload.get(person.id);
      row.total += 1;
      const bucket = bucketFor(task, now);
      if (bucket === 'overdue') row.overdue += 1;
      if (bucket === 'due_today') row.dueToday += 1;
    }
  }

  return {
    tasks,
    buckets,
    bucketOrder: BUCKET_ORDER,
    workload: [...workload.values()].sort((a, b) => b.total - a.total),
    counts: {
      total: tasks.length,
      overdue: buckets.overdue.length,
      dueToday: buckets.due_today.length,
      dueThisWeek: buckets.due_this_week.length,
      unassigned: tasks.filter((t) => t.assignees.length === 0).length,
    },
    fetchedAt: now,
  };
}

/** Spaces -> folders -> lists, for the browser panel. */
async function fetchTree() {
  return cached('clickup:tree', async () => {
    const team = await getTeam();
    const spacesData = await request(`/team/${seg(team.id)}/space`, { archived: false });
    const spaces = spacesData.spaces || [];

    const result = await Promise.all(spaces.map(async (space) => {
      const [foldersData, looseListsData] = await Promise.all([
        request(`/space/${seg(space.id)}/folder`, { archived: false }),
        request(`/space/${seg(space.id)}/list`, { archived: false }),
      ]);

      const folders = (foldersData.folders || []).map((folder) => ({
        id: String(folder.id),
        name: folder.name,
        lists: (folder.lists || []).map((list) => ({
          id: String(list.id),
          name: list.name,
          taskCount: list.task_count ?? null,
        })),
      }));

      return {
        id: String(space.id),
        name: space.name,
        color: space.color || null,
        folders,
        lists: (looseListsData.lists || []).map((list) => ({
          id: String(list.id),
          name: list.name,
          taskCount: list.task_count ?? null,
        })),
      };
    }));

    return { workspace: { id: String(team.id), name: team.name }, spaces: result };
  }, TTL_TREE, STALE_TREE);
}

/** Open tasks in one list, for drill-down from the browser panel. */
async function fetchListTasks(listId) {
  return cached(`clickup:list:${listId}`, async () => {
    const data = await request(`/list/${seg(listId)}/task`, {
      subtasks: true,
      include_closed: false,
      order_by: 'due_date',
    });
    return (data.tasks || [])
      .map(normaliseTask)
      .filter((t) => t.statusType !== 'closed' && t.statusType !== 'done');
  }, TTL_TASKS, STALE_TASKS);
}

/** One task by id -- how a mirrored ticket reads its live state back. */
async function fetchTask(taskId) {
  return cached(`clickup:task:${taskId}`, async () => normaliseTask(await request(`/task/${seg(taskId)}`)), TTL_TASKS);
}

/** Everyone in the workspace, for assignee pickers. */
async function fetchMembers() {
  return cached('clickup:members', async () => {
    const team = await getTeam();
    return (team.members || [])
      .map((m) => m.user)
      .filter(Boolean)
      .map((u) => ({
        id: String(u.id),
        name: u.username || u.email || String(u.id),
        email: u.email || null,
        initials: u.initials || null,
        color: u.color || null,
        avatar: u.profilePicture || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, TTL_TREE, STALE_TREE);
}

/** The status options a list accepts -- ClickUp rejects any status not in this set. */
async function fetchListStatuses(listId) {
  return cached(`clickup:list-statuses:${listId}`, async () => {
    const list = await request(`/list/${seg(listId)}`);
    return (list.statuses || []).map((s) => ({
      status: s.status,
      type: s.type,
      color: s.color || null,
      orderindex: s.orderindex ?? 0,
    })).sort((a, b) => a.orderindex - b.orderindex);
  }, TTL_TREE, STALE_TREE);
}

// --- writes ----------------------------------------------------------------

// Any write can change what the read endpoints return, so drop the whole
// ClickUp cache rather than trying to surgically patch entries.
function invalidateClickUp() {
  cacheInvalidate('clickup:');
}

const PRIORITY_VALUES = { urgent: 1, high: 2, normal: 3, low: 4 };

/** Map the dashboard's task form onto ClickUp's request body shape. */
function toTaskBody(input, { forUpdate = false } = {}) {
  const body = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.description !== undefined) body.description = input.description;
  if (input.status !== undefined) body.status = input.status;

  if (input.priority !== undefined) {
    const key = input.priority === null ? null : String(input.priority).toLowerCase();
    body.priority = key === null ? null : (PRIORITY_VALUES[key] ?? Number(input.priority)) || null;
  }

  if (input.dueAt !== undefined) {
    body.due_date = input.dueAt === null ? null : Number(input.dueAt);
    if (body.due_date !== null) body.due_date_time = true;
  }

  if (input.assignees !== undefined) {
    const ids = (input.assignees || []).map((id) => Number(id)).filter(Number.isFinite);
    // Create takes a flat array; update takes an add/rem diff object.
    body.assignees = forUpdate ? { add: ids, rem: input.removeAssignees?.map(Number) || [] } : ids;
  }

  return body;
}

async function createTask(listId, input) {
  if (!input?.name) throw new ClickUpError('A task name is required.', 400);
  const raw = await request(`/list/${seg(listId)}/task`, null, { method: 'POST', body: toTaskBody(input) });
  invalidateClickUp();
  return normaliseTask(raw);
}

async function updateTask(taskId, input) {
  const raw = await request(`/task/${seg(taskId)}`, null, {
    method: 'PUT',
    body: toTaskBody(input, { forUpdate: true }),
  });
  invalidateClickUp();
  return normaliseTask(raw);
}

async function deleteTask(taskId) {
  await request(`/task/${seg(taskId)}`, null, { method: 'DELETE' });
  invalidateClickUp();
  return true;
}

async function fetchComments(taskId) {
  return cached(`clickup:comments:${taskId}`, async () => {
    const data = await request(`/task/${seg(taskId)}/comment`);
    return (data.comments || []).map((c) => ({
      id: String(c.id),
      text: c.comment_text || '',
      authorName: c.user?.username || c.user?.email || 'Unknown',
      authorInitials: c.user?.initials || null,
      resolved: Boolean(c.resolved),
      createdAt: toMillis(c.date),
    }));
  }, TTL_TASKS);
}

async function addComment(taskId, text) {
  if (!text?.trim()) throw new ClickUpError('A comment cannot be empty.', 400);
  await request(`/task/${seg(taskId)}/comment`, null, {
    method: 'POST',
    body: { comment_text: text.trim(), notify_all: false },
  });
  cacheInvalidate(`clickup:comments:${taskId}`);
  return true;
}

// --- ticket mirroring ------------------------------------------------------

/** The list new support tickets are mirrored into. Mirroring is off when unset. */
function ticketsListId() {
  return process.env.CLICKUP_TICKETS_LIST_ID || null;
}

function isTicketMirroringEnabled() {
  return Boolean(isEnabled() && ticketsListId());
}

/**
 * Create the ClickUp task that mirrors a dashboard support ticket.
 * Callers treat failure as non-fatal -- a ticket must still be raised when
 * ClickUp is down.
 */
/** Dashboard priority -> ClickUp priority. */
const CLICKUP_PRIORITY = { Urgent: 'urgent', High: 'high', Normal: 'normal', Low: 'low' };

async function mirrorTicket(ticket, { clientName } = {}) {
  const listId = ticketsListId();
  if (!listId) return null;

  const due = ticket.responseDueAt ? new Date(Number(ticket.responseDueAt)) : null;
  const lines = [
    `Raised from the EthixWeb dashboard.`,
    ``,
    `**Ticket:** ${ticket.id}`,
    `**Category:** ${ticket.category || 'General'}`,
    `**Priority:** ${ticket.priority || 'Normal'}`,
    clientName ? `**Client:** ${clientName}` : null,
    due ? `**First response due:** ${due.toISOString()}` : null,
    ``,
    ticket.description || '_No description given._',
  ].filter((l) => l !== null);

  const task = await createTask(listId, {
    name: `[${ticket.id}] ${ticket.subject}`,
    description: lines.join('\n'),
    // A bug still counts as at least high, whatever the client picked.
    priority:
      ticket.category === 'Bug'
        ? 'high'
        : CLICKUP_PRIORITY[ticket.priority] || 'normal',
    // The response deadline is the date the team is actually held to.
    ...(due ? { dueAt: due.getTime() } : {}),
  });
  return task;
}

module.exports = {
  isEnabled,
  ClickUpError,
  getTeam,
  fetchOpenTasks,
  fetchOverview,
  fetchTree,
  fetchListTasks,
  fetchTask,
  fetchMembers,
  fetchListStatuses,
  fetchComments,
  createTask,
  updateTask,
  deleteTask,
  addComment,
  isTicketMirroringEnabled,
  ticketsListId,
  mirrorTicket,
  bucketFor,
  BUCKET_ORDER,
};
