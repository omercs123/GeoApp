/* ─────────────────────────────────────────────────────────────────────────
   Location Alarm — Service Worker
   Strategy:
     • App shell (HTML, manifest, icons, Leaflet) → cache-first, revalidate
     • Map tiles (OSM) → cache-first, background fetch, cap at MAX_TILES
     • Nominatim search API  → network-only (dynamic, can't cache)
   ───────────────────────────────────────────────────────────────────────── */

const VER        = 'v1';
const APP_CACHE  = `loc-alarm-app-${VER}`;
const TILE_CACHE = `loc-alarm-tiles-${VER}`;
const MAX_TILES  = 300;

/* Files guaranteed to exist locally — cached on install */
const CRITICAL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

/* CDN assets — best-effort (may fail if offline at install time) */
const CDN_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

/* ── Install ──────────────────────────────────────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE).then(async cache => {
      await cache.addAll(CRITICAL_ASSETS);
      /* CDN: try individually so one failure doesn't break the whole install */
      await Promise.allSettled(CDN_ASSETS.map(url => cache.add(url)));
    }).then(() => self.skipWaiting())
  );
});

/* ── Activate ─────────────────────────────────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith('loc-alarm-') && k !== APP_CACHE && k !== TILE_CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch ────────────────────────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* Ignore non-GET, browser internals, and chrome-extension requests */
  if (request.method !== 'GET') return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* Nominatim geocoding API → network only, no cache */
  if (url.hostname === 'nominatim.openstreetmap.org') return;

  /* OSM tile servers → cache-first with background fetch */
  if (url.hostname.endsWith('.tile.openstreetmap.org')) {
    event.respondWith(handleTile(request));
    return;
  }

  /* Everything else (app shell + Leaflet CDN) → stale-while-revalidate */
  event.respondWith(handleShell(request));
});

/* ── Shell strategy: serve cached immediately, revalidate in background ─ */
async function handleShell(request) {
  const cache  = await caches.open(APP_CACHE);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  /* Return cached instantly; if nothing cached, wait for network */
  return cached ?? (await fetchPromise) ?? offlineFallback();
}

/* ── Tile strategy: cache-first, evict oldest when cap is reached ──────── */
async function handleTile(request) {
  const cache  = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      /* Evict oldest tile if over cap */
      const keys = await cache.keys();
      if (keys.length >= MAX_TILES) await cache.delete(keys[0]);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    /* Return transparent 1×1 PNG so the map doesn't hard-error */
    return new Response(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
      { headers: { 'Content-Type': 'image/png' } }
    );
  }
}

function offlineFallback() {
  return new Response('<h2 style="font-family:sans-serif;padding:2rem">Offline — open the app once with internet to cache it.</h2>',
    { headers: { 'Content-Type': 'text/html' } });
}
