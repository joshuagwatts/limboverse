/* LIMBO service worker (build 67) — offline-first PWA.
 *
 * After ONE online visit, the whole game (all realms, journey room, sound
 * room, vendor QR libs, three.js from the CDN) is cached, so the game
 * boots with the network fully blocked. This is what makes couch co-op
 * possible on a data-less hotspot: the page itself never needs the net.
 *
 * Strategy: cache-first for everything under our scope; the three.js CDN
 * module too (unpkg serves Access-Control-Allow-Origin: * so it caches
 * fine). Navigations fall back to the cached index.html when offline.
 * Cache name is versioned per BUILD — a new deploy installs a fresh cache
 * and deletes the old ones on activate. Never cache-busts the album mp3s
 * (they may not exist yet; a 404 must not poison anything — only cache
 * successful (ok) responses).
 */

const BUILD = '97';
const CACHE = `limbo-v${BUILD}`;

/* Same version stamps the page uses (?v=97). query strings are part of
   the cache key — that is exactly what we want. */
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css?v=97',
  './js/game.js?v=97',
  './js/net.js?v=97',
  './js/couch.js?v=97',
  './js/jam.js?v=97',
  './js/audio.js?v=97',
  './js/flock.js?v=97',
  './js/vendor/qrcode.js?v=97',
  './js/vendor/jsqr.js?v=97',
  './assets/realm1.jpg',
  './assets/realm2.jpg',
  './assets/realm3.jpg',
  './assets/realm4.jpg',
  './assets/album/album.example.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // three.js lives on a CDN but the game is dead without it — cache it too.
  'https://unpkg.com/three@0.160.0/build/three.module.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll rejects if ANY url fails — cache each independently so one
      // flaky CDN file can't nuke the whole offline install.
      await Promise.all(
        CORE_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'no-cache' });
            if (res && res.ok) await cache.put(url, res);
          } catch (e) {
            /* best effort per asset */
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('limbo-v') && k !== CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  event.respondWith(
    (async () => {
      // Build 87: navigations (the HTML document) go network-first.
      // A refresh must always get the latest index.html with the latest
      // ?v= stamps — cache-first here is what forced the "close the tab"
      // dance. Fall back to cache only when truly offline.
      if (request.mode === 'navigate') {
        try {
          const res = await fetch(request, { cache: 'no-cache' });
          if (res && res.ok) {
            const cache = await caches.open(CACHE);
            cache.put('./index.html', res.clone());
            cache.put('./', res.clone());
          }
          return res;
        } catch (e) {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
          throw e;
        }
      }
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const res = await fetch(request);
        // Only cache successful same-scope responses — never poison the
        // cache with 404s (e.g. the album.json probe when no album ships).
        if (
          res &&
          res.ok &&
          new URL(request.url).origin === self.location.origin
        ) {
          const cache = await caches.open(CACHE);
          cache.put(request, res.clone());
        }
        return res;
      } catch (e) {
        // Fully offline and nothing cached: navigations get the app shell.
        if (request.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        throw e;
      }
    })()
  );
});
