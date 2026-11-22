// Glättung über mehrere Bilder + Erkennung von Rundenbeginn und gezogenen Karten.
// Reine Logik (ohne DOM) -> testbar.

const STABLE_FRAMES = 2;        // gleiche Erkennung in N Bildern hintereinander
const UNSTABLE_WARN_MS = 1500;  // so lange unruhig -> "unsicher"
const EMPTY_FRAMES_FOR_NEW_ROUND = 3;
// Ab 0.6.0: Kurz keine Karten sichtbar (z. B. Hand über dem Tisch) beendet die
// Runde NICHT. Erst wenn der Tisch mindestens so lange leer war, gelten die
// nächsten Karten als neue Runde.
const NEW_ROUND_EMPTY_MS = 2500;

// raw.dealer: alle Karten im gemeinsamen Dealer-Feld (ab 0.6.0).
// Alte Form mit dealerUp/dealerHole wird weiterhin verstanden.
export function dealerList(r) {
  if (Array.isArray(r.dealer)) return r.dealer;
  return [r.dealerUp, r.dealerHole].filter(Boolean);
}

export function signatureOf(r) {
  const cards = (list) => list.map((c) => c.rank).join('.');
  return [cards(dealerList(r)), cards(r.player), cards(r.split), r.unsure ? 'U' : ''].join('|');
}

export function isEmptyTable(r) {
  return dealerList(r).length === 0 && r.player.length === 0 && r.split.length === 0 && !r.cardFaceWithoutRank;
}

export class RoundTracker {
  constructor({ auto = true } = {}) {
    this.auto = auto;
    this.reset();
    this.round = 0;
  }

  reset() {
    this.history = [];
    this.stable = null;
    this.lastChangeAt = 0;
    this.emptyStreak = 0;
    this.sawEmpty = true;      // erste Karten nach Start = neue Runde
    this.prevStable = null;
    this._stableAt = null;
    this.emptyAt = null;
    this.lastCards = null;   // letzte stabile Auswertung MIT Karten
  }

  // Manuell "Neue Hand": nächste Karten gehören zu einer neuen Runde.
  newHand(now = Date.now()) {
    this.round += 1;
    this.history = [];
    this.stable = null;
    this.prevStable = null;
    this.sawEmpty = false;
    this.emptyAt = null;
    this.lastCards = null;
    this.lastChangeAt = now;
    return { type: 'round-start', round: this.round, source: 'manual' };
  }

  /**
   * @param raw – Ergebnis eines Bildes {dealerUp, dealerHole, player[], split[], unsure, cardFaceWithoutRank}
   * @returns {{ state, events[] }}
   */
  push(raw, now = Date.now()) {
    const events = [];
    const sig = signatureOf(raw);
    const last = this.history[this.history.length - 1];
    if (!last || last.sig !== sig) this.lastChangeAt = now;
    this.history.push({ sig, raw });
    if (this.history.length > 6) this.history.shift();

    const tail = this.history.slice(-STABLE_FRAMES);
    const isStable = tail.length === STABLE_FRAMES && tail.every((h) => h.sig === sig);

    if (isStable) {
      const prev = this.stable;
      this.stable = raw;
      if (!prev || signatureOf(prev) !== sig) events.push(...this._onStableChange(prev, raw, now));
    }

    if (isStable) this._stableAt = now;
    if (this._stableAt == null) this._stableAt = now;
    const shown = this.stable;
    // Unsicher: stabiles Ergebnis selbst unsicher ODER Bild zu lange unruhig.
    const unstableTooLong = !isStable && (now - this._stableAt) > UNSTABLE_WARN_MS;
    const uncertain = !!(shown && (shown.unsure || shown.cardFaceWithoutRank)) || unstableTooLong;

    return {
      state: {
        round: this.round,
        stable: isStable,
        result: shown,
        uncertain,
        empty: shown ? isEmptyTable(shown) : true
      },
      events
    };
  }

  _onStableChange(prev, cur, now = Date.now()) {
    const events = [];
    const empty = isEmptyTable(cur);
    if (empty) {
      this.emptyStreak += 1;
      if (this.emptyAt == null) this.emptyAt = now;
      events.push({ type: 'table-empty' });
      return events;
    }
    this.emptyStreak = 0;
    // War der Tisch lange genug leer? Sonst geht dieselbe Runde weiter.
    if (this.emptyAt != null) {
      if (now - this.emptyAt >= NEW_ROUND_EMPTY_MS || !this.lastCards) this.sawEmpty = true;
      else prev = this.lastCards; // kurze Lücke: mit den Karten davor vergleichen
      this.emptyAt = null;
    }
    this.lastCards = cur;

    const prevCards = prev ? prev.player : [];
    const replaced = prev && prevCards.length > 0 && (
      cur.player.length < prevCards.length ||
      (cur.player[0] && prevCards[0] && cur.player[0].rank !== prevCards[0].rank) ||
      (cur.player[1] && prevCards[1] && cur.player[1].rank !== prevCards[1].rank)
    );

    if (this.sawEmpty || replaced) {
      this.sawEmpty = false;
      // Neue Runde: keine zusätzlichen "Karte gezogen"-Meldungen.
      if (this.auto) {
        this.round += 1;
        events.push({ type: 'round-start', round: this.round, source: 'auto' });
      } else {
        events.push({ type: 'round-suggested' });
      }
      return events;
    }
    if (prev && cur.player.length > prevCards.length) {
      events.push({ type: 'card-added', hand: 'player', count: cur.player.length });
    }
    if (prev && cur.split.length > prev.split.length) {
      events.push({ type: 'card-added', hand: 'split', count: cur.split.length });
    }
    return events;
  }
}

export const ROUND_CONSTANTS = { STABLE_FRAMES, UNSTABLE_WARN_MS, EMPTY_FRAMES_FOR_NEW_ROUND, NEW_ROUND_EMPTY_MS };
