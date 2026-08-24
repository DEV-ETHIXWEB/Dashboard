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

// Bump this whenever the shell or the icons change. The browser only installs a
// worker whose bytes differ from the one it has, and everything else in this
// file is stable -- so without a bump here a phone that installed the app once
// keeps serving its original cached shell offline forever, script tags and all,
// pointing at hashed bundles that no longer exist on the server.
const VERSION = "v2";
const SHELL_CACHE = `ethixweb-shell-${VERSION}`;
const ASSET_CACHE = `ethixweb-assets-${VERSION}`;
const KEEP = [SHELL_CACHE, ASSET_CACHE];

/** The document every in-app route falls back to when the network is gone. */
const SHELL_URL = "/portal";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // /favicon.svg used to be in this list and has never existed -- the file
      // is favicon.png. It did not fail loudly because the SPA fallback answers
      // every unknown path with the app shell at 200, so the worker cached a
      // page of HTML under a .svg URL and served it back as an icon.
      .then((cache) => cache.addAll([SHELL_URL, "/favicon.png", "/emblem-mark.png"]))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      // Take a fresh copy of the shell as this version comes up. The install
      // step already did, but only for a first install; a returning phone that
      // is upgrading has an old document sitting under the same key, and the
      // navigation handler is the only thing that reads it -- which happens
      // exactly when there is no network to correct it with.
      .then(() =>
        caches
          .open(SHELL_CACHE)
          .then((cache) => cache.add(SHELL_URL))
          .catch(() => undefined),
      )
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

/**
 * The brand artwork, named by where it lives rather than by how it is spelled.
 *
 * Matching a bare extension meant any same-origin path ending in .png was
 * cacheable -- including one serving somebody's uploaded document, if a
 * download route is ever mounted outside /api/. The static art sits at the root
 * and under /mail-icons/, and that is the whole of it.
 */
const BRAND_ART = new Set([
  "/favicon.png",
  "/emblem-mark.png",
  "/emblem-mark-red.png",
  "/ethixweb.png",
  "/icons.svg",
  "/spiderweb.svg",
]);

function isBrandArt(url) {
  return BRAND_ART.has(url.pathname) || url.pathname.startsWith("/mail-icons/");
}

/**
 * Whether a response is safe to keep under the URL that was asked for.
 *
 * The SPA fallback answers every unknown path with the app shell at 200, so a
 * hashed chunk that goes missing after a deploy does not 404 -- it returns
 * HTML. Cached under its .js name by a cache-first rule that never revalidates,
 * that leaves the tab permanently broken for that one visitor. A document is
 * only ever the right answer for a navigation.
 */
function isCacheableAsset(res) {
  if (!res || !res.ok || res.type === "opaque" || res.redirected) return false;
  const type = res.headers.get("content-type") || "";
  return !type.includes("text/html");
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
        if (isCacheableAsset(res)) cache.put(request, res.clone());
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
            if (isCacheableAsset(res)) cache.put(request, res.clone());
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
