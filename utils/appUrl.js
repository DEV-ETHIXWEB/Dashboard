'use strict';

/**
 * The public address of this deployment.
 *
 * Email needs absolute URLs -- for the buttons, and for the EthixWeb wordmark
 * in the header, which is served from this app's own public/ folder. APP_BASE_URL
 * is the authority when it is set. When it is not, the first real request is
 * used to learn the origin, so a fresh install still sends working links and a
 * visible logo instead of bare text.
 *
 * Express `trust proxy` is already on in production, so req.protocol and Host
 * reflect what the browser actually asked for rather than the internal port.
 */

let observed = null;

/**
 * The origin the browser is actually on, from the headers it sends itself.
 *
 * Host is the wrong answer behind a proxy that rewrites it -- the Vite dev
 * server proxies /api with `changeOrigin: true`, so Host arrives as the
 * backend's own `127.0.0.1:4000` while the person is looking at
 * `http://localhost:5173`. Origin (and Referer, for a plain navigation) survive
 * that rewrite, so they are asked first and Host is the last resort.
 */
function originFromHeaders(req) {
  const origin = req.get?.('origin');
  if (origin && origin !== 'null') return origin;

  const referer = req.get?.('referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      // fall through to Host
    }
  }

  const host = req.get?.('host');
  return host ? `${req.protocol}://${host}` : null;
}

/** Called once per request; the first usable value sticks. */
function rememberFromRequest(req) {
  if (process.env.APP_BASE_URL || observed) return;
  const found = originFromHeaders(req);
  if (!found) return;
  observed = found;
}

/** Configured value first, then whatever the app learned from traffic. */
function baseUrl() {
  const configured = process.env.APP_BASE_URL || observed || '';
  return configured.replace(/\/$/, '');
}

/**
 * Whether an address is reachable from the outside world.
 *
 * A mail client fetches the logo from its own network, so a localhost or
 * private-LAN URL renders as a broken image in every inbox. Better to know
 * that here and fall back to the lettermark than to ship a broken box.
 */
function isPubliclyReachable(url) {
  if (!url) return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '::1' || host === '[::1]') return false;
  if (/^127\./.test(host) || host === '0.0.0.0') return false;
  // RFC 1918 private ranges.
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

/**
 * The EthixWeb wordmark shipped in public/, as an absolute URL mail clients
 * can fetch.
 * Returns null when there is nothing an inbox could reach, which makes the
 * header fall back to the lettermark instead of a broken image.
 */
function logoUrl() {
  if (process.env.MAIL_LOGO_URL) return process.env.MAIL_LOGO_URL;
  const base = baseUrl();
  if (!base || !isPubliclyReachable(base)) return null;
  return `${base}/ethixweb.png`;
}

module.exports = { rememberFromRequest, baseUrl, logoUrl, isPubliclyReachable };
