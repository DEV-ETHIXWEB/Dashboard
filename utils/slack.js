'use strict';

// Slack Web API client. Auth is a single workspace bot token (SLACK_BOT_TOKEN).
//
// Required bot scopes:
//   channels:read, channels:history   (public channels)
//   groups:read,   groups:history     (private channels the bot is in)
//   users:read                        (resolve author names)
//   chat:write                        (post, and edit its own messages)
//
// The bot only sees history for channels it has been invited to.

const crypto = require('crypto');
const { cached, mapWithLimit } = require('./integrationCache');

const BASE = 'https://slack.com/api';
const TTL_CHANNELS = 10 * 60 * 1000;
const TTL_USERS = 30 * 60 * 1000;
const TTL_MESSAGES = 2 * 60 * 1000; // Slack throttles conversations.history hard

/**
 * How long an expired answer may still be served while its replacement is
 * fetched behind it. See `integrationCache.cached`.
 *
 * Generous for the directory, which is a list of channel and people names and
 * is wrong only when somebody has just been added; deliberately short for
 * messages, where being a minute behind is the difference between a live feed
 * and a stale one.
 */
const STALE_DIRECTORY = 30 * 60 * 1000;
const STALE_MESSAGES = 60 * 1000;

/** A throttled call is retried once if Slack asks for no longer than this. */
const MAX_RETRY_WAIT_SECONDS = 3;

/**
 * How many channels of the feed are read at once.
 *
 * `conversations.history` is a per-workspace limit, so the whole burst counts
 * against one budget; this is low enough to stay inside it and high enough that
 * a twelve-channel feed is three waves rather than twelve round trips.
 */
const FEED_CONCURRENCY = 4;

function isEnabled() {
  return Boolean(process.env.SLACK_BOT_TOKEN);
}

// --- Events API signature verification --------------------------------

/** Whether inbound Slack events can be verified at all. */
function isEventsEnabled() {
  return Boolean(process.env.SLACK_SIGNING_SECRET);
}

/** How old a signed request may be before it is refused as a replay. Slack's own recommendation. */
const MAX_EVENT_AGE_SECONDS = 60 * 5;

/**
 * Whether this request really came from Slack.
 *
 * Same shape as Twilio's check in utils/twilio.js: HMAC over the exact bytes
 * Slack sent, timing-safe compared. `req.body` must be the raw, unparsed
 * buffer -- Slack signs the literal request body, and running it through
 * express.json() first would change the bytes being signed out from under
 * this check. See the route mount in server.js.
 *
 * A failure here means the payload is not to be trusted at all, so callers
 * must read nothing out of it beyond this function's own return value.
 */
function verifyEventSignature(req) {
  if (!isEventsEnabled()) return false;

  const timestamp = req.get('x-slack-request-timestamp');
  const signature = req.get('x-slack-signature');
  if (!timestamp || !signature) return false;

  // A signature computed minutes ago and replayed later must not still pass --
  // otherwise a captured request could be resent to trigger the same send again.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_EVENT_AGE_SECONDS) return false;

  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const basestring = `v0:${timestamp}:${raw}`;
  const expected = `v0=${crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(basestring, 'utf8')
    .digest('hex')}`;

  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

class SlackError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'SlackError';
    this.status = status;
    this.code = code;
  }
}

const FRIENDLY_ERRORS = {
  invalid_auth: 'Slack rejected the bot token. Check SLACK_BOT_TOKEN.',
  account_inactive: 'The Slack bot token belongs to a deactivated app.',
  token_revoked: 'The Slack bot token has been revoked. Reinstall the app.',
  missing_scope: 'The Slack app is missing a required scope. Add channels:read, channels:history and users:read, then reinstall.',
  not_in_channel: 'The bot is not a member of this channel. Invite it with /invite @yourbot.',
  channel_not_found: 'That Slack channel was not found, or the bot cannot see it.',
  ratelimited: 'Slack rate limit reached. Try again in a minute.',
};

async function request(method, params, bodyData, options = {}) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new SlackError('Slack is not connected. Set SLACK_BOT_TOKEN.', 503);

  const url = new URL(`${BASE}/${method}`);
  if (params && !bodyData) {
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const fetchOpts = {
    headers: { Authorization: `Bearer ${token}` },
  };

  if (bodyData) {
    fetchOpts.method = 'POST';
    fetchOpts.headers['Content-Type'] = 'application/json; charset=utf-8';
    fetchOpts.body = JSON.stringify(bodyData);
  }

  let res;
  try {
    res = await fetch(url, fetchOpts);
  } catch {
    throw new SlackError('Could not reach Slack. Check the server connection.', 502);
  }

  // Slack answers 429 with the exact number of seconds to wait, and the wait is
  // usually one or two. Reading the feed asks for several channels at once, so
  // one throttled channel used to drop out of the results entirely and the page
  // showed a gap. Waiting the second out is both faster than making the admin
  // press Refresh and the only way to come back with the channel's messages.
  if (res.status === 429 && !options.isRetry) {
    const waitSeconds = Number(res.headers.get('retry-after')) || 1;
    if (waitSeconds <= MAX_RETRY_WAIT_SECONDS) {
      // Not unref'd: something is awaiting this timer, and a timer that does
      // not hold the event loop open can be skipped entirely when nothing else
      // is pending -- leaving the retry's promise to never settle.
      await new Promise((resolve) => { setTimeout(resolve, waitSeconds * 1000); });
      return request(method, params, bodyData, { isRetry: true });
    }
  }

  if (res.status === 429) {
    throw new SlackError(FRIENDLY_ERRORS.ratelimited, 429, 'ratelimited');
  }

  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const code = data.error || 'slack_error';
    // Always log the method and Slack's error code -- without it "Slack
    // rejected the bot token" is unactionable when the real cause is a
    // missing scope or an uninvited channel.
    console.error(`Slack ${method} -> ${code}`);
    throw new SlackError(FRIENDLY_ERRORS[code] || `Slack request failed (${code})`, 502, code);
  }
  return data;
}

// --- directory -------------------------------------------------------------

/** userId -> display name, so messages can show people instead of U0123ABC. */
async function fetchUserMap() {
  return cached('slack:users', async () => {
    const map = {};
    let cursor;
    do {
      const data = await request('users.list', { limit: 200, cursor });
      for (const member of data.members || []) {
        map[member.id] = {
          name: member.profile?.display_name || member.profile?.real_name || member.name || member.id,
          avatar: member.profile?.image_48 || null,
          isBot: Boolean(member.is_bot),
          // Present only when the app holds `users:read.email`, and the one
          // thing that ties a Slack account to a dashboard account -- which is
          // what decides whether somebody may text a customer. Undefined
          // without the scope, and utils/slackIdentity.js says so out loud
          // rather than quietly letting everyone through.
          email: member.profile?.email ? String(member.profile.email).toLowerCase() : null,
          deleted: Boolean(member.deleted),
        };
      }
      cursor = data.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return map;
  }, TTL_USERS, STALE_DIRECTORY);
}

/** Channels the bot can read, member channels first. */
async function fetchChannels() {
  return cached('slack:channels', async () => {
    const channels = [];
    let cursor;
    do {
      const data = await request('conversations.list', {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      channels.push(...(data.channels || []));
      cursor = data.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return channels
      .map((c) => ({
        id: c.id,
        name: c.name,
        isPrivate: Boolean(c.is_private),
        isMember: Boolean(c.is_member),
        topic: c.topic?.value || '',
        purpose: c.purpose?.value || '',
        memberCount: c.num_members ?? null,
      }))
      .sort((a, b) => {
        if (a.isMember !== b.isMember) return a.isMember ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, TTL_CHANNELS, STALE_DIRECTORY);
}

const EMOJI_MAP = {
  '+1': '👍',
  '-1': '👎',
  thumbsup: '👍',
  thumbsdown: '👎',
  saluting_face: '🫡',
  wave: '👋',
  eyes: '👀',
  raising_hand: '🙋',
  raised_hands: '🙌',
  folded_hands: '🙏',
  pray: '🙏',
  joy: '😂',
  rofl: '🤣',
  sob: '😭',
  sweat_smile: '😅',
  thinking_face: '🤔',
  thinking: '🤔',
  party_popper: '🎉',
  tada: '🎉',
  '100': '💯',
  sparkles: '✨',
  heavy_check_mark: '✔️',
  check: '✓',
  x: '❌',
  cross_mark: '❌',
  arrow_right: '➡️',
  point_right: '👉',
  clap: '👏',
  bar_chart: '📊',
  chart_with_upwards_trend: '📈',
  file_folder: '📁',
  warning: '⚠️',
  pushpin: '📌',
  white_check_mark: '✅',
  memo: '📝',
  rocket: '🚀',
  fire: '🔥',
  star: '⭐',
  bell: '🔔',
  calendar: '📅',
  smile: '😊',
  heart: '❤️',
  exclamation: '❗',
  question: '❓',
  bulb: '💡',
};

const emoji = require('node-emoji');

/** Turn Slack mrkdwn entity refs (<@U1>, <#C1|dev>, <http://x|y>) and :emoji: into readable text. */
function renderText(text, userMap, channelMap) {
  if (!text) return '';
  const emojified = emoji.emojify(text);
  return emojified
    .replace(/:([a-z0-9_+-]+):/g, (match, code) => EMOJI_MAP[code] || match)
    .replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, (_, id) => `@${userMap[id]?.name || id}`)
    .replace(/<#([A-Z0-9]+)\|([^>]*)>/g, (_, id, name) => `#${name || channelMap[id] || id}`)
    .replace(/<#([A-Z0-9]+)>/g, (_, id) => `#${channelMap[id] || id}`)
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, (_, kw) => `@${kw}`)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, (_, url, label) => label || url)
    .replace(/<(https?:\/\/[^>]+)>/g, (_, url) => url)
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .trim();
}

// --- categorisation --------------------------------------------------------

const CATEGORIES = [
  {
    key: 'alerts',
    label: 'Alerts & app notifications',
    description: 'Posted by bots, integrations, or incoming webhooks.',
  },
  {
    key: 'announcements',
    label: 'Announcements',
    description: 'Broadcasts to @channel, @here or @everyone.',
  },
  {
    key: 'action_items',
    label: 'Action items',
    description: 'Requests, blockers, and deadlines aimed at someone.',
  },
  {
    key: 'questions',
    label: 'Questions',
    description: 'Messages asking for an answer.',
  },
  {
    key: 'links_files',
    label: 'Links & files',
    description: 'Shared documents, screenshots, and URLs.',
  },
  {
    key: 'discussion',
    label: 'Threaded discussion',
    description: 'Messages that started a thread.',
  },
  {
    key: 'general',
    label: 'General chatter',
    description: 'Everything else.',
  },
];

const ACTION_PATTERNS = [
  /\bplease\b/i,
  /\bcan (you|someone|anyone)\b/i,
  /\bcould (you|someone)\b/i,
  /\b(todo|to-do|action item|follow[- ]up)\b/i,
  /\b(asap|urgent|blocker|blocked|deadline|due (today|tomorrow|by))\b/i,
  /\bneed(s|ed)? (this|it|you|to be)\b/i,
  /\b(review|approve|sign off|ship|deploy|fix) (this|it|the|by)\b/i,
  /\breminder\b/i,
];

/**
 * Classify one message into exactly one category. Order is deliberate: the
 * first rule that matches wins, from most specific signal to least.
 */
function categorise(message, renderedText) {
  const isBot = Boolean(message.bot_id) || message.subtype === 'bot_message';
  if (isBot) return 'alerts';

  const raw = message.text || '';
  if (/<!(channel|here|everyone)>/.test(raw)) return 'announcements';

  if (ACTION_PATTERNS.some((re) => re.test(renderedText))) return 'action_items';

  if (/\?\s*$/.test(renderedText) || /^\s*(who|what|when|where|why|how|is|are|do|does|did|can|should|any)\b.*\?/i.test(renderedText)) {
    return 'questions';
  }

  const hasFiles = Array.isArray(message.files) && message.files.length > 0;
  if (hasFiles || /https?:\/\//.test(raw)) return 'links_files';

  if (Number(message.reply_count) > 0) return 'discussion';

  return 'general';
}

const CATEGORY_DEFAULT_EMOJIS = {
  alerts: '🔔',
  announcements: '📢',
  action_items: '📌',
  questions: '❓',
  links_files: '📎',
  discussion: '💬',
  general: '💬',
};

const STARTS_WITH_EMOJI = /^(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff]|:([a-z0-9_+-]+):)/i;

function normaliseMessage(message, channel, userMap, channelMap) {
  let text = renderText(message.text, userMap, channelMap);
  const author = message.user ? userMap[message.user] : null;
  const category = categorise(message, text);
  const defaultEmoji = CATEGORY_DEFAULT_EMOJIS[category] || '💬';

  if (text && !STARTS_WITH_EMOJI.test(text.trim())) {
    text = `${defaultEmoji} ${text}`;
  }

  return {
    id: `${channel.id}:${message.ts}`,
    ts: message.ts,
    at: Math.round(Number(message.ts) * 1000) || null,
    text,
    category,
    channelId: channel.id,
    channelName: channel.name,
    authorId: message.user || message.bot_id || null,
    authorName: author?.name || message.username || message.bot_profile?.name || 'Unknown',
    authorAvatar: author?.avatar || message.bot_profile?.icons?.image_48 || null,
    isBot: Boolean(message.bot_id) || message.subtype === 'bot_message',
    replyCount: Number(message.reply_count) || 0,
    reactionCount: (message.reactions || []).reduce((sum, r) => sum + (Number(r.count) || 0), 0),
    files: (message.files || []).map((f) => {
      const type = f.filetype || null;
      const mimetype = f.mimetype || '';
      const isImage = Boolean(mimetype.startsWith('image') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(type));
      return {
        id: f.id,
        name: f.name || f.title || 'file',
        type,
        mimetype,
        url: f.url_private || f.permalink || null,
        thumb: f.thumb_360 || f.thumb_800 || f.thumb_64 || f.url_private || null,
        isImage,
      };
    }),
    attachments: (message.attachments || []).map((a) => ({
      id: String(a.id || Math.random()),
      title: a.title || null,
      titleUrl: a.title_link || null,
      text: renderText(a.text || a.fallback || '', userMap, channelMap),
      pretext: renderText(a.pretext || '', userMap, channelMap),
      imageUrl: a.image_url || a.thumb_url || null,
      color: a.color ? (a.color.startsWith('#') ? a.color : `#${a.color}`) : null,
      authorName: a.author_name || null,
    })),
    permalink: `https://slack.com/archives/${channel.id}/p${String(message.ts).replace('.', '')}`,
  };
}

// --- public queries --------------------------------------------------------

/**
 * Put the bot in a channel so it can read and write there.
 *
 * `conversations.join` works for **public** channels only, and needs the
 * `channels:join` scope. A private channel cannot be self-joined by design --
 * somebody already inside has to invite the bot -- so that case returns a
 * clear false rather than pretending.
 *
 * Already being a member is a success, not an error: Slack answers `ok` for a
 * repeat join, which makes this safe to call on every miss.
 */
async function joinChannel(channelId) {
  if (!channelId) return { joined: false, reason: 'no channel' };
  try {
    await request('conversations.join', null, { channel: channelId });
    return { joined: true };
  } catch (err) {
    // The two that mean "a human has to do this", kept apart from a real fault.
    if (err.code === 'method_not_supported_for_channel_type' || err.code === 'channel_not_found') {
      return { joined: false, reason: 'private', message: 'That is a private channel. Invite the bot to it with /invite.' };
    }
    if (err.code === 'missing_scope') {
      return { joined: false, reason: 'scope', message: 'The Slack app needs the channels:join scope to add itself to channels.' };
    }
    return { joined: false, reason: err.code || 'error', message: err.message };
  }
}

/**
 * Run a channel call, and if the only thing wrong is that the bot is not in the
 * room, join and try once more.
 *
 * Without this, designating a channel for a client fails until somebody
 * remembers to type `/invite`. With it, a public channel just works and a
 * private one gives an instruction instead of a stack trace.
 */
async function withChannelAccess(channelId, run) {
  try {
    return await run();
  } catch (err) {
    if (err.code !== 'not_in_channel' && err.code !== 'channel_not_found') throw err;

    const result = await joinChannel(channelId);
    if (!result.joined) {
      throw new SlackError(
        result.message || 'The bot is not in that channel, and could not add itself.',
        502,
        err.code,
      );
    }
    return run();
  }
}

async function fetchChannelMessages(channelId, { limit = 50 } = {}) {
  return cached(`slack:history:${channelId}:${limit}`, async () => {
    const [channels, userMap] = await Promise.all([fetchChannels(), fetchUserMap()]);
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) throw new SlackError(FRIENDLY_ERRORS.channel_not_found, 404, 'channel_not_found');

    const channelMap = Object.fromEntries(channels.map((c) => [c.id, c.name]));
    const data = await request('conversations.history', { channel: channelId, limit });

    return (data.messages || [])
      .filter((m) => m.subtype !== 'channel_join' && m.subtype !== 'channel_leave')
      .map((m) => normaliseMessage(m, channel, userMap, channelMap));
  }, TTL_MESSAGES, STALE_MESSAGES);
}

/**
 * Fetch thread replies for a specific parent message.
 *
 * `fresh` bypasses the cache. The feed can happily show a two-minute-old copy
 * of a thread; the @send drafter cannot -- the notes it is about to summarise
 * for a customer were usually typed seconds earlier, and a cached read would
 * miss exactly the ones that matter.
 */
async function fetchMessageReplies(channelId, threadTs, { fresh = false } = {}) {
  const read = async () => {
    const [channels, userMap] = await Promise.all([fetchChannels(), fetchUserMap()]);
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) throw new SlackError(FRIENDLY_ERRORS.channel_not_found, 404, 'channel_not_found');

    const channelMap = Object.fromEntries(channels.map((c) => [c.id, c.name]));
    const data = await request('conversations.replies', { channel: channelId, ts: threadTs });

    return (data.messages || []).map((m) => normaliseMessage(m, channel, userMap, channelMap));
  };

  if (fresh) return read();
  return cached(`slack:replies:${channelId}:${threadTs}`, read, TTL_MESSAGES, STALE_MESSAGES);
}

/**
 * Messages across several channels, grouped by category. Channels the bot is
 * not in are reported back rather than failing the whole request.
 */
async function fetchCategorisedFeed({ channelIds, perChannel = 30 } = {}) {
  const channels = await fetchChannels();
  const targets = (channelIds && channelIds.length > 0
    ? channels.filter((c) => channelIds.includes(c.id))
    : channels.filter((c) => c.isMember)
  ).slice(0, 12); // keep the request bounded -- Slack throttles history aggressively

  // The directory both branches below need, fetched once before the fan-out.
  // Without this the first wave of channel reads all miss the cache together
  // and each starts its own copy of the users and channels lookups.
  await Promise.all([fetchChannels(), fetchUserMap()]);

  // Read the channels at once rather than one after another. Twelve channels
  // fetched in series is twelve round trips to Slack stacked end to end, and
  // the admin waits for the sum of them -- several seconds on a normal
  // workspace, for requests that have nothing to do with each other.
  const perChannelResults = await mapWithLimit(targets, FEED_CONCURRENCY, async (channel) => {
    try {
      return { messages: await fetchChannelMessages(channel.id, { limit: perChannel }) };
    } catch (err) {
      // A channel the bot cannot read is reported back as skipped; it must not
      // take the other eleven down with it.
      if (err instanceof SlackError) {
        return { skipped: { channelId: channel.id, channelName: channel.name, reason: err.message } };
      }
      throw err;
    }
  });

  const skipped = [];
  const messages = [];
  for (const result of perChannelResults) {
    if (result.skipped) skipped.push(result.skipped);
    else messages.push(...result.messages);
  }

  messages.sort((a, b) => (b.at || 0) - (a.at || 0));

  const byCategory = CATEGORIES.map((category) => ({
    ...category,
    messages: messages.filter((m) => m.category === category.key),
  }));

  const byChannel = targets.map((channel) => ({
    id: channel.id,
    name: channel.name,
    isPrivate: channel.isPrivate,
    count: messages.filter((m) => m.channelId === channel.id).length,
  }));

  return {
    categories: byCategory,
    channels: byChannel,
    skipped,
    total: messages.length,
    fetchedAt: Date.now(),
  };
}

// --- writing back to slack -------------------------------------------------

/** Post a new message or reply to a thread in a channel. */
async function postMessage({ channelId, text, threadTs }) {
  if (!text || !text.trim()) {
    throw new SlackError('Message text cannot be empty.', 400);
  }
  const payload = {
    channel: channelId,
    text: text.trim(),
  };
  if (threadTs) {
    payload.thread_ts = threadTs;
  }
  const data = await request('chat.postMessage', null, payload);
  // `data.channel` is always an id, whatever `channelId` was written as. That
  // distinction is load-bearing: an inbound Slack event only ever carries an
  // id, so a card filed under the name "#sms-inbox" can never be matched to a
  // command typed in C0ABCD1234. Callers that store a channel must store this.
  return { ok: true, ts: data.ts, channelId: data.channel || channelId, message: data.message };
}

/**
 * Edit a message the bot already posted.
 *
 * Needs the `chat:write` scope the bot already has, and works only on the
 * bot's own messages -- which is exactly the constraint the SMS task card is
 * built around. Unlike `notifySlack` this throws, because a caller editing a
 * card it believes exists wants to know when the edit did not land.
 */
async function updateMessage({ channelId, ts, text }) {
  if (!isEnabled()) throw new SlackError('Slack is not connected. Set SLACK_BOT_TOKEN.', 503);
  if (!channelId || !ts) throw new SlackError('A message to update needs a channel and a timestamp.', 400);
  if (!text || !text.trim()) throw new SlackError('Message text cannot be empty.', 400);

  const data = await request('chat.update', null, { channel: channelId, ts, text: text.trim() });
  return { ok: true, ts: data.ts, channelId };
}

/** What a Slack channel id looks like: C public, G private group, D direct. */
const CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;

/**
 * The id of a channel that may have been configured by name.
 *
 * `chat.postMessage` accepts either an id or a `#name`, and Slack's own UI
 * shows people the name far more prominently than the id, so a settings field
 * asking for a channel gets both. Every *inbound* event, though, names its
 * channel by id and only by id. Anything that stores a channel in order to
 * compare it against an event later therefore has to store the id -- and this
 * is the one place that conversion happens.
 *
 * Throws rather than guessing when a name matches nothing: a name that does
 * not resolve is a configuration mistake, and the failure mode it used to
 * cause -- cards posting normally while every command in their thread was
 * silently discarded -- is far worse than a startup error.
 */
async function resolveChannelId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (CHANNEL_ID.test(raw)) return raw;

  const wanted = raw.replace(/^#/, '').toLowerCase();
  const match = (await fetchChannels()).find(
    (c) => String(c.name || '').toLowerCase() === wanted,
  );
  if (match) return match.id;

  throw new SlackError(
    `No Slack channel called "${raw}" is visible to the bot. Use the channel id instead ` +
      '(in Slack: channel name -> About -> Channel ID, near the bottom), and invite the bot ' +
      'to the channel with /invite.',
    404,
    'channel_not_found',
  );
}

/**
 * Work out which channel an event notification should land in: the one asked
 * for, then the configured default, then the first channel the bot is in.
 */
async function resolveNotificationChannel(channelId) {
  const preferred = channelId || process.env.SLACK_NOTIFICATION_CHANNEL;
  if (preferred) return preferred;
  const channels = await fetchChannels();
  return channels.find((c) => c.isMember)?.id || null;
}

/**
 * Send an event notification to Slack.
 *
 * Returns `{ channelId, ts }` on success and `null` when Slack is off or the
 * post failed, so callers can keep the thread reference without having to care
 * whether Slack is configured. Never throws: a Slack outage must not take a
 * ticket down with it.
 */
async function notifySlack(text, channelId) {
  if (!isEnabled()) return null;
  try {
    const targetChannel = await resolveNotificationChannel(channelId);
    if (!targetChannel) return null;
    const result = await postMessage({ channelId: targetChannel, text });
    // The id Slack posted to, not the string we asked with -- see postMessage.
    return { channelId: result.channelId || targetChannel, ts: result.ts };
  } catch (err) {
    // Silent fail for event notifications so application flow is not interrupted
    console.error('Slack event notification failed:', err.message);
    return null;
  }
}

/**
 * Reply inside an existing thread, best-effort. Used to keep every update on a
 * ticket under the one Slack message the ticket started.
 */
async function replyInThread({ channelId, threadTs, text }) {
  if (!isEnabled() || !channelId || !threadTs) return null;
  try {
    const result = await postMessage({ channelId, text, threadTs });
    return { channelId: result.channelId || channelId, ts: result.ts };
  } catch (err) {
    console.error('Slack thread reply failed:', err.message);
    return null;
  }
}

/** Post a structured summary digest of current dashboard projects and tasks to Slack. */
async function sendSlackDigest({ channelId, tasks = [], projects = [] }) {
  if (!isEnabled()) throw new SlackError('Slack is not connected. Set SLACK_BOT_TOKEN.', 503);

  let targetChannel = channelId;
  if (!targetChannel) {
    const channels = await fetchChannels();
    const memberChannel = channels.find((c) => c.isMember);
    if (!memberChannel) throw new SlackError('No channel available to post digest to.', 400);
    targetChannel = memberChannel.id;
  }

  const activeProjects = projects.filter((p) => p.status !== 'Completed');
  const openTasks = tasks.filter((t) => t.status !== 'Done');
  const highPriorityTasks = openTasks.filter((t) => t.priority === 'High' || t.priority === 'Urgent');

  const lines = [
    `📊 *Dashboard Daily Executive Digest*`,
    `----------------------------------------`,
    `• *Active Projects:* ${activeProjects.length} active (Total: ${projects.length})`,
    `• *Open Tasks:* ${openTasks.length} pending tasks (${highPriorityTasks.length} High/Urgent)`,
  ];

  if (activeProjects.length > 0) {
    lines.push(`\n📁 *Top Active Projects:*`);
    activeProjects.slice(0, 5).forEach((p) => {
      lines.push(`- *${p.name}* (${p.status || 'In Progress'})`);
    });
  }

  if (highPriorityTasks.length > 0) {
    lines.push(`\n⚠️ *High Priority Action Items:*`);
    highPriorityTasks.slice(0, 5).forEach((t) => {
      lines.push(`- ${t.name} (Due: ${t.due || 'No date'})`);
    });
  }

  lines.push(`\n_Generated live from Dashboard App_`);

  return postMessage({ channelId: targetChannel, text: lines.join('\n') });
}

module.exports = {
  joinChannel,
  withChannelAccess,
  isEnabled,
  isEventsEnabled,
  verifyEventSignature,
  SlackError,
  CATEGORIES,
  fetchChannels,
  fetchUserMap,
  fetchChannelMessages,
  fetchMessageReplies,
  fetchCategorisedFeed,
  postMessage,
  updateMessage,
  notifySlack,
  replyInThread,
  resolveChannelId,
  resolveNotificationChannel,
  sendSlackDigest,
};
