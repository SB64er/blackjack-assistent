// Kartenerkennung im laufenden Betrieb.
// Liest mehrmals pro Sekunde NUR die kalibrierten Bereiche aus dem Kamerabild
// (im Arbeitsspeicher, nichts wird gespeichert oder übertragen),
// wertet sie aus und meldet erkannte Karten, neue Runden und gezogene Karten.
import { Emitter } from '../core/events.js';
import { CameraState } from '../camera/camera-service.js';
import { analyzeRegion } from './analyzer.js';
import { RoundTracker } from './round-tracker.js';

const MAX_REGION_SIDE = 900;

export const RecognitionReason = Object.freeze({
  CAMERA: 'camera',
  CALIBRATION: 'calibration',
  EDITING: 'editing',
  ORIENTATION: 'orientation',
  TEMPLATES: 'templates'
});

export class RecognitionService extends Emitter {
  constructor({ camera, calibration, settings, templates }) {
    super();
    this.camera = camera;
    this.calibration = calibration;
    this.settings = settings;
    this.templates = templates;
    this.tracker = new RoundTracker({ auto: settings.get('roundMode') === 'automatisch' });
    this.latest = null;     // letzte Rohauswertung (für Anzeige der Kästchen)
    this.state = null;      // geglättetes Ergebnis
    this.lastEvent = null;
    this.tickMs = 0;
    this._timer = null;
    this._canvases = new Map();

    const re = () => this._evaluate();
    camera.on('state', re);
    camera.on('dimensions', re);
    calibration.on('change', re);
    templates.on('change', () => { this.tracker.reset(); this._evaluate(); });
    settings.on('change', ({ path }) => {
      if (path === 'roundMode') this.tracker.auto = settings.get('roundMode') === 'automatisch';
      if (path === 'recognition.fps') this._evaluate();
    });
    document.addEventListener('visibilitychange', re);
  }

  // Warum läuft die Erkennung (noch) nicht?
  blocker() {
    if (this.camera.state !== CameraState.ACTIVE) return RecognitionReason.CAMERA;
    if (!this.calibration.saved) return RecognitionReason.CALIBRATION;
    if (this.calibration.editing) return RecognitionReason.EDITING;
    if (!this.calibration.compatibility(this.camera.dimensions()).ok) return RecognitionReason.ORIENTATION;
    if (!this.templates.ready) return RecognitionReason.TEMPLATES;
    return null;
  }

  // Bildauswertung läuft auch ohne Vorlagen (für das Anlernen).
  get scanning() {
    return !!this._timer;
  }

  _canScan() {
    const b = this.blocker();
    return !document.hidden && (b === null || b === RecognitionReason.TEMPLATES);
  }

  _evaluate() {
    const should = this._canScan();
    if (should && !this._timer) {
      this._timer = setTimeout(() => this._tick(), 50);
    } else if (!should && this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
      this.latest = null;
    }
    this.emit('status', this.blocker());
  }

  newHand() {
    const ev = this.tracker.newHand();
    this.state = { ...(this.state || {}), round: this.tracker.round, result: null, stable: false, uncertain: false, empty: true };
    this.lastEvent = { ...ev, at: Date.now() };
    this.emit('event', this.lastEvent);
    this.emit('update', this.state);
  }

  _schedule() {
    const fps = this.settings.get('recognition.fps') || 4;
    this._timer = setTimeout(() => this._tick(), Math.max(80, 1000 / fps));
  }

  _tick() {
    this._timer = null;
    if (!this._canScan()) { this._evaluate(); return; }
    const t0 = performance.now();
    try {
      this._analyzeFrame();
    } catch (err) {
      console.warn('[erkennung] Fehler', err);
    }
    this.tickMs = Math.round(performance.now() - t0);
    this._schedule();
  }

  _grab(id, rect, dims) {
    const sx = Math.round(rect.x * dims.width);
    const sy = Math.round(rect.y * dims.height);
    const sw = Math.max(1, Math.round(rect.w * dims.width));
    const sh = Math.max(1, Math.round(rect.h * dims.height));
    const scale = Math.min(1, MAX_REGION_SIDE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    let c = this._canvases.get(id);
    if (!c) {
      const canvas = document.createElement('canvas');
      c = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
      this._canvases.set(id, c);
    }
    if (c.canvas.width !== w || c.canvas.height !== h) { c.canvas.width = w; c.canvas.height = h; }
    c.ctx.drawImage(this.camera.video, sx, sy, sw, sh, 0, 0, w, h);
    const img = c.ctx.getImageData(0, 0, w, h);
    return { rgba: img.data, w, h, map: { sx, sy, scale, frameW: dims.width, frameH: dims.height } };
  }

  _analyzeFrame() {
    const dims = this.camera.dimensions();
    const cal = this.calibration.saved;
    if (!dims || !cal) return;
    const templates = this.templates.items;
    const ids = ['dealerUp', 'dealerHole', 'player'];
    if (cal.splitEnabled) ids.push('split');

    const regions = {};
    for (const id of ids) {
      const g = this._grab(id, cal.regions[id], dims);
      regions[id] = analyzeRegion(g.rgba, g.w, g.h, g.map, templates);
    }
    this.latest = { regions, at: Date.now() };

    if (!this.templates.ready) {
      this.emit('scan', this.latest);
      return;
    }

    const first = (r) => (r && r.cards.length ? [...r.cards].sort((a, b) => b.score - a.score)[0] : null);
    const raw = {
      dealerUp: first(regions.dealerUp),
      dealerHole: first(regions.dealerHole),
      player: regions.player.cards,
      split: regions.split ? regions.split.cards : [],
      unsure: Object.values(regions).some((r) => r.unsure),
      cardFaceWithoutRank: (regions.dealerUp.whiteRatio > 0.25 && regions.dealerUp.cards.length === 0) ||
        (regions.player.whiteRatio > 0.06 && regions.player.cards.length === 0)
    };
    const { state, events } = this.tracker.push(raw);
    this.state = state;
    for (const ev of events) {
      this.lastEvent = { ...ev, at: Date.now() };
      this.emit('event', this.lastEvent);
    }
    this.emit('scan', this.latest);
    this.emit('update', state);
  }
}
