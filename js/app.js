// Einstiegspunkt: verbindet Einstellungen, Kamera, Kalibrierung, Erkennung und Ansichten.
import { settings } from './core/settings.js';
import { requestPersistentStorage } from './core/store.js';
import { display } from './core/display.js';
import { updates } from './core/updates.js';
import { ICONS } from './core/dom.js';
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

const ctx = { settings, camera, calibration, templates, recognition, test, display, updates, navigate };

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
  // Blockierte Wiedergabe (schwarzes Bild ohne Fehlermeldung): jeder Tipp gibt sie frei.
  if (camera.playBlocked) camera.unblockPlayback();
  const cam = e.target.closest('[data-camera]');
  if (cam && !cam.disabled) {
    const a = cam.dataset.camera;
    if (a === 'start') camera.start();
    else if (a === 'retry') camera.start({ force: true });
    else if (a === 'restart') camera.restart();
    else if (a === 'stop') camera.stop();
    else if (a === 'play') camera.unblockPlayback();
    return;
  }
  const app = e.target.closest('[data-app]');
  if (app && !app.disabled) {
    const a = app.dataset.app;
    if (a === 'fullscreen') display.toggleFullscreen();
    else if (a === 'update-apply') updates.apply();
    else if (a === 'update-check') updates.check();
    else if (a === 'update-later') { updateDismissed = true; renderUpdateBar(); }
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

// :active-Rückmeldung beim Tippen auf iOS aktivieren.
document.addEventListener('touchstart', () => {}, { passive: true });

// Hinweisleiste für neue Versionen (liegt über allen Ansichten).
const updateBar = document.createElement('div');
updateBar.className = 'update-bar';
updateBar.setAttribute('role', 'status');
updateBar.hidden = true;
document.body.appendChild(updateBar);
let updateDismissed = false;
function renderUpdateBar() {
  const show = updates.available && !updateDismissed;
  updateBar.hidden = !show;
  if (!show) return;
  updateBar.innerHTML = `
    <span class="update-bar-text">${ICONS.check}<span><b>Neue Version verfügbar.</b> Kalibrierung und angelernte Karten bleiben erhalten.</span></span>
    <span class="update-bar-actions">
      <button type="button" class="btn btn--ghost btn--compact" data-app="update-later">Später</button>
      <button type="button" class="btn btn--primary btn--compact" data-app="update-apply">Aktualisieren</button>
    </span>`;
}
updates.on('change', renderUpdateBar);

if (updates.supported) {
  if (document.readyState === 'complete') updates.register();
  else window.addEventListener('load', () => updates.register());
}

// Für Fehlersuche in der Konsole
window.__bj = ctx;
