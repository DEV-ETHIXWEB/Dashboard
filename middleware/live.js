'use strict';

/**
 * Turns every successful write into a nudge on the live wire.
 *
 * Mounting this once beats sprinkling publish() through fourteen routers: a
 * new endpoint under an existing prefix is live from the day it is written,
 * and nobody has to remember to fire an event on the error path.
 *
 * A route that knows whose data it just changed sets `res.locals.liveAudience`
 * to those user ids; the event then reaches only those accounts and the staff
 * working on them. Without it the event is a section-wide "something moved",
 * which is still safe -- the browser refetches through its own scoped,
 * permission-checked endpoint.
 */

const live = require('../utils/liveBus');

/** First match wins, so put the longer prefixes first. */
const PATH_TOPICS = [
  [/^\/api\/client\//, ['progress']],
  [/^\/api\/tickets\b/, ['tickets', 'progress']],
  [/^\/api\/projects\b/, ['projects', 'progress']],
  [/^\/api\/tasks\b/, ['tasks']],
  [/^\/api\/reports\b/, ['reports']],
  [/^\/api\/budget\b/, ['budget']],
  [/^\/api\/billing\b/, ['billing']],
  [/^\/api\/domains\b/, ['domains']],
  [/^\/api\/notifications\b/, ['notifications']],
  [/^\/api\/users\b/, ['users']],
  [/^\/api\/integrations\b/, ['tasks', 'progress']],
];

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function topicsFor(pathname) {
  for (const [pattern, topics] of PATH_TOPICS) {
    if (pattern.test(pathname)) return topics;
  }
  return null;
}

function audienceFrom(value) {
  if (value == null) return null;
  const list = (Array.isArray(value) ? value : [value]).filter((id) => typeof id === 'string' && id);
  return list.length > 0 ? list : null;
}

function broadcastChanges(req, res, next) {
  if (READ_METHODS.includes(req.method)) return next();

  const pathname = (req.originalUrl || req.url || '').split('?')[0];
  const topics = topicsFor(pathname);
  if (!topics) return next();

  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    const to = audienceFrom(res.locals?.liveAudience);
    for (const topic of topics) live.publish(topic, { to });
  });

  next();
}

module.exports = { broadcastChanges, topicsFor };
