'use strict';

/**
 * In-process fan-out for "something you can see just changed".
 *
 * An event carries a topic and a timestamp -- never a record. A browser that
 * receives one refetches through the normal, permission-checked API, so this
 * channel can never become a way around requireAuth, requireRole, or
 * requirePage. The worst a mis-targeted subscriber learns is that some row in
 * a section they already have access to moved.
 *
 * Everything lives in this process. On a single instance that is exactly
 * right; behind more than one instance each node only reaches its own
 * subscribers, which is why the browser also falls back to polling and
 * refetches whenever the tab regains focus.
 */

const { canSeePage } = require('./clientPages');

/** A phone on a flaky connection can leave sockets behind; cap the damage. */
const MAX_STREAMS_PER_USER = 4;

/** Topics a client may hear about at all, and the page each one belongs to. */
const TOPIC_PAGE = {
  tickets: 'tickets',
  progress: 'progress',
  messages: 'messages',
  projects: 'projects',
  reports: 'reports',
  budget: 'budget',
  billing: 'billing',
  domains: 'domains',
  tasks: 'progress',
  // Always-on sections: everyone signed in may hear these.
  notifications: 'notifications',
  session: 'settings',
  // Staff-only topics. `null` here is not "everyone" -- STAFF_ONLY below is the
  // list that decides, and anything in it never reaches a client.
  users: null,
  approvals: null,
  mail: null,
  otp: null,
};

/** Topics that exist for the people running the workspace, never for clients. */
const STAFF_ONLY = ['users', 'approvals', 'mail', 'otp'];

const TOPICS = Object.keys(TOPIC_PAGE);

const STAFF_ROLES = ['admin', 'sales', 'project_manager', 'employee'];

/** userId -> Set<stream>. A stream is { id, user, send, close }. */
const streams = new Map();

let nextStreamId = 1;

function isStaff(user) {
  return STAFF_ROLES.includes(user?.role);
}

/** Whether this account is ever allowed to hear about this topic. */
function mayHear(user, topic) {
  if (STAFF_ONLY.includes(topic)) return isStaff(user);
  if (isStaff(user)) return true;
  if (user.role !== 'client') return false;
  const page = TOPIC_PAGE[topic];
  return page == null ? false : canSeePage(user, page);
}

/**
 * Whether one open stream should receive this event.
 *
 * `to` names the accounts a change belongs to. It narrows which *clients* hear
 * it -- staff still hear everything their role covers, because their screens
 * are the operations view of the whole workspace and a change to one client's
 * ticket is exactly what an admin is watching for.
 *
 * Two topics are about one person rather than one section, so they are only
 * ever delivered to the account named in `to`: a notification, and a session
 * whose role or page access just moved.
 */
function deliverableTo(stream, topic, to) {
  const user = stream.user;
  if (!user) return false;

  if (topic === 'session' || topic === 'notifications') {
    return to != null && to.includes(user.id);
  }

  if (!mayHear(user, topic)) return false;
  if (isStaff(user)) return true;
  return to == null || to.includes(user.id);
}

/**
 * Register an open stream. `send(topic, at)` writes one event; `close()` hangs
 * the connection up when this user opens too many. Returns the unsubscribe
 * function the route calls on disconnect.
 */
function subscribe(user, send, close) {
  const stream = { id: nextStreamId++, user, send, close };
  let set = streams.get(user.id);
  if (!set) {
    set = new Set();
    streams.set(user.id, set);
  }

  // Oldest first: a reconnect that raced the close of its predecessor should
  // evict that predecessor, not itself.
  while (set.size >= MAX_STREAMS_PER_USER) {
    const oldest = set.values().next().value;
    set.delete(oldest);
    try {
      oldest.close?.();
    } catch {
      /* already gone */
    }
  }

  set.add(stream);
  return () => {
    const current = streams.get(user.id);
    if (!current) return;
    current.delete(stream);
    if (current.size === 0) streams.delete(user.id);
  };
}

/**
 * Announce a change.
 *
 * @param {string} topic one of TOPICS
 * @param {{ to?: string[] }} [opts] the accounts this change belongs to; omit
 *   when the change is workspace-wide.
 */
function publish(topic, opts = {}) {
  if (!TOPICS.includes(topic)) return 0;
  const to = Array.isArray(opts.to) ? opts.to.filter(Boolean) : null;
  const at = Date.now();

  let delivered = 0;
  for (const set of streams.values()) {
    for (const stream of set) {
      if (!deliverableTo(stream, topic, to)) continue;
      try {
        stream.send(topic, at);
        delivered += 1;
      } catch {
        /* the route's own close handler will clean this stream up */
      }
    }
  }
  return delivered;
}

/** Diagnostics for the admin health view; no user data leaves this function. */
function stats() {
  let total = 0;
  for (const set of streams.values()) total += set.size;
  return { users: streams.size, streams: total };
}

module.exports = { TOPICS, TOPIC_PAGE, STAFF_ONLY, publish, subscribe, stats, MAX_STREAMS_PER_USER };
