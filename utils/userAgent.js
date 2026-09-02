'use strict';

/**
 * Naming the thing somebody signed in from.
 *
 * The session list on the profile page exists for one purpose: letting a person
 * look down it and notice a line that is not them. "Another device" cannot do
 * that job -- it is the same words for the laptop they are holding and for
 * somebody else's phone in another country. A name can.
 *
 * A user agent string is self-reported and trivially forged, so this is a
 * label, never a control. Nothing is authorised or refused on the strength of
 * it. What it buys is recognition: a person knows whether they own a Windows
 * desktop and an iPhone, and a row saying "Firefox on Linux" when they own
 * neither is the entire point of showing the list.
 *
 * Deliberately no dependency. A UA-parsing library carries a database of
 * hundreds of devices that has to be kept current; this needs to tell the
 * half-dozen families that actually reach a business dashboard apart, and
 * getting that wrong degrades to "Unknown device" rather than to a wrong
 * answer.
 */

/** Longest UA we will look at. Anything beyond this is noise or an attack. */
const MAX_UA_LENGTH = 512;

/**
 * Order matters throughout: every one of these families lies about the others.
 *
 * Edge says "Chrome" and "Safari"; Chrome says "Safari"; Opera says both. So
 * the most specific claim is tested first and the most-lied-about last.
 */
const BROWSERS = [
  [/\bEdg(?:e|A|iOS)?\//i, 'Edge'],
  [/\bOPR\/|\bOpera\//i, 'Opera'],
  [/\bSamsungBrowser\//i, 'Samsung Internet'],
  [/\bVivaldi\//i, 'Vivaldi'],
  [/\bBrave\//i, 'Brave'],
  [/\bFirefox\/|\bFxiOS\//i, 'Firefox'],
  [/\bCriOS\//i, 'Chrome'],
  [/\bChrome\//i, 'Chrome'],
  [/\bSafari\//i, 'Safari'],
];

/**
 * Same trick, same reason. iPadOS reports itself as a Macintosh, so the iPad
 * has to be caught by its touch hint before the Mac pattern can claim it.
 */
const PLATFORMS = [
  [/\biPhone\b/i, 'iPhone'],
  [/\biPad\b/i, 'iPad'],
  [/\bAndroid\b/i, 'Android'],
  [/\bWindows NT\b/i, 'Windows'],
  [/\bCrOS\b/i, 'ChromeOS'],
  // An iPad in desktop mode: a Mac that also reports a touchscreen is not a Mac.
  [/\bMacintosh\b.*\bMobile\b/i, 'iPad'],
  [/\bMac OS X\b|\bMacintosh\b/i, 'macOS'],
  [/\bLinux\b/i, 'Linux'],
];

function matchFirst(table, value) {
  for (const [pattern, label] of table) {
    if (pattern.test(value)) return label;
  }
  return null;
}

/**
 * "Chrome on Windows", or the most honest thing that can be said.
 *
 * Never throws and never returns an empty string: a caller is putting this
 * straight on screen, and a blank row is worse than an admitted unknown.
 */
function describeDevice(userAgent) {
  const ua = String(userAgent || '').slice(0, MAX_UA_LENGTH).trim();
  if (!ua) return 'Unknown device';

  const browser = matchFirst(BROWSERS, ua);
  const platform = matchFirst(PLATFORMS, ua);

  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  // A platform with no recognisable browser is usually a script or an app
  // talking to the API rather than a person in a browser -- worth saying so
  // plainly, because that is exactly the row somebody should look twice at.
  if (platform) return `Unknown browser on ${platform}`;
  return 'Unknown device';
}

/**
 * The kind of thing it is, for choosing an icon.
 *
 * Three buckets is as fine-grained as this can be while staying honest.
 */
function deviceKind(userAgent) {
  const ua = String(userAgent || '').slice(0, MAX_UA_LENGTH);
  if (/\biPhone\b|\bAndroid\b.*\bMobile\b|\bWindows Phone\b/i.test(ua)) return 'phone';
  if (/\biPad\b|\bTablet\b|\bAndroid\b/i.test(ua)) return 'tablet';
  if (/Mozilla|AppleWebKit|Gecko/i.test(ua)) return 'desktop';
  return 'unknown';
}

/** What is safe to store: bounded, and never a value we did not read. */
function storableUserAgent(userAgent) {
  const ua = String(userAgent || '').slice(0, MAX_UA_LENGTH).trim();
  return ua || null;
}

module.exports = { MAX_UA_LENGTH, describeDevice, deviceKind, storableUserAgent };
