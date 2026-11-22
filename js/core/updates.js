// Service Worker & Updates (Phase 4).
// - Registriert sw.js (ohne HTTP-Cache für sw.js selbst).
// - Sucht beim Start, beim Zurückkehren in die App und alle 30 Minuten nach Updates.
// - Eine neue Version wird erst nach Tipp auf "Aktualisieren" aktiv –
//   so wird nie mitten in einer Runde neu geladen.
import { Emitter } from './events.js';

const CHECK_INTERVAL_MS = 30 * 60 * 1000;

class Updates extends Emitter {
  constructor() {
    super();
    this.supported = 'serviceWorker' in navigator && window.isSecureContext;
    this.reg = null;
    this.available = false;     // neue Version wartet
    this.offlineVersion = null; // Version der offline gespeicherten Dateien
    this.checking = false;
    this.lastCheck = null;
    this._reloading = false;
    this._userRequested = false;
    this._lastCheckAt = 0;
  }

  async register() {
    if (!this.supported) return;
    try {
      this.reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    } catch (err) {
      console.warn('Service Worker nicht registriert', err);
      return;
    }
    const reg = this.reg;
    if (reg.waiting && navigator.serviceWorker.controller) this._setAvailable();
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        // Nur wenn schon eine Version läuft, ist es ein Update (sonst Erstinstallation).
        if (sw.state === 'installed' && navigator.serviceWorker.controller) this._setAvailable();
        if (sw.state === 'activated') this._queryVersion();
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Nur neu laden, wenn der Benutzer es wollte (bei der Erstinstallation
      // übernimmt der Service Worker ebenfalls – dann nicht neu laden).
      if (!this._userRequested || this._reloading) return;
      this._reloading = true;
      window.location.reload();
    });
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'VERSION') {
        this.offlineVersion = e.data.version;
        this.emit('change');
      }
    });
    this._queryVersion();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - this._lastCheckAt > 60 * 1000) this.check();
    });
    setInterval(() => { if (!document.hidden) this.check(); }, CHECK_INTERVAL_MS);
  }

  _queryVersion() {
    const c = navigator.serviceWorker.controller;
    if (c) c.postMessage({ type: 'GET_VERSION' });
    else if (this.reg && this.reg.active) this.reg.active.postMessage({ type: 'GET_VERSION' });
  }

  _setAvailable() {
    if (this.available) return;
    this.available = true;
    this.emit('change');
  }

  async check() {
    if (!this.reg || this.checking) return;
    this.checking = true;
    this._lastCheckAt = Date.now();
    this.emit('change');
    try {
      await this.reg.update();
    } catch { /* offline */ }
    this.checking = false;
    this.lastCheck = new Date();
    if (this.reg.waiting && navigator.serviceWorker.controller) this._setAvailable();
    this.emit('change');
  }

  // Wartende Version aktivieren und neu laden.
  apply() {
    const waiting = this.reg && this.reg.waiting;
    this._userRequested = true;
    if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
    else window.location.reload();
  }
}

export const updates = new Updates();
