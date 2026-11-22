// Kamera-Diagnose: sammelt technische Angaben, um Probleme (z. B. iPad als
// Home-Bildschirm-App) nachvollziehen zu können. Enthält keine Bilder.
import { isStandalone, isIPad, CAMERA_STATE_LABEL } from './camera-service.js';
import { APP_VERSION } from '../core/version.js';

async function permissionState() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return 'nicht abfragbar';
    const r = await navigator.permissions.query({ name: 'camera' });
    return { granted: 'erlaubt', denied: 'verweigert', prompt: 'wird abgefragt' }[r.state] || r.state;
  } catch {
    return 'nicht abfragbar';
  }
}

async function videoInputCount() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return 'n/a';
    const list = await navigator.mediaDevices.enumerateDevices();
    return String(list.filter((d) => d.kind === 'videoinput').length);
  } catch {
    return 'Fehler';
  }
}

export async function collectDiagnostics(camera, ctx = {}) {
  const info = camera.info();
  const v = camera.video;
  const age = camera.lastFrameAt ? Math.round(performance.now() - camera.lastFrameAt) : null;
  return [
    ['App-Version', APP_VERSION],
    ['Zeit', new Date().toLocaleString('de-CH')],
    ['Gerät', isIPad() ? 'iPad' : (/iPhone/.test(navigator.userAgent) ? 'iPhone' : 'anderes')],
    ['Startart', isStandalone() ? 'Home-Bildschirm-App' : 'Browser-Tab'],
    ['Sicherer Kontext (HTTPS)', window.isSecureContext ? 'ja' : 'NEIN'],
    ['mediaDevices vorhanden', navigator.mediaDevices ? 'ja' : 'NEIN'],
    ['getUserMedia vorhanden', navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? 'ja' : 'NEIN'],
    ['Kamera-Berechtigung', await permissionState()],
    ['Anzahl Kameras', await videoInputCount()],
    ['Kamerazustand', CAMERA_STATE_LABEL[camera.state] || camera.state],
    ['Letzter Fehler', camera.lastErrorRaw ? `${camera.lastErrorRaw.name}: ${camera.lastErrorRaw.message}` : '–'],
    ['Einstellungsstufe', camera.constraintLevel == null ? '–' : ['hoch (1920×1080)', 'nur Rückkamera', 'Standard'][camera.constraintLevel]],
    ['Bild', info ? `${info.width}×${info.height} · ${info.frameRate} fps · ${info.facingMode}` : '–'],
    ['Video readyState', String(v.readyState)],
    ['Wiedergabe', !camera.stream ? '–' : (camera.playBlocked ? 'BLOCKIERT (Tipp nötig)' : (v.paused ? 'pausiert' : 'läuft'))],
    ['Startdauer', camera.startDurationMs == null ? '–' : `${camera.startDurationMs} ms`],
    ['Selbstreparaturen', String(camera.repairs || 0)],
    ['Bildhelligkeit', camera.brightness == null ? '–' : `${camera.brightness} / 255`],
    ['Anzeige', ctx.display ? ctx.display.modeLabel : '–'],
    ['Bildschirm', `${window.innerWidth}×${window.innerHeight} · ${window.innerWidth >= window.innerHeight ? 'quer' : 'hoch'} · ${window.devicePixelRatio}x`],
    ['Offline-Version', ctx.updates ? (ctx.updates.offlineVersion || 'keine') : '–'],
    ['Empfangene Frames', String(camera.frameCount)],
    ['Letzter Frame vor', age == null || !camera.stream ? '–' : `${age} ms`],
    ['Wake-Lock unterstützt', 'wakeLock' in navigator ? 'ja' : 'nein'],
    ['User-Agent', navigator.userAgent]
  ];
}

export function diagnosticsText(rows) {
  return rows.map(([k, v]) => `${k}: ${v}`).join('\n');
}
