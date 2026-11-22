// Anzeige-Hilfen (Phase 4): Home-Bildschirm-App, Vollbild, Geräteklassen.
// Setzt CSS-Klassen auf <html>, damit das Layout gezielt angepasst werden kann:
//   is-standalone  – als Home-Bildschirm-App gestartet
//   is-ipad        – iPad (auch "Desktop-Website"-Modus)
//   is-fullscreen  – Vollbild über die Fullscreen-API (nur Browser-Tab)
import { Emitter } from './events.js';
import { isStandalone, isIPad } from '../camera/camera-service.js';

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

class Display extends Emitter {
  constructor() {
    super();
    this.standalone = isStandalone();
    this.ipad = isIPad();
    this.ios = this.ipad || /iPhone|iPod/.test(navigator.userAgent || '');
    const root = document.documentElement;
    root.classList.toggle('is-standalone', this.standalone);
    root.classList.toggle('is-ipad', this.ipad);
    const onFs = () => {
      root.classList.toggle('is-fullscreen', this.fullscreen);
      this.emit('change');
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    // Wechsel Browser <-> Home-Bildschirm kommt praktisch nicht vor, aber
    // display-mode kann sich z. B. bei Stage Manager ändern.
    try {
      window.matchMedia('(display-mode: standalone)').addEventListener('change', () => {
        this.standalone = isStandalone();
        root.classList.toggle('is-standalone', this.standalone);
        this.emit('change');
      });
    } catch { /* ältere Browser */ }
  }

  // Vollbild per API: auf dem iPad in Safari möglich, auf dem iPhone nicht.
  // In der Home-Bildschirm-App nicht nötig (läuft schon ohne Browserleisten).
  get fullscreenSupported() {
    if (this.standalone) return false;
    const el = document.documentElement;
    const enabled = document.fullscreenEnabled || document.webkitFullscreenEnabled;
    return !!(enabled && (el.requestFullscreen || el.webkitRequestFullscreen));
  }

  get fullscreen() {
    return !!fsElement();
  }

  // Im Tipp aufrufen.
  toggleFullscreen() {
    try {
      if (this.fullscreen) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) { const p = exit.call(document); if (p && p.catch) p.catch(() => {}); }
      } else {
        const el = document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (req) { const p = req.call(el, { navigationUI: 'hide' }); if (p && p.catch) p.catch(() => {}); }
      }
    } catch { /* nicht unterstützt */ }
  }

  get modeLabel() {
    if (this.standalone) return 'Home-Bildschirm-App';
    return this.fullscreen ? 'Browser (Vollbild)' : 'Browser-Tab';
  }
}

export const display = new Display();
