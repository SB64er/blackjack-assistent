// Reproduzierbare Monte-Carlo-Simulation mit endlichem Schuh.
// Gleicher Startwert (seed) + gleiche Einstellungen = genau gleiches Ergebnis.
// Ergebnisse sind SIMULATIONSWERTE mit statistischer Unsicherheit (95-%-Intervall).
//
// Ablauf je Runde: Spieler, Dealer offen, Spieler, Dealer verdeckt.
// Dealer prüft bei Ass/Zehn auf Blackjack (Peek). Split einmal, geteilte Asse
// erhalten je eine Karte. Neu gemischt wird nach 75 % des Schuhs.
// Aktionen: Ziehen, Stehen, Verdoppeln, Splitten. Aufgeben gibt es nicht.
//
// Ab 0.7.0 zusätzlich: Gewinn-/Verlust-/Push-Quote, Einsatz inkl. Verdoppeln/Split,
// Ertrag pro ursprünglicher Einsatz-Einheit, längste Verlustserie, grösster
// Rückgang (Drawdown) und eine Liste der Runden für Tests (record: true).
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
  constructor({ rules, overrides = null, strategyRules = null, seed = 20261122, penetration = 0.75, stacked = null, record = false }) {
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
    this.stacked = Array.isArray(stacked) ? stacked.slice() : null; // feste Kartenfolge (Tests)
    this.record = record;
    this.log = [];
    this.s = {
      wins: 0, losses: 0, pushes: 0, hands: 0, blackjacks: 0, doubles: 0, splits: 0, busts: 0,
      wagered: 0, cum: 0, peak: 0, maxDrawdown: 0, lossStreak: 0, longestLossStreak: 0,
      winStreak: 0, longestWinStreak: 0, worst: 0, best: 0,
      // 0.8.0: Verteilungen (Ergebnis je Runde, Ergebnis je Block von SESSION_SIZE Runden)
      dist: new Map(), block: 0, sessions: []
    };
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
    if (this.stacked) {
      if (!this.stacked.length) throw new Error('Feste Kartenfolge aufgebraucht.');
      return { rank: this.stacked.shift(), confident: true };
    }
    return this.shoe[this.pos++];
  }

  _decide(cards, up, afterSplit) {
    return decide(cards, up, { rules: this.rules, strategyRules: this.strategyRules, overrides: this.overrides, afterSplit }).action;
  }

  _playHand(cards, up, afterSplit) {
    // liefert [{ cards, bet, actions }]
    let bet = 1;
    const actions = [];
    for (;;) {
      const t = total(cards).t;
      if (t >= 21) break;
      const a = this._decide(cards, up, afterSplit);
      if (a === ACTIONS.STAND || a == null) { actions.push('STAND'); break; }
      if (a === ACTIONS.DOUBLE) { bet = 2; actions.push('DOUBLE'); cards.push(this._draw()); break; }
      if (a === ACTIONS.SPLIT) {
        this.s.splits += 1;
        const out = [];
        for (const c of cards) {
          const h = [c, this._draw()];
          if (c.rank === 'A') out.push({ cards: h, bet: 1, actions: ['SPLIT'], split: true });
          else out.push(...this._playHand(h, up, true).map((x) => ({ ...x, actions: ['SPLIT', ...x.actions], split: true })));
        }
        return out;
      }
      actions.push('HIT');
      cards.push(this._draw());
    }
    if (bet === 2) this.s.doubles += 1;
    return [{ cards, bet, actions }];
  }

  _round() {
    if (!this.stacked && this.pos > this.shoe.length * this.penetration) this._shuffle();
    const p = [this._draw()];
    const up = this._draw();
    p.push(this._draw());
    const hole = this._draw();
    const dealer = [up, hole];
    const pBJ = total(p).t === 21;
    const dBJ = total(dealer).t === 21;
    const done = (net, hands, wagered) => ({ net, hands, dealer, wagered });
    if (dBJ) return done(pBJ ? 0 : -1, [{ cards: p, bet: 1, actions: [], net: pBJ ? 0 : -1 }], 1);
    if (pBJ) { this.s.blackjacks += 1; return done(this.payout, [{ cards: p, bet: 1, actions: [], net: this.payout, blackjack: true }], 1); }
    const hands = this._playHand(p, up, false);
    let result = 0;
    const live = hands.filter((h) => total(h.cards).t <= 21);
    if (live.length) {
      for (;;) {
        const d = total(dealer);
        if (d.t > 17 || (d.t === 17 && !(this.h17 && d.soft))) break;
        dealer.push(this._draw());
      }
    }
    const dt = total(dealer).t;
    let wagered = 0;
    for (const h of hands) {
      const pt = total(h.cards).t;
      wagered += h.bet;
      if (pt > 21) { h.net = -h.bet; this.s.busts += 1; }
      else if (dt > 21 || pt > dt) h.net = h.bet;
      else if (pt < dt) h.net = -h.bet;
      else h.net = 0;
      result += h.net;
    }
    return done(result, hands, wagered);
  }

  step(n) {
    const s = this.s;
    for (let i = 0; i < n; i++) {
      const rd = this._round();
      const r = rd.net;
      this.rounds++;
      this.sum += r;
      this.sumSq += r * r;
      s.hands += rd.hands.length;
      s.wagered += rd.wagered;
      if (r > 0) { s.wins += 1; s.winStreak += 1; s.lossStreak = 0; } else if (r < 0) { s.losses += 1; s.lossStreak += 1; s.winStreak = 0; } else { s.pushes += 1; }
      if (s.lossStreak > s.longestLossStreak) s.longestLossStreak = s.lossStreak;
      if (s.winStreak > s.longestWinStreak) s.longestWinStreak = s.winStreak;
      s.cum += r;
      if (s.cum > s.peak) s.peak = s.cum;
      if (s.peak - s.cum > s.maxDrawdown) s.maxDrawdown = s.peak - s.cum;
      if (r < s.worst) s.worst = r;
      if (r > s.best) s.best = r;
      const dk = Math.round(r * 2) / 2;
      s.dist.set(dk, (s.dist.get(dk) || 0) + 1);
      s.block += r;
      if (this.rounds % SESSION_SIZE === 0) { if (s.sessions.length < MAX_SESSIONS) s.sessions.push(s.block); s.block = 0; }
      if (this.record) this.log.push({ net: r, wagered: rd.wagered, player: rd.hands.map((h) => ({ cards: h.cards.map((c) => c.rank), bet: h.bet, net: h.net, actions: h.actions })), dealer: rd.dealer.map((c) => c.rank) });
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
      sd: Math.sqrt(variance),
      // Zusatzstatistik (ab 0.7.0)
      wins: this.s.wins,
      losses: this.s.losses,
      pushes: this.s.pushes,
      winRate: n ? this.s.wins / n : 0,
      lossRate: n ? this.s.losses / n : 0,
      pushRate: n ? this.s.pushes / n : 0,
      hands: this.s.hands,
      blackjacks: this.s.blackjacks,
      doubles: this.s.doubles,
      splits: this.s.splits,
      busts: this.s.busts,
      wagered: this.s.wagered,
      avgWager: n ? this.s.wagered / n : 0,
      perInitialUnit: mean,
      perWagered: this.s.wagered ? this.sum / this.s.wagered : 0,
      net: this.sum,
      longestLossStreak: this.s.longestLossStreak,
      longestWinStreak: this.s.longestWinStreak,
      expectedLongestLossStreak: n && this.s.losses ? expectedLongestRun(n, this.s.losses / n) : 0,
      maxDrawdown: this.s.maxDrawdown,
      worstRound: this.s.worst,
      bestRound: this.s.best,
      // 0.8.0: Gewinn-/Verlustverteilung (Simulationswerte, keine Vorhersage)
      distribution: [...this.s.dist.entries()].sort((a, b) => a[0] - b[0]).map(([net, count]) => ({ net, count, share: n ? count / n : 0 })),
      sessions: sessionStats(this.s.sessions)
    };
  }
}

export const SESSION_SIZE = 100;
const MAX_SESSIONS = 20000;

/** Kennzahlen der Ergebnisse je Block von SESSION_SIZE Runden ("Sitzungen"). */
export function sessionStats(list) {
  const n = list.length;
  if (!n) return { size: SESSION_SIZE, n: 0 };
  const sorted = [...list].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const mean = list.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(list.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { size: SESSION_SIZE, n, mean, sd, min: sorted[0], p05: q(0.05), p50: q(0.5), p95: q(0.95), max: sorted[n - 1], lossShare: list.filter((x) => x < 0).length / n, winShare: list.filter((x) => x > 0).length / n };
}

/** Erwartete Länge der längsten Serie bei n unabhängigen Runden mit Wahrscheinlichkeit q (Näherung). */
export function expectedLongestRun(n, q) {
  if (!(q > 0 && q < 1) || n < 2) return 0;
  return Math.log(n * (1 - q)) / Math.log(1 / q);
}

/**
 * Strategien unter GLEICHEN Bedingungen vergleichen: gleiche Tischregeln,
 * gleicher Startwert (gleiche Mischfolge), gleiche Rundenzahl.
 * strategies: [{ id, name, overrides, strategyRules }]
 */
export function compareStrategies({ rules, strategies, rounds = 10000, seed = 20261122 }) {
  return strategies.map((st) => {
    const sim = new Simulation({ rules, overrides: st.overrides || null, strategyRules: st.strategyRules || null, seed });
    return { id: st.id, name: st.name, ...sim.step(rounds) };
  });
}
