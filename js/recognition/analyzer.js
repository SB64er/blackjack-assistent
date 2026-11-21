// Auswertung eines Kalibrierungsbereichs: Kandidaten finden, mit Vorlagen
// vergleichen, Karten ableiten. Reine Logik (ohne DOM) -> testbar.
import { analyzePixels, whiteMask, glyphCandidates, similarity, dilate } from './vision.js';
import { valueClass } from '../game/hand.js';

export const THRESHOLDS = Object.freeze({
  accept: 0.80,     // ab hier sicher erkannt
  minimum: 0.66,    // darunter: kein Rangzeichen (z. B. Farbsymbol, Bild)
  margin: 0.06,     // Abstand zur nächstbesten ANDEREN Wertklasse
  scale: 0.45,      // erlaubte Grössenabweichung zur Vorlage (±45 %)
  suitRatio: 0.22   // erlaubte Abweichung des Grössenverhältnisses Rang/Farbsymbol
});

// Passt der Aufbau der Ecke (Farbsymbol darunter) zur Vorlage?
function contextFits(cand, t) {
  if (t.suitRatio == null) return true;
  if (cand.suitRatio == null) return false;
  return Math.abs(cand.suitRatio - t.suitRatio) <= THRESHOLDS.suitRatio;
}

export function matchGlyph(cand, templates) {
  if (!templates.length) return null;
  const candDil = dilate(cand.bits);
  const bestByClass = new Map();
  for (const t of templates) {
    if (t.hRel && cand.hRel && Math.abs(cand.hRel / t.hRel - 1) > THRESHOLDS.scale) continue;
    if (!contextFits(cand, t)) continue;
    let s = similarity(cand.bits, t._bits, candDil, t._dil);
    const ar = Math.min(cand.aspect, t.aspect) / Math.max(cand.aspect, t.aspect);
    if (ar < 0.7) s *= ar;
    const cls = t.rank === 'X' ? 'X' : valueClass(t.rank);
    const cur = bestByClass.get(cls);
    if (!cur || s > cur.score) bestByClass.set(cls, { rank: t.rank, score: s });
  }
  if (!bestByClass.size) return { status: 'none', score: 0 };
  const ranked = [...bestByClass.values()].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1] ? ranked[1].score : 0;
  const margin = best.score - second;
  let status = 'none';
  // Als "kein Kartenwert" angelerntes Zeichen (z. B. Farbsymbol) -> ignorieren.
  if (best.rank === 'X') return { status: 'ignored', rank: 'X', score: best.score, margin };
  if (best.score >= THRESHOLDS.accept && margin >= THRESHOLDS.margin) status = 'ok';
  else if (best.score >= THRESHOLDS.minimum) status = 'unsure';
  return { status, rank: best.rank, score: best.score, margin };
}

/**
 * @param {Uint8ClampedArray} rgba – Pixel des Bereichs
 * @param {number} w,h – Grösse des Ausschnitts
 * @param {{sx,sy,scale,frameW,frameH}} map – Umrechnung in Kamerabild-Koordinaten
 * @param {Array} templates
 */
export function analyzeRegion(rgba, w, h, map, templates) {
  const { gray, sat } = analyzePixels(rgba, w, h);
  const { mask, ratio } = whiteMask(gray, sat);
  // Mindestgrösse eines Zeichens: aus Vorlagen ableiten, sonst grob schätzen.
  let minH = 7;
  if (templates.length) {
    const hs = templates.map((t) => t.hRel * map.frameH * map.scale).filter((x) => x > 0).sort((a, b) => a - b);
    if (hs.length) minH = Math.max(5, Math.floor(hs[0] * (1 - THRESHOLDS.scale)));
  }
  const cands = glyphCandidates(mask, w, h, { minH });

  const out = [];
  for (const c of cands) {
    const fx = map.sx + c.minX / map.scale;
    const fy = map.sy + c.minY / map.scale;
    const fw = c.w / map.scale;
    const fh = c.h / map.scale;
    const cand = {
      x: fx / map.frameW, y: fy / map.frameH, w: fw / map.frameW, h: fh / map.frameH,
      hRel: fh / map.frameH,
      bits: c.bits, aspect: c.aspect, rotated: c.rotated, suitBelow: c.suitBelow, suitRatio: c.suitRatio, merged: c.merged
    };
    cand.match = c.rotated ? { status: 'rotated', score: 0 } : matchGlyph(cand, templates);
    out.push(cand);
  }

  // Doppelte Treffer unterdrücken (überlappende Boxen, z. B. "10" vs. "0").
  const accepted = out.filter((c) => c.match && c.match.status === 'ok')
    .sort((a, b) => (b.merged - a.merged) || (b.match.score - a.match.score));
  const cards = [];
  for (const c of accepted) {
    if (cards.some((k) => overlap(k, c) > 0.3)) continue;
    cards.push(c);
  }
  cards.sort((a, b) => (a.x - b.x) || (a.y - b.y));

  const unsure = out.some((c) => c.match && c.match.status === 'unsure' && !cards.some((k) => overlap(k, c) > 0.3));
  return {
    whiteRatio: ratio,
    candidates: out,
    cards: cards.map((c) => ({ rank: c.match.rank, score: c.match.score, confident: true, box: { x: c.x, y: c.y, w: c.w, h: c.h } })),
    unsure
  };
}

function overlap(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / Math.min(a.w * a.h, b.w * b.h);
}
