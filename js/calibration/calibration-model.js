// Zustand der Kalibrierung für die ganze App:
//   saved   – gespeicherte Kalibrierung (oder null)
//   draft   – Bereiche, die gerade bearbeitet werden
//   editing – Kalibrierungsmodus aktiv?
// Ereignisse: 'change' (alles), 'region-edited' ({ id }), 'saved', 'reset'
import { Emitter } from '../core/events.js';
import {
  loadCalibration, saveCalibration, resetCalibration, checkCompatibility,
  cloneRegions, DEFAULT_REGIONS
} from './calibration-store.js';
import { rectsEqual } from './geometry.js';

export class CalibrationModel extends Emitter {
  constructor() {
    super();
    this.saved = loadCalibration();
    this.loadedAtStartup = this.saved;   // für den Testmodus (Schritt 7)
    this.editing = false;
    this.draft = cloneRegions(this.saved ? this.saved.regions : DEFAULT_REGIONS);
    this.splitEnabled = this.saved ? this.saved.splitEnabled : false;
  }

  get hasSaved() {
    return !!this.saved;
  }

  get dirty() {
    if (!this.editing) return false;
    if (!this.saved) return true;
    if (this.splitEnabled !== this.saved.splitEnabled) return true;
    return Object.keys(this.draft).some((id) => !rectsEqual(this.draft[id], this.saved.regions[id]));
  }

  compatibility(dims) {
    return checkCompatibility(this.saved, dims);
  }

  beginEdit() {
    this.draft = cloneRegions(this.saved ? this.saved.regions : DEFAULT_REGIONS);
    this.splitEnabled = this.saved ? this.saved.splitEnabled : false;
    this.editing = true;
    this.emit('change');
  }

  updateRegion(id, rect) {
    if (!this.editing) return;
    this.draft[id] = { ...rect };
    this.emit('region-edited', { id });
    this.emit('change');
  }

  setSplitEnabled(on) {
    this.splitEnabled = !!on;
    this.emit('change');
  }

  cancelEdit() {
    this.editing = false;
    this.draft = cloneRegions(this.saved ? this.saved.regions : DEFAULT_REGIONS);
    this.splitEnabled = this.saved ? this.saved.splitEnabled : false;
    this.emit('change');
  }

  save(frame) {
    this.saved = saveCalibration({ regions: this.draft, splitEnabled: this.splitEnabled, frame });
    this.draft = cloneRegions(this.saved.regions);
    this.editing = false;
    this.emit('saved', this.saved);
    this.emit('change');
    return this.saved;
  }

  reset() {
    resetCalibration();
    this.saved = null;
    this.editing = false;
    this.draft = cloneRegions(DEFAULT_REGIONS);
    this.splitEnabled = false;
    this.emit('reset');
    this.emit('change');
  }

  // Bereiche, die gerade angezeigt werden sollen.
  visibleRegions() {
    const src = this.editing ? this.draft : (this.saved ? this.saved.regions : null);
    if (!src) return null;
    const split = this.editing ? this.splitEnabled : this.saved.splitEnabled;
    const out = { ...src };
    if (!split) delete out.split;
    return out;
  }
}
