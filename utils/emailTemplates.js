'use strict';

/**
 * HTML email renderer: a dark, branded product email.
 *
 * Everything here is table-based with inline styles, because that is the only
 * layout every mail client agrees on. No dependency, no build step: templates
 * are plain functions that return a full HTML document plus a plain-text twin.
 *
 * The shape:
 *   - deep near-black page, one 700px card on it, 14px radius
 *   - a masthead carrying the wordmark over the brand's own web pattern
 *   - small uppercase eyebrow, then a short bold sentence as the heading
 *   - panels for the things that need to interrupt, typography for the rest
 *   - one pill button as the single call to action
 *   - quiet footer with the reason the message was sent
 *
 * Dark on purpose, and dark in both modes. A light email inverted by a phone's
 * dark mode is a lottery -- Gmail and Outlook each invert differently, and
 * brand colours come out of it looking nothing like the brand. Committing to
 * dark means the message that arrives is the message that was designed, and
 * the red reads as the same red the app uses.
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
  // The ground the card sits on, and the masthead behind the wordmark.
  page: '#07060a',
  ink: '#0a0809',
  card: '#141116',
  border: '#2b2531',
  panel: '#1c1820',
  // A hair lighter than panel, for a strip inside a panel.
  raised: '#241f28',
  text: '#f5f2f7',
  soft: '#c0b8c8',
  muted: '#8d8598',
  // EthixWeb red, brightened for a dark ground. Matches --primary in the app's
  // own dark theme, oklch(0.62 0.22 29); the light-theme #c20000 goes muddy
  // against near-black.
  brand: '#ff4a38',
  brandDeep: '#c20000',
  brandSoft: '#2a100d',
  // Text that sits on top of the brand red.
  brandInk: '#1a0503',
  success: '#3ad392',
  warn: '#f0a742',
  danger: '#ff5c4d',
  // Empty half of a progress bar, and any other inert track.
  track: '#2b2531',
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
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
    // The EthixWeb wordmark from this app's own public/ folder. A hosted URL
    // is used when there is a publicly reachable one (utils/appUrl.js resolves
    // it from APP_BASE_URL or the origin the app is served on); otherwise the
    // logo rides along as an inline attachment, so it renders either way.
    logoUrl: appUrl.logoUrl() || LOGO_SRC,
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

function paragraph(text, { muted = false, size = 15 } = {}) {
  const color = muted ? TOKENS.soft : TOKENS.text;
  return `<p style="margin:0 0 16px;font-family:${TOKENS.font};font-size:${size}px;line-height:1.6;color:${color};">${escapeHtml(text)}</p>`;
}

/** Small uppercase label, the line ClickUp puts above the headline. */
function eyebrow(text) {
  return [
    `<div style="margin:0 0 12px;font-family:${TOKENS.font};font-size:11px;font-weight:700;`,
    `letter-spacing:.12em;text-transform:uppercase;color:${brand().color};">${escapeHtml(text)}</div>`,
  ].join('');
}

function heading(text) {
  return [
    `<h1 style="margin:0 0 14px;font-family:${TOKENS.font};font-size:26px;line-height:1.26;`,
    `font-weight:700;letter-spacing:-.02em;color:${TOKENS.text};">${escapeHtml(text)}</h1>`,
  ].join('');
}

function statusPill(status) {
  const color = statusColor(status);
  return [
    `<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${color};`,
    `font-family:${TOKENS.font};font-size:10px;font-weight:700;letter-spacing:.07em;`,
    `text-transform:uppercase;color:#ffffff;">${escapeHtml(status)}</span>`,
  ].join('');
}

/** Circle with initials -- the stand-in for an avatar image mail clients block. */
function avatarCircle(name, { size = 32, color } = {}) {
  const bg = color || brand().color;
  return [
    `<span style="display:inline-block;width:${size}px;height:${size}px;line-height:${size}px;`,
    `border-radius:${size}px;background:${bg};color:#ffffff;text-align:center;`,
    `font-family:${TOKENS.font};font-size:${Math.round(size * 0.4)}px;font-weight:700;">`,
    `${escapeHtml(initialsOf(name))}</span>`,
  ].join('');
}

/**
 * The panel ClickUp shows for the task itself: status pill, title, the list it
 * lives in, and a two-column grid of the fields that matter.
 */
function taskCard({ status, title, breadcrumb, meta = [], progress = null, url = null }) {
  const rows = [];

  if (status) rows.push(`<tr><td style="padding:0 0 12px;">${statusPill(status)}</td></tr>`);

  const link = safeUrl(url);
  const titleHtml = link
    ? `<a href="${link}" style="color:${TOKENS.text};text-decoration:none;">${escapeHtml(title)}</a>`
    : escapeHtml(title);
  rows.push(
    `<tr><td style="padding:0;font-family:${TOKENS.font};font-size:17px;font-weight:700;line-height:1.4;color:${TOKENS.text};">${titleHtml}</td></tr>`,
  );

  if (breadcrumb) {
    rows.push(
      `<tr><td style="padding:6px 0 0;font-family:${TOKENS.font};font-size:12px;color:${TOKENS.muted};">${escapeHtml(breadcrumb)}</td></tr>`,
    );
  }

  const visibleMeta = meta.filter((m) => m && m.value !== null && m.value !== undefined && m.value !== '');
  if (visibleMeta.length > 0) {
    const cells = visibleMeta
      .map(
        (m) => [
          `<td width="50%" style="padding:10px 0 0;vertical-align:top;font-family:${TOKENS.font};">`,
          `<div style="font-size:11px;color:${TOKENS.muted};letter-spacing:.04em;text-transform:uppercase;">${escapeHtml(m.label)}</div>`,
          `<div style="font-size:14px;color:${TOKENS.text};font-weight:600;padding-top:2px;">${escapeHtml(m.value)}</div>`,
          '</td>',
        ].join(''),
      );
    const metaRows = [];
    for (let i = 0; i < cells.length; i += 2) {
      metaRows.push(`<tr>${cells[i]}${cells[i + 1] || '<td width="50%"></td>'}</tr>`);
    }
    rows.push(
      `<tr><td style="padding:6px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${metaRows.join('')}</table></td></tr>`,
    );
  }

  if (progress !== null && progress !== undefined) rows.push(`<tr><td style="padding:16px 0 0;">${progressBar(progress)}</td></tr>`);

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;border:1px solid ${TOKENS.border};border-radius:10px;background:${TOKENS.panel};">`,
    `<tr><td style="padding:18px 20px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table>`,
    '</td></tr></table>',
  ].join('');
}

function progressBar(pct) {
  const value = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const color = value >= 100 ? TOKENS.success : brand().color;
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`,
    `<tr><td style="font-family:${TOKENS.font};font-size:11px;color:${TOKENS.muted};padding:0 0 6px;letter-spacing:.04em;text-transform:uppercase;">Progress &middot; ${value}%</td></tr>`,
    `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:999px;background:${TOKENS.track};">`,
    `<tr><td width="${value}%" style="height:6px;line-height:6px;font-size:0;border-radius:999px;background:${color};">&nbsp;</td>`,
    `<td width="${100 - value}%" style="height:6px;line-height:6px;font-size:0;">&nbsp;</td></tr>`,
    '</table></td></tr></table>',
  ].join('');
}

/** A comment, the way ClickUp renders one: avatar, name, time, quoted body. */
function comment({ author, at, body, source = null }) {
  const when = formatWhen(at);
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">`,
    '<tr>',
    `<td width="42" valign="top" style="padding:2px 10px 0 0;">${avatarCircle(author)}</td>`,
    '<td valign="top">',
    `<div style="font-family:${TOKENS.font};font-size:14px;font-weight:700;color:${TOKENS.text};">${escapeHtml(author)}`,
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
      ? `<div style="font-family:${TOKENS.font};font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};padding-bottom:12px;">${escapeHtml(title)}</div>`
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
    `<div style="margin:0 0 4px;font-family:${TOKENS.font};font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${TOKENS.muted};">${escapeHtml(label)}</div>`,
    `<div style="margin:0 0 6px;padding:11px 13px;border-radius:8px;background:${TOKENS.ink};`,
    "font-family:'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;font-size:16px;",
    `letter-spacing:.06em;color:#ffffff;word-break:break-all;`,
    `-webkit-user-select:all;-moz-user-select:all;user-select:all;">${escapeHtml(value)}</div>`,
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
      ? `<div style="font-family:${TOKENS.font};font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};padding-bottom:7px;">${escapeHtml(title)}</div>`
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
    `<div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${TOKENS.muted};padding-bottom:4px;">${escapeHtml(f.label)}</div>`,
    `<div style="font-family:${valueFont};font-size:15px;font-weight:600;line-height:1.5;color:${TOKENS.text};word-break:break-word;">${escapeHtml(f.value)}</div>`,
    '</td>',
  ].join(''));

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-radius:12px;background:${TOKENS.panel};border:1px solid ${TOKENS.border};border-left:3px solid ${accent};">`,
    '<tr><td style="padding:18px 20px;">',
    title
      ? `<div style="font-family:${TOKENS.font};font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};padding-bottom:12px;">${escapeHtml(title)}</div>`
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
    `<div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${TOKENS.muted};padding-bottom:5px;">${escapeHtml(label)}</div>`,
    `<div style="font-size:14px;line-height:1.55;color:${TOKENS.text};">${escapeHtml(value)}</div>`,
    '</div>',
  ].join('');
}

function divider() {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;"><tr><td style="height:1px;line-height:1px;font-size:0;background:${TOKENS.border};">&nbsp;</td></tr></table>`;
}

/** Pill button. The MSO comment gives Outlook a real rectangle to render. */
function button({ label, url, tone = 'primary', margin = '0 0 22px' }) {
  const href = safeUrl(url);
  if (!href) return '';
  const bg = tone === 'secondary' ? TOKENS.card : brand().color;
  const fg = tone === 'secondary' ? TOKENS.text : TOKENS.brandInk;
  const border = tone === 'secondary' ? TOKENS.border : brand().color;
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:${margin};">`,
    '<tr><td align="center" style="border-radius:10px;" bgcolor="' + bg + '">',
    `<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:15px 32px;border-radius:10px;`,
    `border:1px solid ${border};background:${bg};color:${fg};font-family:${TOKENS.font};font-size:15px;`,
    `font-weight:600;letter-spacing:.01em;text-decoration:none;line-height:1;">${escapeHtml(label)}</a>`,
    '</td></tr></table>',
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

  const mark = logo
    ? `<img src="${logo}" alt="${escapeHtml(b.name)}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" `
      + `style="display:block;border:0;width:${LOGO_WIDTH}px;height:${LOGO_HEIGHT}px;max-width:100%;" />`
    : `<div style="font-family:${TOKENS.font};font-size:20px;font-weight:700;letter-spacing:-.01em;color:#ffffff;">${escapeHtml(b.name)}</div>`;

  return [
    `<tr><td class="ew-band" bgcolor="${TOKENS.ink}" style="background-color:${TOKENS.ink};padding:28px 32px 26px;border-radius:14px 14px 0 0;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`,
    '<tr>',
    `<td valign="middle" align="left">${mark}</td>`,
    `<td valign="middle" align="right" style="font-family:${TOKENS.font};font-size:10px;font-weight:700;`,
    `letter-spacing:.14em;text-transform:uppercase;color:${TOKENS.muted};white-space:nowrap;padding-left:16px;">Client portal</td>`,
    '</tr></table>',
    '</td></tr>',
    `<tr><td style="height:3px;line-height:3px;font-size:0;background:${b.color};">&nbsp;</td></tr>`,
  ].join('');
}

function footer({ reason, links = [] }) {
  const b = brand();
  const linkHtml = links
    .map((l) => ({ label: l.label, href: safeUrl(l.url) }))
    .filter((l) => l.href)
    .map((l) => `<a href="${l.href}" style="color:${TOKENS.muted};text-decoration:underline;">${escapeHtml(l.label)}</a>`)
    .join(`<span style="color:${TOKENS.border};"> &nbsp;&middot;&nbsp; </span>`);

  // The sign-off is the wordmark itself, at half the masthead's weight. The
  // brand name survives as the alt text when images are blocked, so the footer
  // still reads as "(c) 2026 EthixWeb" in a text-only client.
  const logo = safeUrl(b.logoUrl);
  const signOff = logo
    ? `<img src="${logo}" alt="${escapeHtml(b.name)}" width="${Math.round(LOGO_WIDTH * 0.62)}" height="${Math.round(LOGO_HEIGHT * 0.62)}" `
      + `style="display:inline-block;border:0;width:${Math.round(LOGO_WIDTH * 0.62)}px;height:${Math.round(LOGO_HEIGHT * 0.62)}px;max-width:100%;opacity:.85;" />`
    : `<span style="font-family:${TOKENS.font};font-size:12px;font-weight:700;color:${TOKENS.soft};">${escapeHtml(b.name)}</span>`;

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0;">`,
    '<tr><td align="center" style="padding:0 12px;">',
    reason
      ? `<div style="font-family:${TOKENS.font};font-size:12px;line-height:1.6;color:${TOKENS.muted};padding-bottom:8px;">${escapeHtml(reason)}</div>`
      : '',
    linkHtml ? `<div style="font-family:${TOKENS.font};font-size:12px;padding-bottom:10px;">${linkHtml}</div>` : '',
    `<div style="padding-bottom:6px;line-height:1;">${signOff}</div>`,
    `<div style="font-family:${TOKENS.font};font-size:11px;color:${TOKENS.muted};">&copy; ${new Date().getFullYear()}</div>`,
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

  const actorRow = actor
    ? [
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;">`,
      '<tr>',
      `<td width="34" valign="middle" style="padding-right:10px;">${avatarCircle(actor.name, { color: actor.color })}</td>`,
      `<td valign="middle" style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.soft};">${escapeHtml(actor.line || actor.name)}</td>`,
      '</tr></table>',
    ].join('')
    : '';

  const body = [
    eyebrowText ? eyebrow(eyebrowText) : '',
    actorRow,
    heading(title),
    ...blocks,
    cta ? button(cta) : '',
    secondaryCta ? button({ ...secondaryCta, tone: 'secondary' }) : '',
  ].join('\n');

  return [
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
    '<html xmlns="http://www.w3.org/1999/xhtml" lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="x-apple-disable-message-reformatting" />',
    // Dark by design, in both modes: this tells a client not to invert it.
    '<meta name="color-scheme" content="dark" />',
    '<meta name="supported-color-schemes" content="dark" />',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    ':root{color-scheme:dark;supported-color-schemes:dark;}',
    // Outlook.com rewrites colours under its own dark theme; these put them
    // back. Everything else already ships the dark values inline.
    `[data-ogsc] .ew-page{background:${TOKENS.page} !important;}`,
    `[data-ogsc] .ew-card{background:${TOKENS.card} !important;}`,
    `[data-ogsc] .ew-text{color:${TOKENS.text} !important;}`,
    '@media only screen and (max-width:720px){',
    '.ew-card{width:100% !important;border-radius:0 !important;}',
    '.ew-pad{padding:24px 18px !important;}',
    '.ew-band{padding:20px 18px !important;border-radius:0 !important;}',
    // Side-by-side halves become full-width rows: below this width there is
    // not enough room for two columns of readable text.
    '.ew-col{display:block !important;width:100% !important;padding:0 0 14px !important;}',
    '}',
    '</style>',
    '</head>',
    `<body class="ew-page" style="margin:0;padding:0;background:${TOKENS.page};-webkit-font-smoothing:antialiased;">`,
    `<div style="display:none;font-size:1px;color:${TOKENS.page};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader)}</div>`,
    `<table role="presentation" class="ew-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.page}" style="background:${TOKENS.page};">`,
    '<tr><td align="center" style="padding:40px 12px 44px;">',
    `<table role="presentation" class="ew-card" width="700" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.card}" style="width:700px;max-width:700px;background:${TOKENS.card};border:1px solid ${TOKENS.border};border-radius:14px;">`,
    header(),
    '<tr><td class="ew-pad" style="padding:30px 34px 32px;">',
    body,
    '</td></tr></table>',
    footer({ reason, links: links || defaultLinks }),
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
