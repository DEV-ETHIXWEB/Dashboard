/* eslint-env serviceworker */

/**
 * Offline shell for the portal.
 *
 * The rule that matters: nothing from /api/ is ever written to the cache. A
 * client's tickets, invoices, and reports live only in memory for as long as
 * the tab is open, so a shared or stolen phone cannot be trawled for them from
 * disk after sign-out. What is cached is the shell -- the hashed bundle, the
 * fonts, the brand marks -- so opening the app on a bad connection still shows
 * the interface instead of a browser error page.
 */

const VERSION = "v1";
const SHELL_CACHE = `ethixweb-shell-${VERSION}`;
const ASSET_CACHE = `ethixweb-assets-${VERSION}`;
const KEEP = [SHELL_CACHE, ASSET_CACHE];

/** The document every in-app route falls back to when the network is gone. */
const SHELL_URL = "/portal";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll([SHELL_URL, "/favicon.svg", "/emblem-mark.png"]))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Signed-in data, and the live stream, must never be served from disk. */
function isPrivate(url) {
  return url.pathname.startsWith("/api/");
}

/** Hashed build output: the name changes when the content does. */
function isImmutableAsset(url) {
  return url.pathname.startsWith("/assets/") || /\.(woff2?|ttf|otf)$/.test(url.pathname);
}

function isBrandArt(url) {
  return /\.(svg|png|jpg|jpeg|webp|ico)$/.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isPrivate(url)) return; // straight to the network, never cached

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(SHELL_URL).then((cached) => cached || Response.error()),
      ),
    );
    return;
  }

  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      }),
    );
    return;
  }

  if (isBrandArt(url)) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => hit || Response.error());
        return hit || network;
      }),
    );
  }
});

/**
 * Signing out wipes the shell caches too. Nothing private is in them, but the
 * next person on this phone should not inherit a warm app either.
 */
self.addEventListener("message", (event) => {
  if (event.data?.type === "clear-caches") {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});
