import { ICONS, esc } from '../core/dom.js';
import { CameraState, CAMERA_STATE_LABEL } from '../camera/camera-service.js';

// Navigation erfolgt über data-nav="<ansicht>" (ohne URL-/Hash-Änderung,
// weil iOS/iPadOS in Home-Bildschirm-Apps sonst die Kamera stoppt).

export class View {
  constructor(ctx) {
    this.ctx = ctx;
    this._subs = [];
    this.el = document.createElement('div');
  }

  listen(emitter, type, fn) {
    this._subs.push(emitter.on(type, fn));
  }

  mount() {}

  // Hat die Ansicht das Kamerabild selbst eingebunden? Sonst ins Dock.
  get hostsCamera() {
    return false;
  }

  destroy() {
    this._subs.forEach((off) => off());
    this._subs = [];
  }
}

export function subHeader(title, back = 'haupt') {
  return `
    <header class="subbar">
      <button type="button" class="icon-btn icon-btn--plain" data-nav="${back}" aria-label="Zurück">${ICONS.back}</button>
      <h1 class="subbar-title">${esc(title)}</h1>
    </header>`;
}

export function cameraStatus(ctx) {
  const { camera, calibration } = ctx;
  const state = camera.state;
  const compat = calibration.compatibility(camera.dimensions());
  let tone = 'idle';
  if (state === CameraState.ACTIVE) tone = compat.ok ? 'ok' : 'warn';
  if (state === CameraState.ERROR || state === CameraState.INTERRUPTED) tone = 'warn';
  return {
    state,
    tone,
    label: CAMERA_STATE_LABEL[state] || state,
    compat,
    calibrated: calibration.hasSaved
  };
}

export function compatMessage(compat) {
  if (!compat || compat.ok) return null;
  if (compat.reason === 'orientation') {
    const want = compat.expected === 'landscape' ? 'Querformat' : 'Hochformat';
    return {
      title: 'Bildausrichtung geändert',
      message: `Die Kalibrierung wurde im ${want} gespeichert. Sie bleibt erhalten und ist pausiert. Drehe das Gerät zurück oder kalibriere neu. (Unter iPadOS 26.0 drehte ein Fehler das Kamerabild in Home-Bildschirm-Apps – bitte auf iPadOS 26.1 oder neuer aktualisieren.)`
    };
  }
  return {
    title: 'Bildausschnitt geändert',
    message: 'Das Kamerabild hat ein anderes Seitenverhältnis als bei der Kalibrierung. Die Kalibrierung bleibt erhalten und ist pausiert. Bitte neu kalibrieren, falls das so bleibt.'
  };
}

export function warningBanner({ title, message }) {
  return `
    <div class="warn-banner" role="alert">
      <span class="warn-banner-icon">${ICONS.warning}</span>
      <div>
        <strong>${esc(title)}</strong>
        <p>${esc(message)}</p>
      </div>
    </div>`;
}

// Kamera-Startknopf: Start MUSS direkt im Tipp passieren (iOS).
export function cameraButton(camera, { compact = false } = {}) {
  const cls = compact ? 'btn btn--primary btn--compact' : 'btn btn--primary';
  if (camera.state === CameraState.STARTING) return `<button type="button" class="${cls}" disabled>Kamera startet …</button>`;
  if (camera.canResume) return `<button type="button" class="${cls}" data-camera="start">Kamera fortsetzen</button>`;
  if (camera.isRunning) return `<button type="button" class="btn btn--secondary${compact ? ' btn--compact' : ''}" data-camera="stop">Kamera stoppen</button>`;
  return `<button type="button" class="${cls}" data-camera="start">Kamera starten</button>`;
}
