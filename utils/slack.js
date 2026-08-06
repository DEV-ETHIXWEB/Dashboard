'use strict';

// Slack Web API client. Auth is a single workspace bot token (SLACK_BOT_TOKEN).
//
// Required bot scopes:
//   channels:read, channels:history   (public channels)
//   groups:read,   groups:history     (private channels the bot is in)
//   users:read                        (resolve author names)
//
// The bot only sees history for channels it has been invited to.

const { cached } = require('./integrationCache');

const BASE = 'https://slack.com/api';
const TTL_CHANNELS = 10 * 60 * 1000;
const TTL_USERS = 30 * 60 * 1000;
const TTL_MESSAGES = 2 * 60 * 1000; // Slack throttles conversations.history hard

function isEnabled() {
  return Boolean(process.env.SLACK_BOT_TOKEN);
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

async function request(method, params) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new SlackError('Slack is not connected. Set SLACK_BOT_TOKEN.', 503);

  const url = new URL(`${BASE}/${method}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }

  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new SlackError('Could not reach Slack. Check the server connection.', 502);
  }

  if (res.status === 429) {
    throw new SlackError(FRIENDLY_ERRORS.ratelimited, 429, 'ratelimited');
  }

  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const code = data.error || 'slack_error';
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
        };
      }
      cursor = data.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return map;
  }, TTL_USERS);
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
  }, TTL_CHANNELS);
}

// --- message rendering -----------------------------------------------------

/** Turn Slack mrkdwn entity refs (<@U1>, <#C1|dev>, <http://x|y>) into readable text. */
function renderText(text, userMap, channelMap) {
  if (!text) return '';
  return text
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

function normaliseMessage(message, channel, userMap, channelMap) {
  const text = renderText(message.text, userMap, channelMap);
  const author = message.user ? userMap[message.user] : null;

  return {
    id: `${channel.id}:${message.ts}`,
    ts: message.ts,
    at: Math.round(Number(message.ts) * 1000) || null,
    text,
    category: categorise(message, text),
    channelId: channel.id,
    channelName: channel.name,
    authorId: message.user || message.bot_id || null,
    authorName: author?.name || message.username || message.bot_profile?.name || 'Unknown',
    authorAvatar: author?.avatar || message.bot_profile?.icons?.image_48 || null,
    isBot: Boolean(message.bot_id) || message.subtype === 'bot_message',
    replyCount: Number(message.reply_count) || 0,
    reactionCount: (message.reactions || []).reduce((sum, r) => sum + (Number(r.count) || 0), 0),
    files: (message.files || []).map((f) => ({ id: f.id, name: f.name || f.title || 'file', type: f.filetype || null })),
    permalink: `https://slack.com/archives/${channel.id}/p${String(message.ts).replace('.', '')}`,
  };
}

// --- public queries --------------------------------------------------------

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
  }, TTL_MESSAGES);
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

  const skipped = [];
  const messages = [];

  for (const channel of targets) {
    try {
      messages.push(...await fetchChannelMessages(channel.id, { limit: perChannel }));
    } catch (err) {
      if (err instanceof SlackError) {
        skipped.push({ channelId: channel.id, channelName: channel.name, reason: err.message });
        continue;
      }
      throw err;
    }
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

module.exports = {
  isEnabled,
  SlackError,
  CATEGORIES,
  fetchChannels,
  fetchUserMap,
  fetchChannelMessages,
  fetchCategorisedFeed,
};
