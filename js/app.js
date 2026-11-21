// Einstiegspunkt: verbindet Einstellungen, Kamera, Kalibrierung, Erkennung und Ansichten.
import { settings } from './core/settings.js';
import { requestPersistentStorage } from './core/store.js';
import { CameraService } from './camera/camera-service.js';
import { CalibrationModel } from './calibration/calibration-model.js';
import { TemplateStore } from './recognition/template-store.js';
import { RecognitionService } from './recognition/recognition-service.js';
import { TestTracker } from './test/test-tracker.js';
import { MainView } from './views/main-view.js';
import { SettingsView } from './views/settings-view.js';
import { CameraView } from './views/camera-view.js';
import { TestView } from './views/test-view.js';
import { LearnView } from './views/learn-view.js';

const camera = new CameraService({
  fps: settings.get('camera.fps'),
  keepAwake: settings.get('camera.keepAwake')
});
const calibration = new CalibrationModel();
const templates = new TemplateStore();
const recognition = new RecognitionService({ camera, calibration, settings, templates });
const test = new TestTracker({ camera, calibration });

const ctx = { settings, camera, calibration, templates, recognition, test, navigate };

const ROUTES = {
  haupt: MainView,
  einstellungen: SettingsView,
  kamera: CameraView,
  test: TestView,
  anlernen: LearnView
};

const root = document.getElementById('app');
let current = null;
let currentName = null;

// Navigation OHNE URL-/Hash-Änderung: In Home-Bildschirm-Apps stoppt
// iOS/iPadOS sonst bei jedem Wechsel die Kamera (WebKit-Bug 215884).
function navigate(name) {
  const ViewClass = ROUTES[name] || MainView;
  // Video zuerst in Sicherheit bringen – es bleibt immer im Dokument.
  camera.dock();
  if (current) current.destroy();
  if (ViewClass !== CameraView && calibration.editing) calibration.cancelEdit();
  root.textContent = '';
  current = new ViewClass(ctx);
  currentName = name in ROUTES ? name : 'haupt';
  root.appendChild(current.el);
  current.mount();
  if (!current.hostsCamera) camera.dock();
  window.scrollTo(0, 0);
}

// Zentrale Klicks: Navigation und Kamera (Start direkt im Tipp!).
document.addEventListener('click', (e) => {
  const cam = e.target.closest('[data-camera]');
  if (cam && !cam.disabled) {
    if (cam.dataset.camera === 'start') camera.start();
    else if (cam.dataset.camera === 'stop') camera.stop();
    return;
  }
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    e.preventDefault();
    if (nav.dataset.nav !== currentName) navigate(nav.dataset.nav);
  }
});

// Alte Adressen aus Phase 2 (#/kamera …) einmalig übernehmen, dann URL säubern –
// bevor die Kamera läuft.
const legacy = location.hash.replace(/^#\/?/, '').split('?')[0];
if (location.hash) {
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* egal */ }
}
navigate(legacy && ROUTES[legacy] ? legacy : 'haupt');

// Kamera-Dock nur zeigen, wenn keine Ansicht das Bild selbst einbindet.
camera.on('state', () => {
  if (current && !current.hostsCamera) camera.dock();
});

requestPersistentStorage();

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service Worker nicht registriert', err));
  });
}

// Für Fehlersuche in der Konsole
window.__bj = ctx;
