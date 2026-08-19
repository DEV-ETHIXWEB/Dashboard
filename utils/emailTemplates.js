'use strict';

/**
 * HTML email renderer, built to match the look of a ClickUp notification email.
 *
 * Everything here is table-based with inline styles, because that is the only
 * layout every mail client agrees on. No dependency, no build step: templates
 * are plain functions that return a full HTML document plus a plain-text twin.
 *
 * The layout is deliberately ClickUp's:
 *   - light page, single 600px white card, 12px radius, hairline border
 *   - small uppercase eyebrow, then a short bold sentence as the heading
 *   - a "task card" panel: status pill, title, breadcrumb, meta grid
 *   - one pill button as the single call to action
 *   - quiet footer with the reason the message was sent
 *
 * The palette is EthixWeb's, not ClickUp's: the brand red from the app theme,
 * warm neutrals to sit beside it, and the real emblem in the header. Both the
 * colour and the logo are overridable, so a rebrand is two env vars.
 */

const appUrl = require('./appUrl');

/**
 * Content-Id of the emblem, attached to every outgoing message by
 * utils/mailer.js and referenced as `cid:` in the header.
 *
 * A hosted URL only works when this deployment has a public address; on a
 * laptop it does not, and every inbox would fall back to a bare letter. An
 * inline attachment travels with the message, so the real emblem shows up in
 * Gmail whether the app is on localhost or a domain.
 */
const EMBLEM_CID = 'ethixweb-emblem';
const EMBLEM_SRC = `cid:${EMBLEM_CID}`;

const TOKENS = {
  page: '#f6f4f4',
  card: '#ffffff',
  border: '#e9e2e2',
  panel: '#fbf8f8',
  text: '#1f1a1a',
  soft: '#5f5555',
  muted: '#8d8080',
  // EthixWeb red. Matches --primary in the app theme, oklch(0.50 0.22 29).
  brand: '#c20000',
  brandDeep: '#8f0000',
  brandSoft: '#fdeceb',
  brandInk: '#ffffff',
  success: '#1f9d55',
  warn: '#d97706',
  danger: '#c20000',
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
};

/** Status pill colours, keyed by the lowercase status word. */
const STATUS_COLORS = {
  open: '#c20000',
  'to do': '#8d8080',
  triage: '#8d8080',
  'in progress': '#e0562a',
  'waiting on client': '#d97706',
  review: '#8f0000',
  resolved: '#1f9d55',
  done: '#1f9d55',
  closed: '#6b6060',
  complete: '#1f9d55',
  urgent: '#8f0000',
  high: '#c20000',
  normal: '#e0562a',
  low: '#8d8080',
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
    // The EthixWeb emblem from this app's own public/ folder. A hosted URL is
    // used when there is a publicly reachable one (utils/appUrl.js resolves it
    // from APP_BASE_URL or the origin the app is served on); otherwise the
    // emblem rides along as an inline attachment, so it renders either way.
    logoUrl: appUrl.logoUrl() || EMBLEM_SRC,
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
  // `cid:` is the inline emblem this renderer attaches itself, never template data.
  if (url === EMBLEM_SRC) return url;
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
  return `<div style="margin:0 0 10px;font-family:${TOKENS.font};font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:${TOKENS.muted};">${escapeHtml(text)}</div>`;
}

function heading(text) {
  return `<h1 style="margin:0 0 8px;font-family:${TOKENS.font};font-size:22px;line-height:1.32;font-weight:700;color:${TOKENS.text};">${escapeHtml(text)}</h1>`;
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
    `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:999px;background:#efe6e6;">`,
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

/** Highlighted strip for credentials, warnings, and deadlines. */
function callout({ tone = 'info', title, body, mono = false }) {
  const accent = { info: brand().color, success: TOKENS.success, warn: TOKENS.warn, danger: TOKENS.danger }[tone] || brand().color;
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-radius:10px;background:${TOKENS.panel};border:1px solid ${TOKENS.border};border-left:3px solid ${accent};">`,
    '<tr><td style="padding:14px 16px;">',
    title
      ? `<div style="font-family:${TOKENS.font};font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${accent};padding-bottom:6px;">${escapeHtml(title)}</div>`
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
    `<div style="font-family:${valueFont};font-size:14px;line-height:1.5;color:${TOKENS.text};word-break:break-word;">${escapeHtml(f.value)}</div>`,
    '</td>',
  ].join(''));

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-radius:10px;background:${TOKENS.panel};border:1px solid ${TOKENS.border};border-left:3px solid ${accent};">`,
    '<tr><td style="padding:14px 16px;">',
    title
      ? `<div style="font-family:${TOKENS.font};font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${accent};padding-bottom:10px;">${escapeHtml(title)}</div>`
      : '',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells.join('')}</tr></table>`,
    note
      ? `<div style="font-family:${TOKENS.font};font-size:12px;line-height:1.6;color:${TOKENS.soft};padding-top:10px;">${escapeHtml(note)}</div>`
      : '',
    '</td></tr></table>',
  ].join('');
}

function divider() {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;"><tr><td style="height:1px;line-height:1px;font-size:0;background:${TOKENS.border};">&nbsp;</td></tr></table>`;
}

/** Pill button. The MSO comment gives Outlook a real rectangle to render. */
function button({ label, url, tone = 'primary' }) {
  const href = safeUrl(url);
  if (!href) return '';
  const bg = tone === 'secondary' ? TOKENS.card : brand().color;
  const fg = tone === 'secondary' ? TOKENS.text : TOKENS.brandInk;
  const border = tone === 'secondary' ? TOKENS.border : brand().color;
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;">`,
    '<tr><td align="center" style="border-radius:8px;" bgcolor="' + bg + '">',
    `<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 26px;border-radius:8px;`,
    `border:1px solid ${border};background:${bg};color:${fg};font-family:${TOKENS.font};font-size:15px;`,
    `font-weight:600;text-decoration:none;line-height:1;">${escapeHtml(label)}</a>`,
    '</td></tr></table>',
  ].join('');
}

// --- document --------------------------------------------------------------

function header() {
  const b = brand();
  const logo = safeUrl(b.logoUrl);
  // The emblem is a PNG on this app's own origin, 397x406 with the artwork
  // running to the edge. It gets the same treatment as the sidebar: a dark
  // rounded tile with breathing room, and its true aspect ratio kept, rather
  // than being squeezed into a square and clipped by the corner radius.
  // Clients that block images fall back to the alt text; the lettermark is
  // only used when there is no absolute URL to point at at all.
  const mark = logo
    ? [
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="background:#0d0d0d;border-radius:9px;">`,
      `<tr><td align="center" valign="middle" width="36" height="36" style="width:36px;height:36px;padding:5px;line-height:0;">`,
      `<img src="${logo}" alt="${escapeHtml(b.name)}" width="26" height="27" `,
      `style="display:block;border:0;width:26px;height:27px;" />`,
      '</td></tr></table>',
    ].join('')
    : [
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="background:${b.color};border-radius:9px;">`,
      `<tr><td align="center" valign="middle" width="36" height="36" style="width:36px;height:36px;`,
      `font-family:${TOKENS.font};font-size:16px;font-weight:700;color:#ffffff;">`,
      `${escapeHtml(b.name.charAt(0).toUpperCase())}</td></tr></table>`,
    ].join('');

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">`,
    '<tr>',
    `<td width="48" valign="middle" style="padding-right:12px;">${mark}</td>`,
    '<td valign="middle">',
    `<div style="font-family:${TOKENS.font};font-size:16px;font-weight:700;color:${TOKENS.text};letter-spacing:-.01em;line-height:1.1;">${escapeHtml(b.name)}</div>`,
    `<div style="font-family:${TOKENS.font};font-size:11px;color:${TOKENS.muted};letter-spacing:.06em;text-transform:uppercase;padding-top:2px;">Client portal</div>`,
    '</td>',
    '</tr></table>',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">`,
    `<tr><td style="height:2px;line-height:2px;font-size:0;background:${b.color};border-radius:2px;">&nbsp;</td></tr>`,
    '</table>',
  ].join('');
}

function footer({ reason, links = [] }) {
  const b = brand();
  const linkHtml = links
    .map((l) => ({ label: l.label, href: safeUrl(l.url) }))
    .filter((l) => l.href)
    .map((l) => `<a href="${l.href}" style="color:${TOKENS.muted};text-decoration:underline;">${escapeHtml(l.label)}</a>`)
    .join(`<span style="color:${TOKENS.border};"> &nbsp;&middot;&nbsp; </span>`);

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0;">`,
    '<tr><td align="center" style="padding:0 12px;">',
    reason
      ? `<div style="font-family:${TOKENS.font};font-size:12px;line-height:1.6;color:${TOKENS.muted};padding-bottom:8px;">${escapeHtml(reason)}</div>`
      : '',
    linkHtml ? `<div style="font-family:${TOKENS.font};font-size:12px;padding-bottom:8px;">${linkHtml}</div>` : '',
    `<div style="font-family:${TOKENS.font};font-size:11px;color:${TOKENS.muted};">&copy; ${new Date().getFullYear()} ${escapeHtml(b.name)}</div>`,
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
    b.baseUrl ? { label: 'Notification settings', url: `${b.baseUrl}/portal/settings` } : null,
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
    '<meta name="color-scheme" content="light only" />',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    '@media only screen and (max-width:660px){',
    '.ew-card{width:100% !important;border-radius:0 !important;}',
    '.ew-pad{padding:24px 18px !important;}',
    // Side-by-side halves become full-width rows: below this width there is
    // not enough room for two columns of readable text.
    '.ew-col{display:block !important;width:100% !important;padding:0 0 14px !important;}',
    '}',
    '</style>',
    '</head>',
    `<body style="margin:0;padding:0;background:${TOKENS.page};-webkit-font-smoothing:antialiased;">`,
    `<div style="display:none;font-size:1px;color:${TOKENS.page};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${TOKENS.page};">`,
    '<tr><td align="center" style="padding:32px 12px;">',
    `<table role="presentation" class="ew-card" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:${TOKENS.card};border:1px solid ${TOKENS.border};border-top:4px solid ${b.color};border-radius:12px;">`,
    '<tr><td class="ew-pad" style="padding:28px 32px 30px;">',
    header(),
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
  EMBLEM_CID,
  EMBLEM_SRC,
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
  detailPanel,
  divider,
  button,
  renderEmail,
  renderText,
};
