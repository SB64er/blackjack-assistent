// Speichern / Laden / Zurücksetzen der Kalibrierung (lokal auf dem Gerät).
import { load, save, remove } from '../core/store.js';
import { isValidRect, clampRect, orientationOf, aspectOf, aspectMatches } from './geometry.js';

const KEY = 'calibration';
export const CALIBRATION_VERSION = 1;

export const REGION_DEFS = [
  { id: 'dealerUp',   group: 'A', short: 'A1', label: 'Dealer – offene Karte',   color: '#60A5FA', optional: false },
  { id: 'dealerHole', group: 'A', short: 'A2', label: 'Dealer – verdeckte Karte', color: '#A5C8FB', optional: false },
  { id: 'player',     group: 'B', short: 'B',  label: 'Spieler – deine Karten',   color: '#34D399', optional: false },
  { id: 'split',      group: 'C', short: 'C',  label: 'Split – zweite Hand',      color: '#F472B6', optional: true }
];

export const DEFAULT_REGIONS = Object.freeze({
  dealerUp:   { x: 0.38, y: 0.12, w: 0.10, h: 0.22 },
  dealerHole: { x: 0.50, y: 0.12, w: 0.10, h: 0.22 },
  player:     { x: 0.28, y: 0.56, w: 0.34, h: 0.28 },
  split:      { x: 0.64, y: 0.56, w: 0.30, h: 0.28 }
});

export function cloneRegions(regions) {
  const out = {};
  for (const def of REGION_DEFS) {
    const r = regions && regions[def.id];
    out[def.id] = r ? { x: r.x, y: r.y, w: r.w, h: r.h } : { ...DEFAULT_REGIONS[def.id] };
  }
  return out;
}

function isValidCalibration(c) {
  if (!c || c.version !== CALIBRATION_VERSION) return false;
  if (!c.frame || !(c.frame.width > 0) || !(c.frame.height > 0)) return false;
  if (!c.regions) return false;
  return REGION_DEFS.every((d) => d.optional && !c.regions[d.id] ? true : isValidRect(c.regions[d.id]));
}

export function loadCalibration() {
  const c = load(KEY, null);
  return isValidCalibration(c) ? c : null;
}

export function saveCalibration({ regions, splitEnabled, frame }) {
  if (!frame || !frame.width || !frame.height) {
    throw new Error('Ohne Kamerabild kann die Kalibrierung nicht gespeichert werden.');
  }
  const cleaned = {};
  for (const def of REGION_DEFS) cleaned[def.id] = clampRect(regions[def.id]);
  const data = {
    version: CALIBRATION_VERSION,
    savedAt: new Date().toISOString(),
    frame: {
      width: frame.width,
      height: frame.height,
      aspect: aspectOf(frame.width, frame.height),
      orientation: orientationOf(frame.width, frame.height)
    },
    regions: cleaned,
    splitEnabled: !!splitEnabled
  };
  if (!save(KEY, data)) {
    throw new Error('Speichern fehlgeschlagen (lokaler Speicher nicht verfügbar).');
  }
  return data;
}

export function resetCalibration() {
  remove(KEY);
}

// Passt das aktuelle Kamerabild zur gespeicherten Kalibrierung?
// Bei Drehung oder anderem Bildausschnitt wird die Kalibrierung NICHT
// verändert, sondern nur als "passt nicht" gemeldet.
export function checkCompatibility(calibration, dims) {
  if (!calibration || !dims) return { ok: true, reason: null };
  const orientation = orientationOf(dims.width, dims.height);
  if (orientation !== calibration.frame.orientation) {
    return { ok: false, reason: 'orientation', expected: calibration.frame.orientation, actual: orientation };
  }
  if (!aspectMatches(aspectOf(dims.width, dims.height), calibration.frame.aspect)) {
    return { ok: false, reason: 'aspect', expected: calibration.frame.aspect, actual: aspectOf(dims.width, dims.height) };
  }
  return { ok: true, reason: null };
}
