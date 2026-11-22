// Reproduzierbare Monte-Carlo-Simulation mit endlichem Schuh.
// Gleicher Startwert (seed) + gleiche Einstellungen = genau gleiches Ergebnis.
// Ergebnisse sind SIMULATIONSWERTE mit statistischer Unsicherheit (95-%-Intervall).
//
// Ablauf je Runde: Spieler, Dealer offen, Spieler, Dealer verdeckt.
// Dealer prüft bei Ass/Zehn auf Blackjack (Peek). Split einmal, geteilte Asse
// erhalten je eine Karte. Neu gemischt wird nach 75 % des Schuhs.
import { decide, ACTIONS } from './engine.js';
import { normalizeRules } from './standard.js';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const VAL = { A: 11, J: 10, Q: 10, K: 10 };
const val = (r) => VAL[r] || Number(r);

// mulberry32 – kleiner, gut dokumentierter Zufallsgenerator mit Startwert.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function total(cards) {
  let t = 0;
  let a = 0;
  for (const c of cards) { const v = val(c.rank); t += v; if (v === 11) a++; }
  while (t > 21 && a > 0) { t -= 10; a--; }
  return { t, soft: a > 0 };
}

export class Simulation {
  /**
   * @param {{ rules, overrides?, strategyRules?, seed?, penetration? }} opts
   */
  constructor({ rules, overrides = null, strategyRules = null, seed = 20261122, penetration = 0.75 }) {
    this.rules = normalizeRules(rules);
    this.overrides = overrides;
    this.strategyRules = strategyRules ? normalizeRules(strategyRules) : this.rules;
    this.seed = seed >>> 0;
    this.penetration = penetration;
    this.random = rng(this.seed);
    this.payout = this.rules.payout === '6:5' ? 1.2 : 1.5;
    this.h17 = this.rules.soft17 === 'zieht';
    this.rounds = 0;
    this.sum = 0;
    this.sumSq = 0;
    this.shoe = [];
    this.pos = 0;
    this._shuffle();
  }

  _shuffle() {
    const shoe = [];
    for (let d = 0; d < this.rules.decks; d++) for (let s = 0; s < 4; s++) for (const r of RANKS) shoe.push({ rank: r, confident: true });
    for (let i = shoe.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
    }
    this.shoe = shoe;
    this.pos = 0;
  }

  _draw() {
    return this.shoe[this.pos++];
  }

  _decide(cards, up, afterSplit) {
    return decide(cards, up, { rules: this.rules, strategyRules: this.strategyRules, overrides: this.overrides, afterSplit }).action;
  }

  _playHand(cards, up, afterSplit) {
    // liefert [{ cards, bet, done:'bust'|'surrender'|null }]
    let bet = 1;
    for (;;) {
      const t = total(cards).t;
      if (t >= 21) break;
      const a = this._decide(cards, up, afterSplit);
      if (a === ACTIONS.STAND || a == null) break;
      if (a === ACTIONS.SURRENDER) return [{ cards, bet, surrender: true }];
      if (a === ACTIONS.DOUBLE) { bet = 2; cards.push(this._draw()); break; }
      if (a === ACTIONS.SPLIT) {
        const out = [];
        for (const c of cards) {
          const h = [c, this._draw()];
          if (c.rank === 'A') out.push({ cards: h, bet: 1 });
          else out.push(...this._playHand(h, up, true));
        }
        return out;
      }
      cards.push(this._draw());
    }
    return [{ cards, bet }];
  }

  _round() {
    if (this.pos > this.shoe.length * this.penetration) this._shuffle();
    const p = [this._draw()];
    const up = this._draw();
    p.push(this._draw());
    const hole = this._draw();
    const dealer = [up, hole];
    const pBJ = total(p).t === 21;
    const dBJ = total(dealer).t === 21;
    if (dBJ) return pBJ ? 0 : -1;
    if (pBJ) return this.payout;
    const hands = this._playHand(p, up, false);
    let result = 0;
    const live = hands.filter((h) => !h.surrender && total(h.cards).t <= 21);
    if (live.length) {
      for (;;) {
        const d = total(dealer);
        if (d.t > 17 || (d.t === 17 && !(this.h17 && d.soft))) break;
        dealer.push(this._draw());
      }
    }
    const dt = total(dealer).t;
    for (const h of hands) {
      if (h.surrender) { result -= 0.5 * h.bet; continue; }
      const pt = total(h.cards).t;
      if (pt > 21) result -= h.bet;
      else if (dt > 21 || pt > dt) result += h.bet;
      else if (pt < dt) result -= h.bet;
    }
    return result;
  }

  step(n) {
    for (let i = 0; i < n; i++) {
      const r = this._round();
      this.rounds++;
      this.sum += r;
      this.sumSq += r * r;
    }
    return this.result();
  }

  result() {
    const n = this.rounds;
    const mean = n ? this.sum / n : 0;
    const variance = n > 1 ? (this.sumSq - n * mean * mean) / (n - 1) : 0;
    const se = n > 1 ? Math.sqrt(variance / n) : 0;
    return {
      label: 'Simulation',
      rounds: n,
      seed: this.seed,
      decks: this.rules.decks,
      penetration: this.penetration,
      ev: mean,
      se,
      ci95: [mean - 1.96 * se, mean + 1.96 * se],
      sd: Math.sqrt(variance)
    };
  }
}
