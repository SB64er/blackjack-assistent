// Angelernte Kartenmuster (lokal, nur nach ausdrücklicher Zustimmung).
// Gespeichert werden ausschliesslich 20×28-Schwarz-Weiss-Muster der
// Rangzeichen – keine Kamerabilder.
import { load, save, remove } from '../core/store.js';
import { Emitter } from '../core/events.js';
import { packBits, unpackBits, dilate } from './vision.js';
import { RANKS, rankValue } from '../game/hand.js';

const KEY = 'templates';
export const IGNORE = 'X'; // "kein Kartenwert" (z. B. Farbsymbol in der Kartenmitte)
const MAX_PER_RANK = 6;

export class TemplateStore extends Emitter {
  constructor() {
    super();
    const raw = load(KEY, null);
    this.consent = !!(raw && raw.consent);
    this.consentAt = raw && raw.consentAt;
    this.items = [];
    if (raw && Array.isArray(raw.items)) {
      for (const it of raw.items) {
        try {
          if (!RANKS.includes(it.rank) && it.rank !== IGNORE) continue;
          this.items.push(this._prepare(it));
        } catch { /* beschädigten Eintrag überspringen */ }
      }
    }
  }

  _prepare(it) {
    const bits = unpackBits(it.bits);
    return { ...it, suitRatio: it.suitRatio ?? null, value: it.rank === IGNORE ? 0 : rankValue(it.rank), _bits: bits, _dil: dilate(bits) };
  }

  _persist() {
    save(KEY, {
      version: 1,
      consent: this.consent,
      consentAt: this.consentAt,
      items: this.items.map(({ id, rank, bits, aspect, hRel, suitRatio, createdAt }) => ({ id, rank, bits, aspect, hRel, suitRatio, createdAt }))
    });
    this.emit('change');
  }

  giveConsent() {
    this.consent = true;
    this.consentAt = new Date().toISOString();
    this._persist();
  }

  // Zustimmung zurückziehen = alle Muster löschen.
  revokeConsent() {
    this.consent = false;
    this.consentAt = null;
    this.items = [];
    remove(KEY);
    this.emit('change');
  }

  add(rank, candidate) {
    if (!this.consent) throw new Error('Ohne Zustimmung werden keine Muster gespeichert.');
    if (!RANKS.includes(rank) && rank !== IGNORE) throw new Error('Unbekannter Kartenwert');
    const item = this._prepare({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      rank,
      bits: packBits(candidate.bits),
      aspect: candidate.aspect,
      hRel: candidate.hRel,
      suitRatio: rank === IGNORE ? null : (candidate.suitRatio ?? null),
      createdAt: new Date().toISOString()
    });
    this.items.push(item);
    const same = this.items.filter((t) => t.rank === rank);
    if (same.length > (rank === IGNORE ? MAX_PER_RANK * 3 : MAX_PER_RANK)) {
      const drop = same[0];
      this.items = this.items.filter((t) => t !== drop);
    }
    this._persist();
    return item;
  }

  removeRank(rank) {
    this.items = this.items.filter((t) => t.rank !== rank);
    this._persist();
  }

  clear() {
    this.items = [];
    this._persist();
  }

  countByRank() {
    const out = {};
    for (const r of RANKS) out[r] = 0;
    out[IGNORE] = 0;
    for (const t of this.items) out[t.rank]++;
    return out;
  }

  missingRanks() {
    const c = this.countByRank();
    return RANKS.filter((r) => c[r] === 0);
  }

  get ready() {
    return this.consent && this.items.some((t) => t.rank !== IGNORE);
  }
}
