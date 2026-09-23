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

const BUILD = '82';
const CACHE = `limbo-v${BUILD}`;

/* Same version stamps the page uses (?v=82). query strings are part of
   the cache key — that is exactly what we want. */
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css?v=82',
  './js/game.js?v=82',
  './js/net.js?v=82',
  './js/couch.js?v=82',
  './js/jam.js?v=82',
  './js/audio.js?v=82',
  './js/flock.js?v=82',
  './js/vendor/qrcode.js?v=82',
  './js/vendor/jsqr.js?v=82',
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
