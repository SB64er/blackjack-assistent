// Service Worker: speichert nur die App-Dateien (HTML, CSS, JS, Icons).
// Kamerabilder werden nie gespeichert oder übertragen.
// Bei jeder neuen Version VERSION erhöhen, damit iPhones die Dateien aktualisieren.
const VERSION = 'bj-assistent-v0.3.0';

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
  './js/game/hand.js',
  './js/recognition/vision.js',
  './js/recognition/analyzer.js',
  './js/recognition/template-store.js',
  './js/recognition/round-tracker.js',
  './js/recognition/recognition-service.js',
  './js/recognition/detection-overlay.js',
  './js/camera/camera-diagnostics.js',
  './js/views/learn-view.js',
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

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Netzwerk zuerst (damit Updates sofort ankommen), offline aus dem Cache.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        if (req.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
