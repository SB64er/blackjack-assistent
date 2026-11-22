// Verfolgt die Karten EINES Kartenbereichs über mehrere Bilder einer Runde.
// - Eine Karte gilt erst als bestätigt, wenn sie in mehreren Auswertungen an
//   derselben Stelle erkannt wurde (mehrfache Prüfung).
// - Bereits bestätigte Karten werden nie doppelt gezählt: Eine erneute Erkennung
//   an (fast) derselben Stelle oder eine verschobene Karte desselben Werts wird
//   der vorhandenen Karte zugeordnet.
// - Bestätigte Karten bleiben bis zum Rundenende erhalten, auch wenn sie kurz
//   verdeckt sind (z. B. Hand über dem Tisch).
// Reine Logik (ohne DOM) -> testbar.
import { valueClass } from './hand.js';

const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Überlappung zweier Rechtecke relativ zum kleineren (0–1). */
export function boxOverlap(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.max(1e-9, Math.min(a.w * a.h, b.w * b.h));
}

export class CardTracker {
  /**
   * @param {{ confirmFrames?: number, confirmFor?: (rank) => number, near?: number }} opts
   *   confirmFrames: so oft muss eine Karte gesehen werden (Standard 2 stabile Auswertungen)
   *   confirmFor: optional pro Kartenwert (z. B. mehr Prüfungen für oft verwechselte Werte)
   *   near: Abstand (relativ zum Bild), bis zu dem eine Erkennung als dieselbe Karte gilt
   */
  constructor({ confirmFrames = 2, confirmFor = null, near = 0.06, moveRadius = 0.4 } = {}) {
    this.moveRadius = moveRadius;
    this.confirmFrames = confirmFrames;
    this.confirmFor = confirmFor;
    this.near = near;
    this.cards = [];   // { id, rank, cls, box, seen, missed, confirmed, firstAt, lastAt, score, minScore }
    this._seq = 0;
  }

  _needed(rank) {
    const extra = this.confirmFor ? this.confirmFor(rank) : 0;
    return Math.max(1, this.confirmFrames + (extra || 0));
  }

  _dist(a, b) {
    const ca = center(a);
    const cb = center(b);
    return Math.hypot(ca.x - cb.x, ca.y - cb.y);
  }

  /**
   * Eine (stabile) Auswertung einspeisen.
   * @param {Array<{rank, score?, box?}>} detections
   * @returns {Array} neu bestätigte Karten
   */
  update(detections, now = Date.now()) {
    const list = (detections || []).filter((d) => d && d.rank && d.confident !== false);
    const used = new Set();
    const matched = new Set();
    const tol = (d) => Math.max(this.near, d.box ? d.box.h * 4 : 0);

    // 1) Gleiche Wertklasse in der Nähe -> dieselbe Karte (auch wenn leicht verschoben).
    const pairs = [];
    list.forEach((d, i) => {
      this.cards.forEach((c, j) => {
        if (c.cls !== valueClass(d.rank)) return;
        const dist = d.box && c.box ? this._dist(d.box, c.box) : 0;
        if (dist <= tol(d)) pairs.push({ i, j, dist });
      });
    });
    pairs.sort((a, b) => a.dist - b.dist);
    for (const p of pairs) {
      if (used.has(p.i) || matched.has(p.j)) continue;
      used.add(p.i); matched.add(p.j);
      this._hit(this.cards[p.j], list[p.i], now);
    }

    // 2) Übrige Erkennungen: verschobene bestätigte Karte desselben Werts,
    //    die in diesem Bild fehlt? Dann ist es dieselbe Karte (Bewegung).
    //    Ab 0.7.0: nur innerhalb eines Bewegungsradius und nicht, wenn die neue
    //    Erkennung eine andere sichtbare Karte überlappt (überlappende Karten:
    //    eine neue Karte desselben Werts darf nicht als "bewegte" alte Karte gelten).
    const matchedBoxes = () => [...matched].map((k) => this.cards[k] && this.cards[k].box).filter(Boolean);
    list.forEach((d, i) => {
      if (used.has(i)) return;
      if (d.box && matchedBoxes().some((b) => boxOverlap(b, d.box) > 0.15)) return;
      const j = this.cards.findIndex((c, k) => !matched.has(k) && c.confirmed && c.cls === valueClass(d.rank)
        && (!d.box || !c.box || this._dist(d.box, c.box) <= this.moveRadius));
      if (j >= 0) {
        used.add(i); matched.add(j);
        this._hit(this.cards[j], d, now, true);
      }
    });

    // 3) Verbleibende Erkennungen sind neue Kandidaten.
    list.forEach((d, i) => {
      if (used.has(i)) return;
      const c = {
        id: ++this._seq, rank: d.rank, cls: valueClass(d.rank), box: d.box ? { ...d.box } : null,
        seen: 0, missed: 0, confirmed: false, firstAt: now, lastAt: now, score: d.score ?? null, minScore: d.score ?? null, moves: 0
      };
      this.cards.push(c);
      matched.add(this.cards.length - 1);
      this._hit(c, d, now);
    });

    // 4) Nicht gesehene Kandidaten verwerfen; bestätigte Karten bleiben.
    this.cards.forEach((c, k) => { if (!matched.has(k)) c.missed += 1; });
    this.cards = this.cards.filter((c) => c.confirmed || c.missed === 0);

    // 5) Neu bestätigte Karten melden (in Reihenfolge ihres ersten Auftretens).
    const fresh = [];
    for (const c of this.cards) {
      if (!c.confirmed && c.seen >= this._needed(c.rank)) {
        c.confirmed = true;
        c.confirmedAt = now;
        fresh.push(c);
      }
    }
    return fresh;
  }

  _hit(c, d, now, moved = false) {
    c.seen += 1;
    c.missed = 0;
    c.lastAt = now;
    if (moved) c.moves += 1;
    if (d.box) c.box = { ...d.box };
    // Genauerer Rang derselben Wertklasse (z. B. K statt 10) übernehmen, solange unbestätigt.
    if (!c.confirmed && d.rank !== c.rank && valueClass(d.rank) === c.cls) c.rank = d.rank;
    if (d.score != null) {
      c.score = d.score;
      c.minScore = c.minScore == null ? d.score : Math.min(c.minScore, d.score);
    }
  }

  /** Bestätigte Karten in der Reihenfolge, in der sie aufgetaucht sind. */
  confirmed() {
    return this.cards.filter((c) => c.confirmed).sort((a, b) => a.confirmedAt - b.confirmedAt || a.id - b.id);
  }

  /** Noch nicht bestätigte Kandidaten (für "unsicher"-Anzeige). */
  pending() {
    return this.cards.filter((c) => !c.confirmed);
  }

  /** Eine bestätigte Karte herausnehmen (z. B. beim Split in die zweite Hand). */
  take(cls) {
    const list = this.confirmed();
    const c = [...list].reverse().find((x) => x.cls === cls);
    if (!c) return null;
    this.cards = this.cards.filter((x) => x !== c);
    return c;
  }
}

/** Karte für Anzeige/Archiv ohne interne Felder. */
export function publicCard(c) {
  return { rank: c.rank, confident: true, score: c.score, minScore: c.minScore, seen: c.seen, at: c.confirmedAt ?? c.firstAt };
}
