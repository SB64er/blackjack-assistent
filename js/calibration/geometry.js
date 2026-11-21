// Reine Geometrie-Funktionen (ohne DOM), damit sie einfach testbar sind.
//
// Koordinatensystem der Kalibrierung:
//   x, y, w, h im Bereich 0–1, bezogen auf das ECHTE Kamerabild
//   (videoWidth × videoHeight), nicht auf die Anzeige.
//   -> unabhängig von Bildschirmgrösse, Zoom und Letterbox-Rändern.

export const MIN_SIZE = 0.03;

// Wo liegt das Kamerabild bei object-fit: contain im Container?
export function containRect(containerW, containerH, mediaW, mediaH) {
  if (!containerW || !containerH || !mediaW || !mediaH) return null;
  const scale = Math.min(containerW / mediaW, containerH / mediaH);
  const width = mediaW * scale;
  const height = mediaH * scale;
  return {
    left: (containerW - width) / 2,
    top: (containerH - height) / 2,
    width,
    height,
    scale
  };
}

export function orientationOf(width, height) {
  return width >= height ? 'landscape' : 'portrait';
}

export function aspectOf(width, height) {
  return width / height;
}

export function aspectMatches(a, b, tolerance = 0.03) {
  return Math.abs(a - b) / b <= tolerance;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Rechteck vollständig ins Bild legen und Mindestgrösse sichern.
export function clampRect(r, min = MIN_SIZE) {
  const w = clamp(r.w, min, 1);
  const h = clamp(r.h, min, 1);
  return {
    x: clamp(r.x, 0, 1 - w),
    y: clamp(r.y, 0, 1 - h),
    w,
    h
  };
}

// Verschieben: Grösse bleibt, Position wird ans Bild begrenzt.
export function moveRect(start, dx, dy) {
  return clampRect({ x: start.x + dx, y: start.y + dy, w: start.w, h: start.h });
}

// Grösse ändern über eine Ecke ('nw' | 'ne' | 'sw' | 'se').
// Die gegenüberliegende Ecke bleibt fix.
export function resizeRect(start, corner, dx, dy, min = MIN_SIZE) {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;

  if (corner.includes('w')) left = clamp(left + dx, 0, right - min);
  if (corner.includes('e')) right = clamp(right + dx, left + min, 1);
  if (corner.includes('n')) top = clamp(top + dy, 0, bottom - min);
  if (corner.includes('s')) bottom = clamp(bottom + dy, top + min, 1);

  return { x: left, y: top, w: right - left, h: bottom - top };
}

// Relative Koordinaten -> Pixel im Kamerabild (für die spätere Erkennung).
export function toPixelRect(rel, frameW, frameH) {
  return {
    x: Math.round(rel.x * frameW),
    y: Math.round(rel.y * frameH),
    width: Math.round(rel.w * frameW),
    height: Math.round(rel.h * frameH)
  };
}

export function isValidRect(r) {
  return !!r &&
    [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 &&
    r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001;
}

export function rectsEqual(a, b, eps = 1e-6) {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps &&
    Math.abs(a.w - b.w) < eps && Math.abs(a.h - b.h) < eps;
}
