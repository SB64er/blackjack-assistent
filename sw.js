// Service Worker: speichert nur die App-Dateien (HTML, CSS, JS, Icons).
// Kamerabilder werden nie gespeichert oder übertragen.
//
// Phase 4:
// - Bei jeder neuen Version VERSION erhöhen (muss zu js/core/version.js passen,
//   prüft `npm test`). Alle App-Dateien werden dann frisch geladen.
// - App-Dateien kommen aus dem Cache (schneller Start, sicher offline).
//   Auch die Seite selbst, damit HTML und Skripte immer zur gleichen Version gehören.
// - Eine neue Version wartet, bis der Benutzer "Aktualisieren" tippt
//   (kein Neuladen mitten in einer Runde). Erstinstallation übernimmt sofort.
// - Gelöscht werden nur alte Caches dieser App.
const VERSION = 'bj-assistent-v0.8.0';
const PREFIX = 'bj-assistent-';
const NAV_TIMEOUT_MS = 3000;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/core/store.js',
  './js/core/events.js',
  './js/core/settings.js',
  './js/core/dom.js',
  './js/demo/scenarios.js',
  './js/core/version.js',
  './js/core/display.js',
  './js/core/updates.js',
  './js/game/hand.js',
  './js/recognition/vision.js',
  './js/recognition/analyzer.js',
  './js/recognition/template-store.js',
  './js/recognition/round-tracker.js',
  './js/recognition/recognition-service.js',
  './js/recognition/detection-overlay.js',
  './js/camera/camera-diagnostics.js',
  './js/views/learn-view.js',
  './js/views/strategy-view.js',
  './js/views/profile-view.js',
  './js/views/archive-view.js',
  './js/views/round-view.js',
  './js/views/yumeko-view.js',
  './js/views/knowledge-view.js',
  './js/views/video-view.js',
  './js/views/lab-view.js',
  './js/views/risk-view.js',
  './js/views/chat-view.js',
  './js/views/academy-view.js',
  './js/academy/youtube.js',
  './js/academy/extract.js',
  './js/academy/verify.js',
  './js/academy/server-client.js',
  './js/academy/academy-store.js',
  './js/archive/insights.js',
  './js/strategy/exact.js',
  './js/strategy/table-rules.js',
  './js/core/idb.js',
  './js/game/card-tracker.js',
  './js/game/round-state.js',
  './js/game/settle.js',
  './js/archive/round-record.js',
  './js/archive/archive-store.js',
  './js/yumeko/knowledge.js',
  './js/yumeko/archive-analysis.js',
  './js/yumeko/yumeko.js',
  './js/yumeko/video-learner.js',
  './js/yumeko/decision.js',
  './js/yumeko/chat.js',
  './js/yumeko/sim-store.js',
  './js/risk/bankroll.js',
  './js/risk/risk.js',
  './js/strategy/standard.js',
  './js/strategy/engine.js',
  './js/strategy/ev.js',
  './js/strategy/analysis.js',
  './js/strategy/simulate.js',
  './js/strategy/profiles.js',
  './js/strategy/research.js',
  './js/camera/camera-service.js',
  './js/calibration/geometry.js',
  './js/calibration/calibration-store.js',
  './js/calibration/calibration-model.js',
  './js/calibration/calibration-editor.js',
  './js/test/test-tracker.js',
  './js/views/view-base.js',
  './js/views/main-view.js',
  './js/views/settings-view.js',
  './js/views/camera-view.js',
  './js/views/test-view.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

const ASSET_URLS = new Set(ASSETS.map((a) => new URL(a, self.location).href));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // cache: 'reload' umgeht den HTTP-Cache, damit wirklich die neue Version gespeichert wird.
    await cache.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' })));
    // Erstinstallation: sofort übernehmen. Update: auf Bestätigung warten.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') self.skipWaiting();
  if (type === 'GET_VERSION' && event.source) event.source.postMessage({ type: 'VERSION', version: VERSION });
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

async function fromNetworkAndStore(req, cacheKey = req) {
  const res = await fetch(req);
  if (res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(VERSION).then((cache) => cache.put(cacheKey, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Seite (App-Start): aus dem Cache dieser Version, damit HTML und Skripte
  // immer zusammenpassen. Neue Versionen kommen über das Update (Hinweis in der App).
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = (await cache.match('./index.html')) || (await cache.match('./'));
      if (hit) return hit;
      try {
        return await Promise.race([fetch(req), timeout(NAV_TIMEOUT_MS * 3)]);
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  // App-Dateien: aus dem Cache dieser Version (gehören zusammen).
  const key = url.origin + url.pathname;
  if (ASSET_URLS.has(key)) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(key);
      if (hit) return hit;
      return fromNetworkAndStore(req, key);
    })());
    return;
  }

  // Sonstiges: Netz, offline aus dem Cache.
  event.respondWith(
    fetch(req).catch(async () => (await caches.match(req)) || Response.error())
  );
});
