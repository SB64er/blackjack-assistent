// Lokale Bildverarbeitung (ohne DOM, ohne Server, ohne KI-Modell).
//
// Ablauf pro Kalibrierungsbereich:
//  1. Graustufen + "Weiss" (hell UND farbarm = Kartenfläche) bestimmen.
//  2. "Tinte" (nicht weiss) in zusammenhängende Flächen zerlegen.
//  3. Zeichen-Kandidaten: kleine Flächen, die rundum von Kartenweiss umgeben sind
//     (Rangzeichen in der Kartenecke, Farbsymbole, …). Tisch/Hintergrund fällt weg.
//  4. "1" + "0" werden zu "10" zusammengefasst.
//  5. Jeder Kandidat wird auf 20×28 Punkte normiert und mit angelernten
//     Vorlagen verglichen.

export const GLYPH_W = 20;
export const GLYPH_H = 28;
export const GLYPH_SIZE = GLYPH_W * GLYPH_H;

// --- 1. Graustufen & Weissmaske --------------------------------------------

export function analyzePixels(rgba, w, h) {
  const n = w * h;
  const gray = new Uint8Array(n);
  const sat = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    gray[i] = (r * 77 + g * 150 + b * 29) >> 8;
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    sat[i] = mx - mn;
  }
  return { gray, sat };
}

export function otsu(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

// Weiss = hell und farbarm. Liefert Uint8Array (1 = weiss).
// Ab 0.7.0: Bei schwachem Licht (hellste Bildteile deutlich unter normalem Kartenweiss)
// wird die Mindesthelligkeit für "Weiss" proportional gesenkt. Bei normalem Licht
// bleibt alles wie bisher (keine Änderung der bewährten Erkennung).
export function brightLevel(gray, q = 0.97) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const target = gray.length * q;
  let acc = 0;
  for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc >= target) return t; }
  return 255;
}

export function whiteMask(gray, sat, opts = {}) {
  let minT = opts.minWhite ?? 120;
  if (opts.adaptive !== false && opts.minWhite == null && gray.length) {
    const bright = brightLevel(gray);
    if (bright < 200) minT = Math.max(60, Math.round(120 * bright / 200));
  }
  const maxSat = opts.maxSat ?? 75;
  let t = otsu(gray);
  t = Math.max(minT, Math.min(t, 215));
  const m = new Uint8Array(gray.length);
  let count = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] > t && sat[i] < maxSat) { m[i] = 1; count++; }
  }
  return { mask: m, threshold: t, ratio: count / gray.length };
}

// --- 2. Zusammenhängende Flächen (8er-Nachbarschaft) -----------------------

export function components(ink, w, h, maxComponents = 6000) {
  const labels = new Int32Array(w * h);
  const out = [];
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || labels[start]) continue;
    if (next > maxComponents) break;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = next;
    let minX = w, minY = h, maxX = 0, maxY = 0, area = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (ink[q] && !labels[q]) { labels[q] = next; stack[sp++] = q; }
        }
      }
    }
    out.push({ id: next, minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1, area });
    next++;
  }
  return { labels, list: out };
}

// Anteil weisser Pixel in einem Ring um die Box.
function ringWhite(white, w, h, c, pad) {
  const x0 = Math.max(0, c.minX - pad), x1 = Math.min(w - 1, c.maxX + pad);
  const y0 = Math.max(0, c.minY - pad), y1 = Math.min(h - 1, c.maxY + pad);
  let tot = 0, wh = 0;
  for (let y = y0; y <= y1; y++) {
    const inner = y >= c.minY && y <= c.maxY;
    for (let x = x0; x <= x1; x++) {
      if (inner && x >= c.minX && x <= c.maxX) continue;
      tot++;
      wh += white[y * w + x];
    }
  }
  return tot ? wh / tot : 0;
}

// --- 3./4. Zeichen-Kandidaten ------------------------------------------------

export function glyphCandidates(white, w, h, opts = {}) {
  const ink = new Uint8Array(white.length);
  for (let i = 0; i < white.length; i++) ink[i] = white[i] ? 0 : 1;
  const { labels, list } = components(ink, w, h);
  const minH = Math.max(opts.minH ?? 7, 3);
  const maxH = Math.max(minH + 1, Math.round(h * (opts.maxHFrac ?? 0.6)));

  const glyphs = [];
  for (const c of list) {
    if (c.h < minH || c.h > maxH) continue;
    if (c.w < 2 || c.w > c.h * 1.6) continue;
    if (c.minX === 0 || c.minY === 0 || c.maxX === w - 1 || c.maxY === h - 1) continue;
    const fill = c.area / (c.w * c.h);
    if (fill < 0.12) continue;
    const pad = Math.max(2, Math.round(c.h * 0.25));
    if (ringWhite(white, w, h, c, pad) < 0.55) continue;
    glyphs.push(c);
  }

  // "1" + "0" -> "10": zwei gleich hohe Zeichen direkt nebeneinander.
  // (Einzelne Ränge bestehen aus einem Zeichen; Farbsymbole in der
  // Kartenmitte stehen weiter auseinander.)
  const used = new Set();
  const groups = [];
  const byX = [...glyphs].sort((a, b) => a.minX - b.minX);
  for (const a of byX) {
    if (used.has(a.id)) continue;
    let best = null;
    for (const b of byX) {
      if (b === a || used.has(b.id) || b.minX <= a.minX) continue;
      const gap = b.minX - a.maxX;
      if (gap < -1 || gap > a.h * 0.35) continue;
      const overlap = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + 1;
      if (overlap < 0.75 * Math.max(a.h, b.h)) continue;
      const hr = Math.min(a.h, b.h) / Math.max(a.h, b.h);
      if (hr < 0.8) continue;
      if ((a.w + b.w + gap) / Math.max(a.h, b.h) > 1.9) continue;
      if (!best || gap < best.gap) best = { b, gap };
    }
    if (best) {
      used.add(a.id); used.add(best.b.id);
      groups.push({ parts: [a, best.b], minX: a.minX, minY: Math.min(a.minY, best.b.minY), maxX: best.b.maxX, maxY: Math.max(a.maxY, best.b.maxY) });
    }
  }
  const cands = [];
  for (const g of groups) cands.push(box(g, g.parts.map((p) => p.id), true));
  for (const c of glyphs) if (!used.has(c.id)) cands.push(box(c, [c.id], false));

  // Lage relativ zu anderen Zeichen: Farbsymbol unterhalb = aufrechte Ecke,
  // nur oberhalb = um 180° gedrehte Ecke (unten rechts auf der Karte).
  // suitRatio = Höhe des Symbols direkt darunter / eigene Höhe. In einer
  // Kartenecke ist das Farbsymbol kleiner als der Rang; übereinander
  // stehende Symbole in der Kartenmitte sind gleich gross.
  for (const c of cands) {
    let below = null, above = false;
    for (const o of glyphs) {
      if (c.ids.includes(o.id)) continue;
      const ov = Math.min(c.maxX, o.maxX) - Math.max(c.minX, o.minX) + 1;
      if (ov < 0.3 * Math.min(c.w, o.w)) continue;
      if (o.minY > c.maxY && o.minY - c.maxY <= c.h * 0.8 && o.h <= c.h * 1.6) {
        const gap = o.minY - c.maxY;
        if (!below || gap < below.gap) below = { gap, o };
      }
      if (o.maxY < c.minY && c.minY - o.maxY <= c.h * 0.8 && o.h <= c.h * 1.6) above = true;
    }
    c.suitBelow = !!below;
    c.suitRatio = below ? below.o.h / c.h : null;
    c.rotated = !below && above;
    c.bits = normalizeGlyph(labels, w, c);
    c.aspect = c.w / c.h;
  }
  return cands;
}

function box(c, ids, merged) {
  return { ids, merged, minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1 };
}

// --- 5. Normieren & Vergleichen ----------------------------------------------

// Box auf GLYPH_W × GLYPH_H Punkte abtasten (nur Pixel der eigenen Flächen).
export function normalizeGlyph(labels, w, c) {
  const ids = new Set(c.ids);
  const out = new Uint8Array(GLYPH_SIZE);
  const sx = c.w / GLYPH_W;
  const sy = c.h / GLYPH_H;
  for (let ty = 0; ty < GLYPH_H; ty++) {
    for (let tx = 0; tx < GLYPH_W; tx++) {
      let hit = 0;
      for (let k = 0; k < 3; k++) {
        for (let l = 0; l < 3; l++) {
          const x = Math.min(c.maxX, Math.floor(c.minX + (tx + (l + 0.5) / 3) * sx));
          const y = Math.min(c.maxY, Math.floor(c.minY + (ty + (k + 0.5) / 3) * sy));
          if (ids.has(labels[y * w + x])) hit++;
        }
      }
      out[ty * GLYPH_W + tx] = hit >= 4 ? 1 : 0;
    }
  }
  return out;
}

function dilate(bits) {
  const out = new Uint8Array(GLYPH_SIZE);
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < GLYPH_W; x++) {
      if (!bits[y * GLYPH_W + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= GLYPH_H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < GLYPH_W) out[yy * GLYPH_W + xx] = 1;
        }
      }
    }
  }
  return out;
}

// Ähnlichkeit 0–1: Mittel aus Jaccard und toleranter F-Wert (±1 Punkt).
export function similarity(a, b, aDil = dilate(a), bDil = dilate(b)) {
  let inter = 0, union = 0, ca = 0, cb = 0, aInB = 0, bInA = 0;
  for (let i = 0; i < GLYPH_SIZE; i++) {
    const x = a[i], y = b[i];
    if (x) ca++;
    if (y) cb++;
    if (x && y) inter++;
    if (x || y) union++;
    if (x && bDil[i]) aInB++;
    if (y && aDil[i]) bInA++;
  }
  if (!ca || !cb) return 0;
  const jac = inter / union;
  const p = aInB / ca;
  const r = bInA / cb;
  const f = p + r ? (2 * p * r) / (p + r) : 0;
  return 0.5 * jac + 0.5 * f;
}

export { dilate };

// --- Speichern der Muster ---------------------------------------------------

export function packBits(bits) {
  const bytes = new Uint8Array(Math.ceil(GLYPH_SIZE / 8));
  for (let i = 0; i < GLYPH_SIZE; i++) if (bits[i]) bytes[i >> 3] |= 1 << (i & 7);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unpackBits(str) {
  const s = atob(str);
  const out = new Uint8Array(GLYPH_SIZE);
  for (let i = 0; i < GLYPH_SIZE; i++) out[i] = (s.charCodeAt(i >> 3) >> (i & 7)) & 1;
  return out;
}
