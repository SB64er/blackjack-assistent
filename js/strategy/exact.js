// Mathematische Strategie-Engine (Phase 8.5, 0.8.0): exakte Erwartungswerte für eine
// konkrete Spielsituation mit ENDLICHEM Schuh (kartenabhängig, "composition dependent").
// Reine Mathematik ohne Zufall und ohne Internet -> nachrechenbar und automatisch getestet.
//
// Unterschied zum Rechenmodell (ev.js, unendlich viele Decks):
//  - Die Deckanzahl fliesst ein. Die Karten des Spielers und die offene Dealerkarte sind
//    aus dem Schuh entfernt; jede gezogene Karte verändert die Wahrscheinlichkeiten.
//  - Zusätzliche Regeln: Aufgeben (spät), Peek ja/nein, Verdoppeln nur auf 9–11/10–11.
//
// Unterstützte Aktionen: Ziehen, Stehen, Verdoppeln, Splitten, Aufgeben (nur wenn die Regel
// "spätes Aufgeben" ausdrücklich eingestellt ist – Standard: nicht erlaubt; die Live-Empfehlung
// der App bleibt seit 0.6.0 ohne Aufgeben).
//
// Annahmen (werden angezeigt, siehe EXACT_ASSUMPTIONS):
//  - Ziehen: danach jeweils die beste Wahl aus Ziehen/Stehen, exakt mit Kartenentnahme.
//  - Split: einmal (kein erneutes Splitten), geteilte Asse erhalten je eine Karte. Der Wert
//    einer Split-Hand wird exakt berechnet und verdoppelt; dass die zweite Hand Karten aus
//    demselben Schuh zieht, wird vernachlässigt (übliche Näherung, Fehler < 0,5 % des Einsatzes).
//  - Mit Peek gelten die Werte unter der Bedingung "Dealer hat keinen Blackjack". Die Zugwahr-
//    scheinlichkeiten des Spielers berücksichtigen diese Bedingung nicht (kleine Näherung).
import { rankValue } from '../game/hand.js';

export const VALUES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const IDX = (v) => v - 2;
export const ACT = Object.freeze({ HIT: 'HIT', STAND: 'STAND', DOUBLE: 'DOUBLE', SPLIT: 'SPLIT', SURRENDER: 'SURRENDER' });
export const ACT_LABEL = { HIT: 'Ziehen', STAND: 'Stehen', DOUBLE: 'Verdoppeln', SPLIT: 'Splitten', SURRENDER: 'Aufgeben' };
const ORDER = [ACT.STAND, ACT.HIT, ACT.DOUBLE, ACT.SPLIT, ACT.SURRENDER];

export const EXACT_RULE_DEFAULTS = Object.freeze({
  decks: 6, soft17: 'steht', das: true, payout: '3:2', peek: true, surrender: 'keine', doubleOn: 'alle'
});

export const EXACT_ASSUMPTIONS = [
  'Endlicher Schuh: die Karten des Spielers und die offene Dealerkarte sind entfernt, jede gezogene Karte verändert die Wahrscheinlichkeiten.',
  'Nach dem Ziehen wird jeweils die beste Wahl aus Ziehen und Stehen getroffen.',
  'Split nur einmal; geteilte Asse erhalten je genau eine Karte. Split-Hände werden einzeln exakt berechnet (Wechselwirkung der beiden Hände vernachlässigt).',
  'Mit Peek: Werte gelten unter der Bedingung, dass der Dealer keinen Blackjack hat.',
  'Aufgeben nur, wenn „spätes Aufgeben“ als Regel eingestellt ist (Rückgabe des halben Einsatzes).'
];

/** Regeln der Engine prüfen/vervollständigen. decks: 1–8 (intern für Tests bis 1000). */
export function normalizeExactRules(r = {}) {
  const d = EXACT_RULE_DEFAULTS;
  const decks = Number.isInteger(r.decks) && r.decks >= 1 && r.decks <= 1000 ? r.decks : d.decks;
  return {
    decks,
    soft17: r.soft17 === 'zieht' ? 'zieht' : 'steht',
    das: typeof r.das === 'boolean' ? r.das : d.das,
    payout: r.payout === '6:5' ? '6:5' : '3:2',
    peek: typeof r.peek === 'boolean' ? r.peek : d.peek,
    surrender: r.surrender === 'spaet' ? 'spaet' : 'keine',
    doubleOn: ['alle', '9-11', '10-11'].includes(r.doubleOn) ? r.doubleOn : 'alle',
    ...(r.decksUnknown === true ? { decksUnknown: true } : {})
  };
}

export function exactRulesText(r) {
  const x = normalizeExactRules(r);
  return [
    x.decksUnknown ? `Decks unbekannt (Annahme ${x.decks})` : `${x.decks} ${x.decks === 1 ? 'Deck' : 'Decks'}`,
    x.soft17 === 'zieht' ? 'H17' : 'S17',
    x.das ? 'DAS' : 'kein DAS',
    `BJ ${x.payout}`,
    x.peek ? 'Peek' : 'kein Peek',
    x.surrender === 'spaet' ? 'spätes Aufgeben' : 'kein Aufgeben',
    x.doubleOn === 'alle' ? 'Verdoppeln auf alle' : `Verdoppeln nur ${x.doubleOn}`
  ].join(' · ');
}

// --- Schuh ---------------------------------------------------------------

export function fullShoe(decks) {
  return VALUES.map((v) => (v === 10 ? 16 : 4) * decks);
}

const toValue = (c) => (typeof c === 'number' ? c : rankValue(typeof c === 'object' && c ? c.rank : c));

export function removeCards(shoe, cards) {
  const s = shoe.slice();
  for (const c of cards) {
    const v = toValue(c);
    if (!(v >= 2 && v <= 11)) throw new Error(`Ungültige Karte: ${c}`);
    if (s[IDX(v)] <= 0) throw new Error('Diese Karten sind im Schuh nicht mehr vorhanden.');
    s[IDX(v)] -= 1;
  }
  return s;
}

function addCard(t, s, v) {
  t += v;
  if (v === 11) s += 1;
  while (t > 21 && s > 0) { t -= 10; s -= 1; }
  return [t, s > 0 ? 1 : 0];
}

export function handTotal(values) {
  let t = 0; let s = 0;
  for (const v of values) [t, s] = addCard(t, s, v);
  return { total: t, soft: s === 1 };
}

// --- Dealer --------------------------------------------------------------

class Calc {
  constructor(rules) {
    this.r = normalizeExactRules(rules);
    this.h17 = this.r.soft17 === 'zieht';
    this.dealerMemo = new Map();
    this.hitMemo = new Map();
    this.distMemo = new Map();
  }

  // Endwert-Verteilung des Dealers [17,18,19,20,21,überkauft] ab Dealerhand (t,s) mit Schuh.
  dealerFrom(shoe, t, s) {
    if (t > 21) return [0, 0, 0, 0, 0, 1];
    if (t >= 17 && !(this.h17 && t === 17 && s)) { const o = [0, 0, 0, 0, 0, 0]; o[t - 17] = 1; return o; }
    const key = `${shoe.join(',')}|${t}|${s}`;
    const hit = this.dealerMemo.get(key);
    if (hit) return hit;
    let n = 0;
    for (const c of shoe) n += c;
    const out = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 10; i++) {
      if (!shoe[i]) continue;
      const p = shoe[i] / n;
      shoe[i] -= 1;
      const [nt, ns] = addCard(t, s, VALUES[i]);
      const sub = this.dealerFrom(shoe, nt, ns);
      shoe[i] += 1;
      for (let k = 0; k < 6; k++) out[k] += p * sub[k];
    }
    this.dealerMemo.set(key, out);
    return out;
  }

  // Verteilung ab offener Karte: verdeckte Karte aufgezählt, Blackjack abgetrennt.
  dealerDist(shoe, up) {
    const key = `${shoe.join(',')}|u${up}`;
    const memo = this.distMemo.get(key);
    if (memo) return memo;
    let n = 0;
    for (const c of shoe) n += c;
    const out = [0, 0, 0, 0, 0, 0];
    let pBJ = 0;
    const [t0, s0] = addCard(0, 0, up);
    for (let i = 0; i < 10; i++) {
      if (!shoe[i]) continue;
      const v = VALUES[i];
      const p = shoe[i] / n;
      if ((up === 11 && v === 10) || (up === 10 && v === 11)) { pBJ += p; continue; }
      shoe[i] -= 1;
      const [t, s] = addCard(t0, s0, v);
      const sub = this.dealerFrom(shoe, t, s);
      shoe[i] += 1;
      for (let k = 0; k < 6; k++) out[k] += p * sub[k];
    }
    const norm = 1 - pBJ;
    const res = { dist: out.map((x) => (norm > 0 ? x / norm : 0)), pBJ };
    this.distMemo.set(key, res);
    return res;
  }

  standEV(shoe, up, t) {
    if (t > 21) return -1;
    const { dist } = this.dealerDist(shoe, up);
    let ev = dist[5];
    for (let k = 0; k < 5; k++) { const d = 17 + k; ev += dist[k] * (t > d ? 1 : (t === d ? 0 : -1)); }
    return ev;
  }

  // Ziehen, danach optimal Ziehen/Stehen (exakt, mit Kartenentnahme).
  hitEV(shoe, up, t, s) {
    const key = `${shoe.join(',')}|${t}|${s}`;
    const memo = this.hitMemo.get(key);
    if (memo != null) return memo;
    let n = 0;
    for (const c of shoe) n += c;
    let ev = 0;
    for (let i = 0; i < 10; i++) {
      if (!shoe[i]) continue;
      const p = shoe[i] / n;
      const [nt, ns] = addCard(t, s, VALUES[i]);
      if (nt > 21) { ev -= p; continue; }
      shoe[i] -= 1;
      const best = nt === 21 ? this.standEV(shoe, up, 21) : Math.max(this.standEV(shoe, up, nt), this.hitEV(shoe, up, nt, ns));
      shoe[i] += 1;
      ev += p * best;
    }
    this.hitMemo.set(key, ev);
    return ev;
  }

  doubleEV(shoe, up, t, s) {
    let n = 0;
    for (const c of shoe) n += c;
    let ev = 0;
    for (let i = 0; i < 10; i++) {
      if (!shoe[i]) continue;
      const p = shoe[i] / n;
      const [nt] = addCard(t, s, VALUES[i]);
      if (nt > 21) { ev -= p; continue; }
      shoe[i] -= 1;
      ev += p * this.standEV(shoe, up, nt);
      shoe[i] += 1;
    }
    return 2 * ev;
  }

  canDouble(t, s, count, afterSplit) {
    if (count !== 2) return false;
    if (afterSplit && !this.r.das) return false;
    if (this.r.doubleOn === '9-11') return !s && t >= 9 && t <= 11;
    if (this.r.doubleOn === '10-11') return !s && t >= 10 && t <= 11;
    return true;
  }

  // Eine Split-Hand mit Startkarte v (Schuh ohne beide Paarkarten und Dealerkarte).
  splitHandEV(shoe, up, v) {
    let n = 0;
    for (const c of shoe) n += c;
    let ev = 0;
    for (let i = 0; i < 10; i++) {
      if (!shoe[i]) continue;
      const p = shoe[i] / n;
      const [t, s] = addCard(...addCard(0, 0, v), VALUES[i]);
      shoe[i] -= 1;
      let best;
      if (v === 11) best = this.standEV(shoe, up, t);            // geteilte Asse: eine Karte
      else {
        best = Math.max(this.standEV(shoe, up, t), t === 21 ? -Infinity : this.hitEV(shoe, up, t, s));
        if (this.canDouble(t, s, 2, true)) best = Math.max(best, this.doubleEV(shoe, up, t, s));
      }
      shoe[i] += 1;
      ev += p * best;
    }
    return ev;
  }
}

function bestOf(evs) {
  let best = null;
  for (const a of ORDER) {
    if (evs[a] == null) continue;
    if (!best || evs[a] > evs[best] + 1e-12) best = a;
  }
  return best;
}

const pctText = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d).replace('.', ',')} %`;

/**
 * Spielsituation analysieren.
 * @param {{ player: Array, up, rules?, afterSplit?, compareDecks? }} input
 *   player: Karten ('A','2'..'K' oder Werte 2–11 oder {rank}); up: Dealerkarte
 *   compareDecks: true = zusätzlich alle Deckanzahlen 1/2/4/6/8 rechnen
 *                 (automatisch bei unbekannter Deckanzahl)
 * @returns {{ ok, reason?, rules, hand, up, evs, available, best, second, margin, conditional,
 *   pBJ, dealerBust, explanation[], assumptions[], uncertainty[], deckComparison? }}
 */
export function analyzeHand({ player, up, rules = {}, afterSplit = false, compareDecks = null, shoe = null } = {}) {
  const r = normalizeExactRules(rules);
  const pv = (player || []).map(toValue);
  const uv = toValue(up);
  if (pv.length < 2) return { ok: false, reason: 'Mindestens zwei Spielerkarten nötig.' };
  if (pv.some((v) => !(v >= 2 && v <= 11))) return { ok: false, reason: 'Ungültige Spielerkarte.' };
  if (!(uv >= 2 && uv <= 11)) return { ok: false, reason: 'Ungültige Dealerkarte.' };
  const { total, soft } = handTotal(pv);
  const hand = { total, soft, pair: pv.length === 2 && pv[0] === pv[1], count: pv.length, values: pv };
  if (total > 21) return { ok: false, reason: 'Hand ist überkauft.', hand };
  let base;
  try { base = removeCards(shoe || fullShoe(r.decks), [...pv, uv]); } catch (err) { return { ok: false, reason: err.message, hand }; }
  const calc = new Calc(r);
  const { pBJ, dist } = calc.dealerDist(base, uv);
  const conditional = r.peek && (uv === 10 || uv === 11);
  const payout = r.payout === '6:5' ? 1.2 : 1.5;

  if (total === 21 && pv.length === 2 && !afterSplit) {
    const ev = (1 - pBJ) * payout;
    return {
      ok: true, rules: r, hand: { ...hand, blackjack: true }, up: uv, evs: {}, available: [], best: null, second: null, margin: null,
      conditional: false, pBJ, dealerBust: dist[5], blackjackEV: ev,
      explanation: [`Blackjack: keine Entscheidung nötig. Erwartungswert ${pctText(ev)} des Einsatzes (Push, wenn der Dealer ebenfalls Blackjack hat).`],
      assumptions: EXACT_ASSUMPTIONS, uncertainty: uncertaintyNotes(r)
    };
  }

  const evs = {};
  const shoeArr = base.slice();
  evs[ACT.STAND] = calc.standEV(shoeArr, uv, total);
  if (total < 21) evs[ACT.HIT] = calc.hitEV(shoeArr, uv, total, soft ? 1 : 0);
  if (calc.canDouble(total, soft ? 1 : 0, pv.length, afterSplit)) evs[ACT.DOUBLE] = calc.doubleEV(shoeArr, uv, total, soft ? 1 : 0);
  if (hand.pair && !afterSplit) {
    // Beide Paarkarten sind bereits aus dem Schuh entfernt (base).
    evs[ACT.SPLIT] = 2 * calc.splitHandEV(base.slice(), uv, pv[0]);
  }
  if (r.surrender === 'spaet' && pv.length === 2 && !afterSplit) evs[ACT.SURRENDER] = -0.5;

  // Ohne Peek: Dealer-Blackjack nimmt auch Verdoppelungs- und Split-Einsätze (europäische Regel).
  if (!r.peek && pBJ > 0) {
    for (const a of Object.keys(evs)) {
      const loss = a === ACT.DOUBLE || a === ACT.SPLIT ? 2 : 1;
      evs[a] = (1 - pBJ) * evs[a] - pBJ * loss;
    }
  }

  const best = bestOf(evs);
  const rest = { ...evs }; delete rest[best];
  const second = bestOf(rest);
  const margin = second ? evs[best] - evs[second] : null;
  const explanation = [];
  explanation.push(`${ACT_LABEL[best]} hat den höchsten Erwartungswert: ${pctText(evs[best])} des Einsatzes${second ? `, ${pctText(margin, 2).replace('+', '')} besser als ${ACT_LABEL[second]} (${pctText(evs[second])})` : ''}.`);
  explanation.push(`Dealer mit ${uv === 11 ? 'Ass' : uv}: überkauft sich in ${(dist[5] * 100).toFixed(1).replace('.', ',')} % der Fälle${conditional ? ' (ohne Dealer-Blackjack)' : ''}.`);
  if (margin != null && margin < 0.005) explanation.push('Sehr knappe Entscheidung: der Unterschied ist kleiner als 0,5 % des Einsatzes. Kleine Regel- oder Kartenunterschiede können sie umdrehen.');
  if (conditional) explanation.push('Der Dealer hat nachgeschaut (Peek): Werte gelten unter der Bedingung, dass er keinen Blackjack hat.');
  if (!r.peek && pBJ > 0) explanation.push(`Ohne Peek ist das Risiko eines Dealer-Blackjacks (${(pBJ * 100).toFixed(1).replace('.', ',')} %) eingerechnet; verdoppelte und geteilte Einsätze gehen dabei ganz verloren.`);

  const out = {
    ok: true, rules: r, hand, up: uv, evs, available: Object.keys(evs), best, second, margin, conditional, pBJ, dealerBust: dist[5],
    explanation, assumptions: EXACT_ASSUMPTIONS, uncertainty: uncertaintyNotes(r)
  };

  const wantCompare = compareDecks != null ? compareDecks : !!r.decksUnknown;
  if (wantCompare && !shoe) {
    const rows = [1, 2, 4, 6, 8].map((d) => {
      const a = analyzeHand({ player: pv, up: uv, rules: { ...r, decks: d, decksUnknown: false }, afterSplit, compareDecks: false });
      return a.ok ? { decks: d, best: a.best, margin: a.margin, ev: a.evs[a.best] } : { decks: d, best: null, error: a.reason };
    });
    const actions = [...new Set(rows.map((x) => x.best).filter(Boolean))];
    out.deckComparison = { rows, agree: actions.length <= 1, actions };
    if (actions.length > 1) {
      out.uncertainty.push(`Die beste Aktion hängt von der Deckanzahl ab (${rows.filter((x) => x.best).map((x) => `${x.decks} D: ${ACT_LABEL[x.best]}`).join(', ')}). Bei unbekannter Deckanzahl ist diese Empfehlung unsicher.`);
    } else if (r.decksUnknown) {
      out.uncertainty.push('Für alle Deckanzahlen (1, 2, 4, 6, 8) ergibt sich dieselbe beste Aktion.');
    }
  }
  return out;
}

function uncertaintyNotes(r) {
  const notes = [];
  if (r.decksUnknown) notes.push(`Deckanzahl unbekannt: gerechnet mit dem Standardprofil ${r.decks} Decks (Annahme, nicht erkannt).`);
  return notes;
}

/** Erwartungswert einer Versicherung (pro versicherter Einheit) bei bekannten Karten. */
export function insuranceEV({ player = [], decks = 6 } = {}) {
  const s = removeCards(fullShoe(decks), [...player.map(toValue), 11]);
  let n = 0;
  for (const c of s) n += c;
  const p10 = s[IDX(10)] / n;
  return { ev: 2 * p10 - (1 - p10), pTen: p10 };
}

/** Wahrscheinlichkeit, dass sich der Dealer mit offener Karte up überkauft (frischer Schuh). */
export function dealerBustChance(up, rules = {}) {
  const r = normalizeExactRules(rules);
  const uv = toValue(up);
  const calc = new Calc(r);
  const res = calc.dealerDist(removeCards(fullShoe(r.decks), [uv]), uv);
  return { bust: res.dist[5], pBJ: res.pBJ, conditionalOnNoBJ: true };
}
