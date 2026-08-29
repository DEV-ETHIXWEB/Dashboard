'use strict';

/**
 * HTML email renderer: a light, branded product email.
 *
 * Everything here is table-based with inline styles, because that is the only
 * layout every mail client agrees on. No dependency, no build step: templates
 * are plain functions that return a full HTML document plus a plain-text twin.
 *
 * The shape:
 *   - light grey page, one 700px white card on it, 14px radius
 *   - a near-black masthead carrying the wordmark and the web in its corner
 *   - small uppercase kicker, then a short sentence as the heading
 *   - panels for the things that need to interrupt, typography for the rest
 *   - centred call to action, and a black footer closing the message
 *
 * Light on purpose. The people reading these mostly run a white inbox, and a
 * dark email dropped into a white Gmail is the thing that looks broken. The
 * two dark bands top and bottom carry the brand instead, and because they are
 * explicit backgrounds rather than inverted ones, they survive a client's own
 * dark theme intact.
 *
 * Weights stay at 600 and below: at email sizes anything heavier reads as
 * shouting, especially on the Windows rasteriser.
 *
 * Colour and logo are env-overridable, so a rebrand is two variables.
 */

const appUrl = require('./appUrl');

/**
 * Content-Id of the logo, attached to every outgoing message by
 * utils/mailer.js and referenced as `cid:` in the header.
 *
 * A hosted URL only works when this deployment has a public address; on a
 * laptop it does not, and every inbox would fall back to bare text. An inline
 * attachment travels with the message, so the real wordmark shows up in Gmail
 * whether the app is on localhost or a domain.
 */
const LOGO_CID = 'ethixweb-logo';
const LOGO_SRC = `cid:${LOGO_CID}`;

/**
 * Hosted copies of the two pieces of artwork that appear on every message.
 *
 * These two are served from object storage rather than attached, so the bytes
 * stop riding along with each send. The trade is real and worth naming: an
 * attachment always renders, while a remote image is held back by Outlook and
 * Gmail until the reader asks for pictures. Everything else in this file --
 * the fact icons, the progress bars -- stays inline for exactly that reason.
 *
 * MAIL_LOGO_URL still wins over the wordmark below, so the address can be
 * moved without a deploy.
 */
const HOSTED_ASSET_BASE =
  'https://sjzhvegnywiftvmprnlf.supabase.co/storage/v1/object/public/EMAIL%20TEMPLATE%20IMAGES';
const HOSTED_LOGO_URL = `${HOSTED_ASSET_BASE}/ethixweb.png`;
const HOSTED_CORNER_URL = `${HOSTED_ASSET_BASE}/web-corner.png`;

/**
 * Fact icons, drawn in the product's own line and rasterised to PNG because
 * email cannot use SVG -- Gmail strips it outright.
 *
 * These are hosted now rather than attached, so nothing but text leaves with
 * a send. Two consequences worth holding in mind, because they are the price:
 *
 *   * Outlook and Gmail hold remote images back until the reader asks for
 *     pictures, so on first open a message can arrive with the glyphs missing.
 *     Every one of them is decorative -- the fact it labels is written beside
 *     it in words -- so a blocked image costs polish, never meaning. The one
 *     that carries information, the progress bar, keeps its percentage in
 *     `alt` for exactly this reason.
 *   * The bucket is now on the delivery path for how a message looks. If it
 *     goes away, mail still sends and still reads correctly.
 *
 * MAIL_ICON_BASE_URL repoints them without a deploy.
 */
const ICON_CID_PREFIX = 'ethixweb-icon-';
const ICONS = [
  'assignment-tile', 'ticket-tile', 'category-tile', 'priority-tile', 'client-tile',
  'owner-tile', 'due-tile', 'progress-tile', 'history-tile', 'stage-tile',
  'check-badge', 'web-corner',
  'bar-000', 'bar-010', 'bar-020', 'bar-030', 'bar-040', 'bar-050', 'bar-060', 'bar-070', 'bar-080', 'bar-090', 'bar-100',
];

/**
 * Where one icon lives. Names are the bare file stem ('due-tile', 'bar-030');
 * the bucket stores them all as .png at one flat level.
 */
function hostedIcon(name) {
  const base = String(process.env.MAIL_ICON_BASE_URL || HOSTED_ASSET_BASE).replace(/\/+$/, '');
  return `${base}/${name}.png`;
}

/** Map a fact's label onto a glyph. Unknown labels fall back to the kicker. */
function iconFor(label) {
  const k = String(label || '').toLowerCase();
  // 'assignment' before 'assignee' -- the kicker names the event, the fact
  // names the person, and they take different glyphs.
  if (k.includes('assignment')) return 'assignment-tile';
  if (k.includes('previous') || k.includes('was ')) return 'history-tile';
  if (k.includes('stage')) return 'stage-tile';
  if (k.includes('ticket')) return 'ticket-tile';
  if (k.includes('categor')) return 'category-tile';
  if (k.includes('priorit')) return 'priority-tile';
  if (k.includes('client')) return 'client-tile';
  if (k.includes('owner') || k.includes('assign')) return 'owner-tile';
  if (k.includes('due') || k.includes('response') || k.includes('date')) return 'due-tile';
  if (k.includes('progress')) return 'progress-tile';
  return 'assignment-tile';
}

/**
 * The wordmark is the brand in this email: the mark on the masthead and the
 * sign-off in the footer. The brand name never appears as typed text where the
 * logo can carry it instead -- text is only the fallback, in the alt
 * attribute, for a client that blocks images.
 *
 * There is deliberately no watermark behind the masthead. Email has no way to
 * fade a background image -- no opacity, no blend mode that Outlook or Gmail
 * will honour -- so a solid white wordmark tiled back there renders at full
 * strength and fights the real logo in front of it. A pre-faded asset could
 * work; a full-strength one cannot.
 */
/** Intrinsic size of public/ethixweb.png, drawn at half scale for retina. */
const LOGO_WIDTH = 211;
const LOGO_HEIGHT = 32;

const TOKENS = {
  // Light by design. Most people reading these run a white inbox, and a dark
  // email dropped into a white Gmail is the thing that looks broken -- so the
  // body is paper, and the brand shows up in the masthead and the accents.
  page: '#eef0f4',
  // The masthead black, reused by codeValue() for the one block on the page
  // that is meant to be lifted out rather than read. It is genuinely dark: a
  // white value here puts white text on a white block and the password
  // disappears, which is exactly what it did.
  ink: '#141013',
  card: '#ffffff',
  border: '#e2e5ea',
  panel: '#f7f8fa',
  raised: '#f1f3f6',
  text: '#0e1014',
  soft: '#454952',
  muted: '#767b86',
  brand: '#e8341f',
  brandDeep: '#7d0b04',
  brandSoft: '#fdece9',
  brandInk: '#5c0a04',
  success: '#127a4d',
  warn: '#9a5b06',
  danger: '#c62612',
  track: '#e4e7ec',
  hairline: '#edeff3',
  // Inter first, matching the app. Apple Mail and iOS honour the webfont; the
  // clients that strip it (Outlook, Gmail's web view) land on the system stack
  // below and still render a clean sans, never a serif fallback.
  font: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
};

/**
 * The footer stays black on purpose: it closes the message the way the
 * masthead opens it, and it is the one place the white wordmark can sit
 * without an outline. Its own tokens, because nothing else on the page is
 * dark any more.
 */
const FOOT = {
  bg: '#0b0b0d',
  border: '#26262b',
  text: '#ffffff',
  soft: '#b7bac1',
  muted: '#83879160',
  mutedSolid: '#838791',
};

/** Status pill colours, keyed by the lowercase status word. */
const STATUS_COLORS = {
  open: '#ff4a38',
  'to do': '#6f6878',
  triage: '#6f6878',
  'in progress': '#f0722a',
  'waiting on client': '#f0a742',
  review: '#a35bf0',
  resolved: '#2fae76',
  done: '#2fae76',
  closed: '#544d5e',
  complete: '#2fae76',
  urgent: '#e01f1f',
  high: '#ff4a38',
  normal: '#f0722a',
  low: '#6f6878',
};

/**
 * Set while a preview renders, so the Mail page can point the emblem at a
 * path the browser can load even when the deployment has no public URL yet.
 * Rendering is synchronous, so this can never straddle two messages.
 */
let brandOverride = null;

function withBrandOverride(patch, fn) {
  brandOverride = patch;
  try {
    return fn();
  } finally {
    brandOverride = null;
  }
}

function brand() {
  return {
    ...brandOverride,
    name: process.env.MAIL_BRAND_NAME || 'EthixWeb',
    color: process.env.MAIL_BRAND_COLOR || TOKENS.brand,
    // The wordmark now comes from object storage rather than the app's own
    // public/ folder, so it no longer depends on this deployment being
    // publicly reachable. MAIL_LOGO_URL overrides it for anyone who needs to
    // repoint the asset without shipping code.
    logoUrl: process.env.MAIL_LOGO_URL || HOSTED_LOGO_URL,
    baseUrl: appUrl.baseUrl(),
    supportEmail: process.env.MAIL_SUPPORT_EMAIL || null,
    ...brandOverride,
  };
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Only http(s), mailto, and root-relative paths survive, so template data can
 * never inject javascript:. The relative form exists for the Mail page
 * preview, which loads from this same server.
 */
function safeUrl(value) {
  if (!value) return null;
  const url = String(value).trim();
  if (url.startsWith('//')) return null; // protocol-relative: not ours to trust
  // `cid:` is the inline wordmark this renderer attaches itself, never
  // anything that came in with template data.
  if (url === LOGO_SRC) return url;
  if (!/^(https?:|mailto:|\/)/i.test(url)) return null;
  return escapeHtml(url);
}

function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join('') || '?';
}

function statusColor(status) {
  return STATUS_COLORS[String(status || '').trim().toLowerCase()] || TOKENS.muted;
}

/** "Aug 18, 2026, 4:30 PM" -- readable in every locale we ship to. */
function formatWhen(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(typeof value === 'number' ? value : String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// --- blocks ----------------------------------------------------------------
// Each returns an HTML string meant to sit inside the card's content cell.

function paragraph(text, { muted = false, size = 15, align = 'center' } = {}) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
    + `<tr><td align="${align}" style="font-family:${TOKENS.font};font-size:${size}px;line-height:1.62;`
    + `color:${muted ? TOKENS.muted : TOKENS.soft};padding:0 0 10px;">${escapeHtml(text)}</td></tr></table>`;
}

/** The short brand rule that closes a centred intro. */
function ruleAccent() {
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:20px auto 34px;">'
    + `<tr><td width="64" height="3" style="width:64px;height:3px;background:${TOKENS.brand};`
    + 'border-radius:999px;font-size:0;line-height:0;">&nbsp;</td></tr></table>';
}

/** Small uppercase label, the line ClickUp puts above the headline. */
/**
 * The kicker block: icon slot, the category in brand red, and the one line
 * saying who caused this message. Replaces the old bare eyebrow + separate
 * actor row, which read as two unrelated things stacked.
 */
function eyebrow(text, { line = null, icon = null, hero = null } = {}) {
  return [
    hero ? heroBadge(hero) : '',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px;">',
    `<tr><td align="center" style="font-family:${TOKENS.font};font-size:12px;font-weight:600;`
      + `letter-spacing:.18em;text-transform:uppercase;color:${TOKENS.brand};padding-bottom:${line ? '6px' : '0'};">`
      + `${escapeHtml(text)}</td></tr>`,
    line
      ? `<tr><td align="center" style="font-family:${TOKENS.font};font-size:14px;color:${TOKENS.muted};">${escapeHtml(line)}</td></tr>`
      : '',
    '</table>',
  ].join('');
}

function heading(text) {
  // A trailing "is resolved" style clause reads better with the state picked
  // out in brand red, so the last word after " is " is highlighted when the
  // caller writes the title that way.
  const raw = String(text || '');
  const m = raw.match(/^(.*\bis )([A-Za-z ]+)$/);
  const html = m
    ? `${escapeHtml(m[1])}<span style="color:${TOKENS.brand};">${escapeHtml(m[2])}</span>`
    : escapeHtml(raw);
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
    + `<tr><td align="center" style="font-family:${TOKENS.font};font-size:30px;line-height:1.24;`
    + `font-weight:600;letter-spacing:-.015em;color:${TOKENS.text};padding:10px 0 14px;">${html}</td></tr></table>`;
}

/**
 * The icon slot used by the eyebrow and every fact cell.
 *
 * Email cannot rely on SVG -- Gmail strips it -- so each mark is a PNG from
 * the product's own icon set, served from the bucket. `alt` is empty on
 * purpose: the glyph repeats the label written next to it, and a screen
 * reader announcing "ticket icon, Ticket, EW-1042" is worse than silence.
 */
function iconTile({ size = 46, icon = 'assignment-tile' } = {}) {
  const name = ICONS.includes(icon) ? icon : 'assignment-tile';
  // The art is 128px square with the body inset for its shadow, so the drawn
  // tile reads about 10% smaller than the box it sits in.
  const box = Math.round(size * 1.28);
  return `<img src="${hostedIcon(name)}" alt="" width="${box}" height="${box}" border="0" `
    + `style="display:block;border:0;outline:none;width:${box}px;height:${box}px;" />`;
}

/** The circular badge that opens a status message. */
function heroBadge(icon = 'check-badge', size = 96) {
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 18px;">',
    `<tr><td align="center"><img src="${hostedIcon(icon)}" alt="" width="${size}" height="${size}" border="0" `
      + `style="display:block;border:0;outline:none;width:${size}px;height:${size}px;" /></td></tr>`,
    '</table>',
  ].join('');
}

/** Solid, fully rounded, with a lit dot -- the state reads before the words. */
function statusPill(status) {
  const label = String(status || 'Open');
  const color = statusColor(label);
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">',
    `<tr><td bgcolor="${color}" style="background:${color};border-radius:999px;padding:8px 16px;">`,
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>',
    '<td width="7" height="7" style="width:7px;height:7px;background:#ffffff;border-radius:999px;font-size:0;line-height:0;">&nbsp;</td>',
    '<td width="8" style="width:8px;font-size:0;line-height:0;">&nbsp;</td>',
    `<td style="font-family:${TOKENS.font};font-size:11px;font-weight:600;letter-spacing:.08em;`
      + `text-transform:uppercase;color:#ffffff;white-space:nowrap;">${escapeHtml(label)}</td>`,
    '</tr></table>',
    '</td></tr></table>',
  ].join('');
}

/** Circle with initials -- the stand-in for an avatar image mail clients block. */
function avatarCircle(name, { size = 32, color, neumorphic = false } = {}) {
  const bg = color || brand().color;
  // The footer sits on black, so the raised look the buttons and icon tiles
  // already use elsewhere -- a soft outer shadow plus an inset top highlight,
  // same layered skeuomorphism -- reads as one system rather than a flat
  // circle dropped on a dark panel. Every layer degrades on its own: Outlook
  // drops the gradient and shadow and is left with the solid bgcolor.
  const ramp = neumorphic
    ? `linear-gradient(180deg,color-mix(in srgb,${bg} 82%,#fff) 0%,${bg} 55%,color-mix(in srgb,${bg} 82%,#000) 100%)`
    : '';
  const shadow = neumorphic
    ? '0 4px 10px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.35), inset 0 -1px 2px rgba(0,0,0,.25)'
    : 'none';
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${size}" height="${size}" `
      + `style="width:${size}px;height:${size}px;border-radius:${size}px;background-color:${bg};`
      + `background-image:${ramp};box-shadow:${shadow};">`,
    `<tr><td align="center" valign="middle" height="${size}" `
      + `style="height:${size}px;text-align:center;vertical-align:middle;font-family:${TOKENS.font};`
      + `font-size:${Math.round(size * 0.38)}px;line-height:${size}px;font-weight:600;color:#ffffff;`
      + `text-shadow:${neumorphic ? '0 1px 1px rgba(0,0,0,.35)' : 'none'};">`,
    `${escapeHtml(initialsOf(name))}`,
    '</td></tr></table>',
  ].join('');
}

/**
 * The panel ClickUp shows for the task itself: status pill, title, the list it
 * lives in, and a two-column grid of the fields that matter.
 */
function taskCard({ status, title, breadcrumb, meta = [], url = null }) {
  const rows = meta.filter((m) => m && m.value !== null && m.value !== undefined && m.value !== '');
  const pairs = [];
  for (let i = 0; i < rows.length; i += 2) pairs.push([rows[i], rows[i + 1] || null]);

  const cell = (m) => (m ? [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>',
    `<td width="72" valign="middle" style="padding-right:14px;">${iconTile({ icon: iconFor(m.label) })}</td>`,
    `<td valign="middle" style="font-family:${TOKENS.font};">`,
    `<div style="font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;`
      + `color:${TOKENS.muted};padding-bottom:5px;">${escapeHtml(m.label)}</div>`,
    `<div style="font-size:16px;line-height:1.35;color:${TOKENS.text};">${escapeHtml(String(m.value))}</div>`,
    '</td></tr></table>',
  ].join('') : '&nbsp;');

  const grid = rows.length
    ? [
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0;">',
      pairs.map(([a, bCell], i) => {
        const top = i ? `border-top:1px solid ${TOKENS.hairline};` : '';
        return '<tr>'
          + `<td class="ew-col" width="50%" valign="top" style="width:50%;padding:16px 18px 16px 0;${top}">${cell(a)}</td>`
          + `<td class="ew-col" width="50%" valign="top" style="width:50%;padding:16px 0 16px 18px;`
          + `border-left:1px solid ${TOKENS.hairline};${top}">${cell(bCell)}</td>`
          + '</tr>';
      }).join(''),
      '</table>',
    ].join('')
    : '';

  const head = [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>',
    `<td width="22" valign="middle" style="padding-right:10px;">`
      + `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`
      + `<td width="12" height="12" bgcolor="${statusColor(status)}" style="width:12px;height:12px;`
      + `background:${statusColor(status)};border-radius:999px;font-size:0;line-height:0;">&nbsp;</td>`
      + '</tr></table></td>',
    `<td valign="middle" style="font-family:${TOKENS.font};font-size:19px;line-height:1.35;`
      + `font-weight:600;color:${TOKENS.text};">${escapeHtml(String(title || ''))}</td>`,
    '</tr></table>',
    breadcrumb
      ? `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.muted};padding:6px 0 0 22px;">${escapeHtml(String(breadcrumb))}</div>`
      : '',
  ].join('');

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.panel}" `
      + `style="background:${TOKENS.panel};border-radius:20px;margin:0 0 30px;">`,
    '<tr><td class="ew-pad" style="padding:28px 30px 24px;">',
    head,
    grid,
    '</td></tr></table>',
  ].join('');
}

function progressBar(pct) {
  // Baked, one image per 10% step: the gloss, the bead highlights and the
  // shadow together are past what a mail client will draw from CSS. Only the
  // single step a message actually uses gets attached to it.
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  const step = String(Math.round(value / 10) * 10).padStart(3, '0');
  return `<img src="${hostedIcon(`bar-${step}`)}" alt="${value}% complete" width="300" height="32" `
    + 'style="display:block;border:0;width:100%;max-width:300px;height:auto;" />';
}

/** A comment, the way ClickUp renders one: avatar, name, time, quoted body. */
function comment({ author, at, body, source = null }) {
  const when = formatWhen(at);
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">`,
    '<tr>',
    `<td width="42" valign="top" style="padding:2px 10px 0 0;">${avatarCircle(author)}</td>`,
    '<td valign="top">',
    `<div style="font-family:${TOKENS.font};font-size:14px;font-weight:600;color:${TOKENS.text};">${escapeHtml(author)}`,
    when ? `<span style="font-weight:400;color:${TOKENS.muted};font-size:12px;"> &middot; ${escapeHtml(when)}</span>` : '',
    source ? `<span style="font-weight:400;color:${TOKENS.muted};font-size:12px;"> &middot; ${escapeHtml(source)}</span>` : '',
    '</div>',
    `<div style="margin-top:6px;padding:12px 14px;border-radius:10px;background:${TOKENS.panel};border:1px solid ${TOKENS.border};`,
    `font-family:${TOKENS.font};font-size:14px;line-height:1.6;color:${TOKENS.text};white-space:pre-wrap;">${escapeHtml(body)}</div>`,
    '</td></tr></table>',
  ].join('');
}

function bulletList(items) {
  const rows = items
    .filter(Boolean)
    .map(
      (item) => [
        '<tr>',
        `<td width="16" valign="top" style="padding:0 8px 8px 0;font-family:${TOKENS.font};font-size:14px;color:${brand().color};line-height:1.6;">&bull;</td>`,
        `<td valign="top" style="padding:0 0 8px;font-family:${TOKENS.font};font-size:14px;line-height:1.6;color:${TOKENS.text};">${escapeHtml(item)}</td>`,
        '</tr>',
      ].join(''),
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">${rows}</table>`;
}

/**
 * A bordered panel wrapping arbitrary block HTML.
 *
 * `callout` and `detailPanel` are the two fixed shapes; this is the one for a
 * column holding a mix, such as a button and a line of small print. Same
 * border and radius as the others so a row of them reads as a set.
 */
function panel({ tone = 'info', title, html = '' }) {
  const accent = { info: brand().color, success: TOKENS.success, warn: TOKENS.warn, danger: TOKENS.danger }[tone] || brand().color;
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;border-radius:12px;background:${TOKENS.panel};border:1px solid ${TOKENS.border};border-left:3px solid ${accent};">`,
    '<tr><td valign="top" style="padding:18px 20px;">',
    title
      ? `<div style="font-family:${TOKENS.font};font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${accent};padding-bottom:12px;">${escapeHtml(title)}</div>`
      : '',
    html,
    '</td></tr></table>',
  ].join('');
}

/**
 * A value meant to be taken out of the message, on the masthead black so it
 * reads as something to copy rather than something to read.
 *
 * `user-select:all` is the closest an email can get to a copy button: mail
 * clients run no JavaScript, so nothing can reach the clipboard. One tap or
 * click selects the whole string, which is the part people get wrong by hand.
 */
function codeValue(label, value, { hint = null } = {}) {
  return [
    `<div style="margin:0 0 4px;font-family:${TOKENS.font};font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${TOKENS.muted};">${escapeHtml(label)}</div>`,
    // A table with a bgcolor attribute, not a styled div. Outlook's Word engine
    // drops `background` on a div outright, and a dark block that loses its
    // background leaves white text on white paper -- an empty box where the
    // password should be. The attribute is the layer that cannot be dropped,
    // the inline style is the one that gets the radius, and `.ew-code` pins
    // both back under Outlook.com's dark theme rewrite.
    '<table role="presentation" class="ew-code" width="100%" cellpadding="0" cellspacing="0" border="0" ',
    `bgcolor="${TOKENS.ink}" style="margin:0 0 6px;border-radius:8px;background:${TOKENS.ink};">`,
    `<tr><td class="ew-code-v" style="padding:11px 13px;`,
    "font-family:'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;font-size:16px;",
    'letter-spacing:.06em;color:#ffffff;word-break:break-all;',
    `-webkit-user-select:all;-moz-user-select:all;user-select:all;">${escapeHtml(value)}</td></tr></table>`,
    hint
      ? `<div style="margin:0 0 14px;font-family:${TOKENS.font};font-size:11px;color:${TOKENS.muted};">${escapeHtml(hint)}</div>`
      : '<div style="height:10px;line-height:10px;font-size:0;">&nbsp;</div>',
  ].join('');
}

/** Highlighted strip for credentials, warnings, and deadlines. */
function callout({ tone = 'info', title, body, mono = false }) {
  const accent = { info: brand().color, success: TOKENS.success, warn: TOKENS.warn, danger: TOKENS.danger }[tone] || brand().color;
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-radius:12px;background:${TOKENS.panel};border:1px solid ${TOKENS.border};border-left:3px solid ${accent};">`,
    '<tr><td style="padding:16px 18px;">',
    title
      ? `<div style="font-family:${TOKENS.font};font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${accent};padding-bottom:7px;">${escapeHtml(title)}</div>`
      : '',
    `<div style="font-family:${mono ? "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace" : TOKENS.font};`,
    `font-size:${mono ? 15 : 14}px;line-height:1.6;color:${TOKENS.text};white-space:pre-wrap;word-break:break-word;">${escapeHtml(body)}</div>`,
    '</td></tr></table>',
  ].join('');
}

/**
 * Two blocks side by side, so a wide message uses its width instead of running
 * as one long column. The `ew-col` class is what the stylesheet in
 * renderEmail() flips to full width below 620px, where side by side would
 * squeeze both halves too narrow to read.
 */
function columns(cells, { gap = 16 } = {}) {
  const present = cells.filter(Boolean);
  if (present.length === 0) return '';
  if (present.length === 1) return present[0];

  const half = Math.round(gap / 2);
  const tds = present.map((cell, i) => {
    const pad = i === 0 ? `padding-right:${half}px;` : `padding-left:${half}px;`;
    return `<td class="ew-col" width="50%" valign="top" style="width:50%;${pad}">${cell}</td>`;
  });
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 4px;">`,
    `<tr>${tds.join('')}</tr>`,
    '</table>',
  ].join('');
}

/**
 * A callout whose body is a set of label/value pairs laid out across the
 * panel rather than stacked -- what credentials and other short facts want.
 */
function detailPanel({ tone = 'info', title, fields = [], mono = false, note = null }) {
  const accent = { info: brand().color, success: TOKENS.success, warn: TOKENS.warn, danger: TOKENS.danger }[tone] || brand().color;
  const valueFont = mono
    ? "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace"
    : TOKENS.font;

  const present = fields.filter(Boolean);
  const cellWidth = present.length > 0 ? Math.round(100 / present.length) : 100;
  const cells = present.map((f) => [
    `<td class="ew-col" width="${cellWidth}%" valign="top" style="width:${cellWidth}%;padding:0 14px 0 0;font-family:${TOKENS.font};">`,
    `<div style="font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:${TOKENS.muted};padding-bottom:4px;">${escapeHtml(f.label)}</div>`,
    `<div style="font-family:${valueFont};font-size:15px;font-weight:600;line-height:1.5;color:${TOKENS.text};word-break:break-word;">${escapeHtml(f.value)}</div>`,
    '</td>',
  ].join(''));

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-radius:12px;background:${TOKENS.panel};border:1px solid ${TOKENS.border};border-left:3px solid ${accent};">`,
    '<tr><td style="padding:18px 20px;">',
    title
      ? `<div style="font-family:${TOKENS.font};font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${accent};padding-bottom:12px;">${escapeHtml(title)}</div>`
      : '',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells.join('')}</tr></table>`,
    note
      ? `<div style="font-family:${TOKENS.font};font-size:12px;line-height:1.6;color:${TOKENS.soft};padding-top:10px;">${escapeHtml(note)}</div>`
      : '',
    '</td></tr></table>',
  ].join('');
}

/**
 * A label and its value, with no box around it.
 *
 * Boxes are for things that need to interrupt. Stacking bordered panels makes
 * all of them stop meaning anything, so plain facts get typography instead.
 */
function fact(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return [
    `<div style="margin:0 0 18px;font-family:${TOKENS.font};">`,
    `<div style="font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${TOKENS.muted};padding-bottom:5px;">${escapeHtml(label)}</div>`,
    `<div style="font-size:14px;line-height:1.55;color:${TOKENS.text};">${escapeHtml(value)}</div>`,
    '</div>',
  ].join('');
}

function divider() {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;"><tr><td style="height:1px;line-height:1px;font-size:0;background:${TOKENS.border};">&nbsp;</td></tr></table>`;
}

/** Pill button. The MSO comment gives Outlook a real rectangle to render. */
function button({ label, url, tone = 'primary', margin = '0' }) {
  const href = safeUrl(url);
  if (!href) return '';
  const primary = tone !== 'secondary';

  // The same skeuomorphism the icon tiles use, in CSS rather than baked art:
  // the label has to stay live text, so it cannot be an image. Every layer
  // degrades on its own -- Outlook drops the gradient and the shadow and is
  // left with the solid bgcolor, which is the mid stop of the same ramp.
  const solid = primary ? TOKENS.brand : TOKENS.raised;
  const ramp = primary
    ? 'linear-gradient(180deg,#ff4b33 0%,#ef3a24 46%,#d81c0c 78%,#cf1408 100%)'
    : `linear-gradient(180deg,#ffffff 0%,${TOKENS.raised} 100%)`;
  const shadow = primary
    ? '0 8px 18px rgba(190,20,10,.34), inset 0 1px 0 rgba(255,255,255,.45)'
    : '0 3px 8px rgba(16,18,22,.10), inset 0 1px 0 rgba(255,255,255,.9)';
  const fg = primary ? '#ffffff' : TOKENS.text;
  const edge = primary ? '#c81207' : TOKENS.border;

  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" `
      + `style="margin:${margin};min-width:260px;">`,
    `<tr><td align="center" bgcolor="${solid}" `
      + `style="background-color:${solid};background-image:${ramp};border:1px solid ${edge};`
      + `border-radius:999px;min-width:260px;box-shadow:${shadow};">`,
    `<a href="${href}" style="display:block;padding:17px 40px;font-family:${TOKENS.font};`
      + `font-size:16px;font-weight:600;color:${fg};text-decoration:none;text-align:center;`
      + `white-space:nowrap;text-shadow:${primary ? '0 1px 1px rgba(140,14,6,.35)' : 'none'};">`
      + `${escapeHtml(label)}</a>`,
    '</td></tr></table>',
  ].join('');
}

/** Both calls to action as one centred stack, with air between them. */
function ctaGroup(primary, secondary) {
  const rows = [];
  if (primary) rows.push(`<tr><td align="center">${button(primary)}</td></tr>`);
  if (primary && secondary) rows.push('<tr><td height="14" style="height:14px;font-size:0;line-height:0;">&nbsp;</td></tr>');
  if (secondary) rows.push(`<tr><td align="center">${button({ ...secondary, tone: 'secondary' })}</td></tr>`);
  if (!rows.length) return '';
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 4px;">',
    rows.join(''),
    '</table>',
  ].join('');
}


// --- document --------------------------------------------------------------

/**
 * The masthead: the wordmark on a black band, and nothing else.
 *
 * Two layers, each able to stand alone: the `bgcolor` every client honours, and
 * the wordmark on top of it. Strip the image and the band still looks
 * deliberate, with the brand name as alt text -- which is why the alt is the
 * name rather than "logo".
 */
function header() {
  const b = brand();
  const logo = safeUrl(b.logoUrl);
  const word = escapeHtml(String(b.name).toUpperCase());

  const mark = logo
    ? `<img class="ew-mark" src="${logo}" alt="${word}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" border="0" `
      + `style="display:block;border:0;outline:none;width:${LOGO_WIDTH}px;height:${LOGO_HEIGHT}px;max-width:100%;" />`
    : `<div class="ew-mark" style="font-family:${TOKENS.font};font-size:32px;line-height:1;font-weight:600;`
      + `letter-spacing:.02em;color:#ffffff;">${word}</div>`;

  // Near-black carrying a maroon wash, not a bright band: the wordmark and the
  // web are the only things meant to catch the eye up here.
  const wash = 'linear-gradient(105deg,#121013 0%,#171114 34%,#241318 62%,#2c1417 82%,#180f12 100%)';

  // The padding lives on the logo cell, not on the band, so the web can sit
  // hard against the top and right edges. Inset by the band's own padding it
  // read as floating in the middle of the header rather than anchored to it.
  //
  // The two cells want 481px between them (30 + 211 + 20 for the wordmark, 220
  // for the web) and a phone hands the band about 360. Something has to give,
  // and left alone the client gives up the wordmark -- the brand vanishes and
  // the header renders as a bare strip of web. So both cells carry classes and
  // the stylesheet in renderEmail() shrinks them together below 620px, where
  // they add up to 296 and the wordmark survives on a 320px screen.
  return [
    `<tr><td class="ew-band" bgcolor="#141013" style="background-color:#141013;`
      + `background-image:${wash};padding:0;border-radius:14px 14px 0 0;">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>',
    `<td class="ew-logo" valign="middle" align="left" style="padding:34px 20px 34px 30px;">${mark}</td>`,
    // font-size/line-height 0 kills the descender gap that would otherwise
    // leave a hairline of background under the image.
    `<td class="ew-corner" valign="top" align="right" width="220" `
      + `style="width:220px;padding:0;font-size:0;line-height:0;">`
      + `<img src="${HOSTED_CORNER_URL}" alt="" width="220" height="132" border="0" `
      + `style="display:block;border:0;outline:none;width:220px;height:132px;max-width:100%;`
      + `border-radius:0 14px 0 0;" /></td>`,
    '</tr></table>',
    '</td></tr>',

  ].join('');
}

/**
 * Two columns: who sent it on the right, who we are on the left. The rule
 * between them is a border on the right-hand cell, so it disappears by itself
 * when the columns stack on a phone.
 */
function footer({ reason, links = [], actor = null }) {
  const b = brand();
  const tagline = process.env.MAIL_BRAND_TAGLINE
    || 'We run the tech.\nYou run the business.';

  const linkHtml = links
    .map((l) => ({ label: l.label, href: safeUrl(l.url) }))
    .filter((l) => l.href)
    .map((l) => `<a href="${l.href}" style="color:${FOOT.soft};text-decoration:underline;">${escapeHtml(l.label)}</a>`)
    .join(`<span style="color:${FOOT.border};"> &nbsp;&middot;&nbsp; </span>`);

  const social = (process.env.MAIL_SOCIAL_LINKS || '')
    .split(',').map((x) => x.trim()).filter(Boolean)
    .map((pair) => {
      const [label, url] = pair.split('|');
      const href = safeUrl(url);
      if (!href || !label) return '';
      return `<td style="padding-right:10px;"><a href="${href}" style="display:inline-block;width:34px;height:34px;`
        + `line-height:32px;text-align:center;border:1px solid ${FOOT.border};border-radius:999px;`
        + `font-family:${TOKENS.font};font-size:11px;font-weight:600;color:${FOOT.soft};`
        + `text-decoration:none;">${escapeHtml(label.slice(0, 2))}</a></td>`;
    }).join('');

  const logo = safeUrl(b.logoUrl);
  const signOff = logo
    ? `<img src="${logo}" alt="${escapeHtml(String(b.name).toUpperCase())}" width="${Math.round(LOGO_WIDTH * 0.78)}" `
      + `height="${Math.round(LOGO_HEIGHT * 0.78)}" border="0" style="display:block;border:0;outline:none;`
      + `width:${Math.round(LOGO_WIDTH * 0.78)}px;height:${Math.round(LOGO_HEIGHT * 0.78)}px;max-width:100%;" />`
    : `<div style="font-family:${TOKENS.font};font-size:22px;font-weight:600;letter-spacing:.02em;`
      + `color:${FOOT.text};">${escapeHtml(String(b.name).toUpperCase())}</div>`;

  const brandCol = [
    `<div style="padding-bottom:12px;line-height:1;">${signOff}</div>`,
    `<div style="font-family:${TOKENS.font};font-size:13px;line-height:1.6;color:${FOOT.mutedSolid};">`
      + `${escapeHtml(tagline).replace(/\n/g, '<br />')}</div>`,
    social
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 0;"><tr>${social}</tr></table>`
      : '',
  ].join('');

  const actorCol = actor
    ? [
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>',
      `<td width="60" valign="middle" style="padding-right:14px;">${avatarCircle(actor.name, { size: 54, color: actor.color, neumorphic: true })}</td>`,
      `<td valign="middle" style="font-family:${TOKENS.font};">`,
      `<div style="font-size:15px;font-weight:600;color:${FOOT.text};">${escapeHtml(actor.name || '')}</div>`,
      actor.role || actor.company
        ? `<div style="font-size:13px;color:${FOOT.mutedSolid};padding-top:3px;">`
          + `${escapeHtml([actor.role, actor.company].filter(Boolean).join(' \u00b7 '))}</div>`
        : '',
      actor.email
        ? `<div style="font-size:13px;padding-top:8px;"><span style="color:${TOKENS.brand};">&#9993;</span> `
          + `<a href="mailto:${escapeHtml(actor.email)}" style="color:${FOOT.soft};text-decoration:none;">${escapeHtml(actor.email)}</a></div>`
        : '',
      '</td></tr></table>',
    ].join('')
    : '';

  return [
    `<table role="presentation" width="700" cellpadding="0" cellspacing="0" border="0" class="ew-card ew-foot" `
      + `bgcolor="${FOOT.bg}" style="width:700px;max-width:700px;margin:0;background:${FOOT.bg};`
      + `border-radius:0 0 14px 14px;">`,
    '<tr><td class="ew-pad" style="padding:30px 34px 8px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>',
    `<td class="ew-col" width="52%" valign="top" style="width:52%;padding-right:24px;">${brandCol}</td>`,
    actorCol
      ? `<td class="ew-col" width="48%" valign="middle" style="width:48%;padding-left:26px;border-left:1px solid ${FOOT.border};">${actorCol}</td>`
      : '<td class="ew-col">&nbsp;</td>',
    '</tr></table>',
    '</td></tr>',
    '<tr><td class="ew-pad" align="center" style="padding:22px 34px 26px;">',
    reason
      ? `<div style="font-family:${TOKENS.font};font-size:12px;line-height:1.6;color:${FOOT.mutedSolid};padding-bottom:8px;">${escapeHtml(reason)}</div>`
      : '',
    linkHtml ? `<div style="font-family:${TOKENS.font};font-size:12px;padding-bottom:10px;">${linkHtml}</div>` : '',
    `<div style="font-family:${TOKENS.font};font-size:11px;color:${FOOT.mutedSolid};">&copy; ${new Date().getFullYear()} ${escapeHtml(b.name)}</div>`,
    '</td></tr></table>',
  ].join('');
}

/**
 * Assemble one email. `blocks` are HTML strings from the helpers above; the
 * caller also passes `textLines` so the plain-text part reads like a real
 * message instead of a stripped-tag soup.
 */
function renderEmail({
  preheader = '',
  eyebrow: eyebrowText = null,
  hero = null,
  title,
  actor = null,
  blocks = [],
  cta = null,
  secondaryCta = null,
  reason = null,
  links = null,
}) {
  const b = brand();
  const defaultLinks = [
    b.baseUrl ? { label: 'Open dashboard', url: b.baseUrl } : null,
    b.baseUrl ? { label: 'Your alerts', url: `${b.baseUrl}/portal/notifications` } : null,
    b.supportEmail ? { label: 'Contact support', url: `mailto:${b.supportEmail}` } : null,
  ].filter(Boolean);


  const body = [
    eyebrowText ? eyebrow(eyebrowText, { line: actor ? actor.line : null, hero }) : '',
    heading(title),
    ...blocks,
    ctaGroup(cta, secondaryCta),
  ].join('\n');

  return [
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
    '<html xmlns="http://www.w3.org/1999/xhtml" lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="x-apple-disable-message-reformatting" />',
    // Dark by design, in both modes: this tells a client not to invert it.
    '<meta name="color-scheme" content="light" />',
    '<meta name="supported-color-schemes" content="light" />',
    `<title>${escapeHtml(title)}</title>`,
    // Apple Mail and iOS Mail load this; Outlook and Gmail's web view drop it
    // and fall through to the system stack in TOKENS.font.
    '<link rel="preconnect" href="https://fonts.googleapis.com" />',
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />',
    '<style>',
    ':root{color-scheme:light;supported-color-schemes:light;}',
    'body{-webkit-text-size-adjust:100%;text-size-adjust:100%;}',
    'table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}',
    'img{-ms-interpolation-mode:bicubic;}',
    // Outlook.com rewrites colours under its own dark theme; these put them
    // back. Everything else already ships the dark values inline.
    `[data-ogsc] .ew-page{background:${TOKENS.page} !important;}`,
    `[data-ogsc] .ew-card{background:${TOKENS.card} !important;}`,
    `[data-ogsc] .ew-text{color:${TOKENS.text} !important;}`,
    `[data-ogsc] .ew-foot{background:${FOOT.bg} !important;}`,
    // The code block is the one thing on the page that must never lose its
    // contrast: it is dark on purpose, and a theme that repaints the block
    // without repainting the text hides the password entirely.
    `[data-ogsc] .ew-code{background:${TOKENS.ink} !important;}`,
    '[data-ogsc] .ew-code-v{color:#ffffff !important;}',
    // Apple Mail and iOS Mail apply their own dark-mode rewrite even with the
    // `color-scheme: light` meta above -- unlike Outlook.com it does this via
    // `prefers-color-scheme` rather than an attribute, and it is the reason
    // this template looked fine in Gmail/Android but broke in Safari/iOS: the
    // dark bands (masthead, footer, code block) would get repainted without
    // their text following, going invisible. Same fix, same hooks, different
    // selector.
    '@media (prefers-color-scheme: dark){',
    `.ew-page{background:${TOKENS.page} !important;}`,
    `.ew-card{background:${TOKENS.card} !important;}`,
    `.ew-band{background-color:#141013 !important;}`,
    `.ew-foot{background:${FOOT.bg} !important;}`,
    `.ew-code{background:${TOKENS.ink} !important;}`,
    '.ew-code-v{color:#ffffff !important;}',
    '}',
    '@media only screen and (max-width:720px){',
    '.ew-card{width:100% !important;border-radius:0 !important;}',
    '.ew-foot{border-radius:0 !important;}',
    '.ew-pad{padding:24px 18px !important;}',
    '.ew-band{border-radius:0 !important;}',
    '.ew-band img{border-radius:0 !important;}',
    // Side-by-side halves become full-width rows: below this width there is
    // not enough room for two columns of readable text.
    //
    // The borders have to go with the layout. They are drawn for a grid --
    // border-left divides the two columns, border-top divides one pair of rows
    // from the next -- and neither means anything once the cells are stacked.
    // Left behind, the divider became a stray vertical line running down the
    // outside of every right-hand cell (PRIORITY, FIRST RESPONSE DUE in the
    // ticket card, the actor block in the footer), and the row rule became a
    // horizontal line above two stacked items out of four, which reads as
    // damage rather than structure. Stacked rows are separated by the padding
    // above instead.
    '.ew-col{display:block !important;width:100% !important;padding:0 0 14px !important;'
      + 'border-left:0 !important;border-top:0 !important;}',
    '}',
    // The masthead has its own breakpoint, lower than the card's. Between 620
    // and 720 the band is still wide enough for the wordmark and the web side
    // by side; below 620 it is not, and the wordmark is the half that must
    // survive -- so the web gives up most of its width rather than the brand
    // giving up all of its own.
    '@media only screen and (max-width:620px){',
    '.ew-logo{padding:24px 14px 24px 18px !important;}',
    // Scoped by tag: `.ew-mark` is the wordmark image when there is one and a
    // line of text when the image is blocked, and the two resize differently.
    'img.ew-mark{width:160px !important;height:24px !important;}',
    'div.ew-mark{font-size:24px !important;}',
    '.ew-corner{width:100px !important;}',
    '.ew-corner img{width:100px !important;height:60px !important;}',
    '}',
    '</style>',
    '</head>',
    `<body class="ew-page" style="margin:0;padding:0;background:${TOKENS.page};-webkit-font-smoothing:antialiased;">`,
    `<div style="display:none;font-size:1px;color:${TOKENS.page};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader)}</div>`,
    `<table role="presentation" class="ew-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.page}" style="background:${TOKENS.page};">`,
    '<tr><td align="center" style="padding:40px 12px 44px;">',
    `<table role="presentation" class="ew-card" width="700" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.card}" style="width:700px;max-width:700px;background:${TOKENS.card};border:1px solid ${TOKENS.border};border-radius:14px;">`,
    header(),
    '<tr><td class="ew-pad" style="padding:48px 40px 40px;">',
    body,
    '</td></tr></table>',
    footer({ reason, links: links || defaultLinks, actor }),
    '</td></tr></table>',
    '</body></html>',
  ].join('\n');
}

/** Plain-text twin. Callers hand us the lines; we only tidy the spacing. */
function renderText(lines) {
  return lines
    .filter((l) => l !== null && l !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = {
  heroBadge,
  ruleAccent,
  ICON_CID_PREFIX,
  ICONS,
  LOGO_CID,
  LOGO_SRC,
  TOKENS,
  brand,
  withBrandOverride,
  escapeHtml,
  safeUrl,
  initialsOf,
  statusColor,
  formatWhen,
  paragraph,
  eyebrow,
  heading,
  statusPill,
  avatarCircle,
  taskCard,
  progressBar,
  comment,
  bulletList,
  callout,
  columns,
  panel,
  codeValue,
  detailPanel,
  fact,
  divider,
  button,
  renderEmail,
  renderText,
};
