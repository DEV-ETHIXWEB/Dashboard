'use strict';

/**
 * Watching client channels so the browser does not have to.
 *
 * Slack sends this app no webhooks, so something has to ask. The question is
 * who. Every open tab polling its own channel every fifteen seconds means the
 * load grows with the number of people looking, and each of them still waits up
 * to fifteen seconds. One watcher here asks once per channel and pushes the
 * answer down the live wire, so ten people watching the same channel cost the
 * same as one and all ten see the reply together.
 *
 * It only runs while somebody is connected. A workspace nobody has open makes
 * no Slack calls at all -- there is nobody to tell.
 */

const { db } = require('../db/setup');
const slack = require('./slack');
const live = require('./liveBus');

/** Fast enough to read as a conversation, slow enough for Slack's limits. */
const TICK_MS = 8000;

/** Newest timestamp seen per channel, so only real change is announced. */
const lastSeen = new Map();

let timer = null;
let running = false;

/** Every client with a channel, grouped so one channel is fetched once. */
async function watchList() {
  const clients = await db.filter(
    'users',
    (u) => u.role === 'client' && u.slackChannelId,
  );

  const byChannel = new Map();
  for (const client of clients) {
    const list = byChannel.get(client.slackChannelId) || [];
    list.push(client.id);
    byChannel.set(client.slackChannelId, list);
  }
  return byChannel;
}

/**
 * One pass over every watched channel.
 *
 * A channel the bot cannot read is skipped quietly after the first complaint:
 * the Messages page already explains that case to whoever can fix it, and
 * repeating it here every eight seconds would bury the log.
 */
async function tick() {
  if (running) return;
  if (!slack.isEnabled()) return;

  // Nobody is watching, so there is nobody to notify. Cheapest possible pass.
  if (live.stats().streams === 0) return;

  running = true;
  try {
    const byChannel = await watchList();

    for (const [channelId, clientIds] of byChannel) {
      try {
        const messages = await slack.withChannelAccess(channelId, () =>
          slack.fetchChannelMessages(channelId, { limit: 1 }));

        const newest = messages[0]?.at ?? null;
        if (newest == null) continue;

        const previous = lastSeen.get(channelId);
        lastSeen.set(channelId, newest);

        // The first pass only learns where the channel is up to; announcing
        // then would light up every client's tab the moment the server boots.
        if (previous === undefined || newest <= previous) continue;

        live.publish('messages', { to: clientIds });
      } catch (err) {
        if (!tick.warned) {
          console.error(`Slack watch could not read ${channelId}:`, err.message);
        }
      }
    }
    tick.warned = true;
  } catch (err) {
    console.error('The Slack watch pass failed:', err.message);
  } finally {
    running = false;
  }
}

/** Start watching. Safe to call twice; the second call does nothing. */
function start() {
  if (timer || !slack.isEnabled()) return false;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  // Never hold the process open on its own account.
  if (typeof timer.unref === 'function') timer.unref();
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, watchList, TICK_MS };
