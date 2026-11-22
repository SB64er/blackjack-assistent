// Speichern / Laden / Zurücksetzen der Kalibrierung (lokal auf dem Gerät).
import { load, save, remove } from '../core/store.js';
import { isValidRect, clampRect, orientationOf, aspectOf, aspectMatches } from './geometry.js';

const KEY = 'calibration';
const BACKUP_V1_KEY = 'calibration.v1backup';
// Version 2 (ab App 0.6.0): EIN gemeinsames Dealer-Feld statt A1/A2.
export const CALIBRATION_VERSION = 2;

export const REGION_DEFS = [
  { id: 'dealer', group: 'A', short: 'A', label: 'Dealer – alle Dealerkarten', color: '#60A5FA', optional: false },
  { id: 'player', group: 'B', short: 'B', label: 'Spieler – deine Karten',     color: '#34D399', optional: false },
  { id: 'split',  group: 'C', short: 'C', label: 'Split – zweite Hand',        color: '#F472B6', optional: true }
];

export const DEFAULT_REGIONS = Object.freeze({
  dealer: { x: 0.34, y: 0.10, w: 0.32, h: 0.26 },
  player: { x: 0.28, y: 0.56, w: 0.34, h: 0.28 },
  split:  { x: 0.64, y: 0.56, w: 0.30, h: 0.28 }
});

/** Umschliessendes Rechteck zweier Bereiche (für die Migration A1 + A2 -> A). */
export function unionRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * Kalibrierung aus Version 1 (zwei Dealer-Felder) in Version 2 übernehmen.
 * Das neue Dealer-Feld umschliesst beide alten Felder; die alten Felder bleiben
 * unter legacy erhalten. Liefert null, wenn die Daten unbrauchbar sind.
 */
export function migrateCalibrationV1(c) {
  if (!c || c.version !== 1 || !c.frame || !c.regions) return null;
  const { dealerUp, dealerHole, player, split } = c.regions;
  if (!isValidRect(dealerUp) || !isValidRect(player)) return null;
  const dealer = clampRect(isValidRect(dealerHole) ? unionRect(dealerUp, dealerHole) : dealerUp);
  const regions = { dealer, player: { ...player } };
  if (isValidRect(split)) regions.split = { ...split };
  return {
    version: CALIBRATION_VERSION,
    savedAt: c.savedAt,
    migratedAt: new Date().toISOString(),
    frame: { ...c.frame },
    regions,
    splitEnabled: !!c.splitEnabled,
    legacy: { version: 1, dealerUp: { ...dealerUp }, dealerHole: dealerHole ? { ...dealerHole } : null }
  };
}

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
  if (c && c.version === 1) {
    const m = migrateCalibrationV1(c);
    if (!m || !isValidCalibration(m)) return null;
    // Sicherung der alten Kalibrierung, dann die neue Struktur speichern.
    if (load(BACKUP_V1_KEY, null) == null) save(BACKUP_V1_KEY, c);
    save(KEY, m);
    return m;
  }
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
  const prev = load(KEY, null);
  if (prev && prev.legacy) data.legacy = prev.legacy;
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
