// Rechenmodell: exakte Erwartungswerte bei UNENDLICH vielen Decks
// (jede Karte hat immer dieselbe Wahrscheinlichkeit: 2–9 und Ass je 1/13, Zehnerwert 4/13).
// Reine Mathematik, ohne Zufall, ohne Internet -> jederzeit nachrechenbar.
//
// Modellannahmen (werden in der App angezeigt):
// - Dealer schaut bei Ass/Zehn nach Blackjack (Peek). Alle Werte gelten
//   unter der Bedingung, dass der Dealer KEINEN Blackjack hat.
// - Split: einmal, kein erneutes Splitten; geteilte Asse erhalten je eine Karte.
// - Kein Aufgeben (Surrender) – ab Version 0.6.0 entfernt.
// - Anzahl Decks wird NICHT berücksichtigt (unendliches Deck). Bei 1–2 Decks
//   weichen echte Werte etwas ab; Simulationen mit endlichem Schuh zeigen das.
import { normalizeRules, ROWS, UPCARDS, cellKey, standardCode, CODES_BY_KIND, modernCode } from './standard.js';
import { resolveCode, ACTIONS } from './engine.js';

export const CARD_VALUES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
export const CARD_P = CARD_VALUES.map((v) => (v === 10 ? 4 / 13 : 1 / 13));
const DEALER_OUT = [17, 18, 19, 20, 21]; // + Index 5 = überkauft

export const MODEL_ASSUMPTIONS = [
  'Unendlich viele Decks: jede Karte gleich wahrscheinlich (2–9 und Ass je 1/13, Zehnerwert 4/13).',
  'Der Dealer prüft bei Ass oder Zehn auf Blackjack (Peek); Entscheidungswerte gelten ohne Dealer-Blackjack.',
  'Split nur einmal (kein erneutes Splitten); geteilte Asse erhalten je genau eine Karte.',
  'Aufgeben (Surrender) wird nicht angeboten.',
  'Die Anzahl Decks fliesst nicht ein; bei 1–2 Decks sind kleine Abweichungen möglich.'
];

// Karte hinzufügen. s = Anzahl Asse, die als 11 zählen (0/1).
export function addCard(t, s, c) {
  t += c;
  if (c === 11) s += 1;
  while (t > 21 && s > 0) { t -= 10; s -= 1; }
  return [t, s > 0 ? 1 : 0];
}

function dealerFinal(t, s, h17, memo) {
  const key = t * 2 + s;
  if (memo.has(key)) return memo.get(key);
  let out;
  if (t > 21) {
    out = [0, 0, 0, 0, 0, 1];
  } else if (t >= 17 && !(h17 && t === 17 && s)) {
    out = [0, 0, 0, 0, 0, 0];
    out[t - 17] = 1;
  } else {
    out = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < CARD_VALUES.length; i++) {
      const [nt, ns] = addCard(t, s, CARD_VALUES[i]);
      const sub = dealerFinal(nt, ns, h17, memo);
      for (let k = 0; k < 6; k++) out[k] += CARD_P[i] * sub[k];
    }
  }
  memo.set(key, out);
  return out;
}

/** Verteilung des Dealer-Endwerts (17–21, überkauft) bei offener Karte up, ohne Dealer-Blackjack. */
export function dealerDistribution(up, rules) {
  const h17 = normalizeRules(rules).soft17 === 'zieht';
  const memo = new Map();
  const out = [0, 0, 0, 0, 0, 0];
  let norm = 0;
  const [t0, s0] = addCard(0, 0, up);
  for (let i = 0; i < CARD_VALUES.length; i++) {
    const c = CARD_VALUES[i];
    if ((up === 10 && c === 11) || (up === 11 && c === 10)) continue; // Blackjack ausgeschlossen
    norm += CARD_P[i];
    const [t, s] = addCard(t0, s0, c);
    const sub = dealerFinal(t, s, h17, memo);
    for (let k = 0; k < 6; k++) out[k] += CARD_P[i] * sub[k];
  }
  return out.map((x) => x / norm);
}

export function dealerBlackjackChance(up) {
  if (up === 11) return 4 / 13;
  if (up === 10) return 1 / 13;
  return 0;
}

function standEV(t, dist) {
  if (t > 21) return -1;
  let ev = dist[5];
  for (let k = 0; k < 5; k++) {
    const d = DEALER_OUT[k];
    ev += dist[k] * (t > d ? 1 : (t === d ? 0 : -1));
  }
  return ev;
}

/**
 * Rechner für eine Dealerkarte. policy (optional): Funktion (t, s, count, afterSplit) -> Aktion
 * für Folgeentscheidungen; ohne policy wird jeweils die beste Aktion gewählt.
 */
export class UpcardModel {
  constructor(up, rules) {
    this.up = up;
    this.rules = normalizeRules(rules);
    this.dist = dealerDistribution(up, this.rules);
    this._hitBest = new Map();
  }

  stand(t) { return standEV(t, this.dist); }

  // Ziehen, danach jeweils optimal weiterspielen (nur ziehen/stehen).
  hit(t, s) {
    const key = t * 2 + s;
    if (this._hitBest.has(key)) return this._hitBest.get(key);
    let ev = 0;
    for (let i = 0; i < CARD_VALUES.length; i++) {
      const [nt, ns] = addCard(t, s, CARD_VALUES[i]);
      ev += CARD_P[i] * (nt > 21 ? -1 : Math.max(this.stand(nt), this.hit(nt, ns)));
    }
    this._hitBest.set(key, ev);
    return ev;
  }

  double(t, s) {
    let ev = 0;
    for (let i = 0; i < CARD_VALUES.length; i++) {
      const [nt] = addCard(t, s, CARD_VALUES[i]);
      ev += CARD_P[i] * (nt > 21 ? -1 : this.stand(nt));
    }
    return 2 * ev;
  }

  // Split eines Paares mit Kartenwert v (beide Hände danach optimal).
  split(v) {
    let per = 0;
    for (let i = 0; i < CARD_VALUES.length; i++) {
      const [t, s] = addCard(...addCard(0, 0, v), CARD_VALUES[i]);
      if (v === 11) per += CARD_P[i] * this.stand(t);
      else {
        let best = Math.max(this.stand(t), this.hit(t, s));
        if (this.rules.das) best = Math.max(best, this.double(t, s));
        per += CARD_P[i] * best;
      }
    }
    return 2 * per;
  }

  /** Erwartungswerte aller erlaubten Aktionen einer Startzelle (2 Karten). */
  cellEVs(kind, value) {
    let t;
    let s;
    if (kind === 'pair') [t, s] = addCard(...addCard(0, 0, value), value);
    else if (kind === 'soft') { t = value; s = 1; } else { t = value; s = 0; }
    const out = {
      [ACTIONS.STAND]: this.stand(t),
      [ACTIONS.HIT]: this.hit(t, s),
      [ACTIONS.DOUBLE]: this.double(t, s)
    };
    if (kind === 'pair') out[ACTIONS.SPLIT] = this.split(value);
    return out;
  }
}

const memoModels = new Map();
export function modelFor(up, rules) {
  const r = normalizeRules(rules);
  const key = `${up}|${r.soft17}|${r.das}`;
  if (!memoModels.has(key)) memoModels.set(key, new UpcardModel(up, r));
  return memoModels.get(key);
}

const ACTION_ORDER = [ACTIONS.STAND, ACTIONS.HIT, ACTIONS.DOUBLE, ACTIONS.SPLIT];

function bestOf(evs) {
  let best = null;
  for (const a of ACTION_ORDER) {
    if (evs[a] == null) continue;
    if (!best || evs[a] > evs[best] + 1e-12) best = a;
  }
  return best;
}

// Für jede Zelle: beste Aktion und der passende Tabellencode.
function codeFor(kind, evs) {
  const best = bestOf(evs);
  const noDouble = { ...evs }; delete noDouble[ACTIONS.DOUBLE];
  const afterDouble = bestOf(noDouble);
  if (best === ACTIONS.DOUBLE) return afterDouble === ACTIONS.STAND ? 'Ds' : 'D';
  if (best === ACTIONS.SPLIT) return 'P';
  if (best === ACTIONS.STAND) return 'S';
  return 'H';
}

/**
 * Berechnete Strategietabelle für Tischregeln.
 * Liefert je Zelle: code, evs (alle Aktionen), best, Abstand zur zweitbesten Aktion.
 */
export function computeStrategy(rules) {
  const r = normalizeRules(rules);
  const cells = {};
  for (const kind of Object.keys(ROWS)) {
    for (const v of ROWS[kind]) {
      for (const u of UPCARDS) {
        const m = modelFor(u, r);
        const evs = m.cellEVs(kind, v);
        if (kind !== 'pair' && v === 21) delete evs[ACTIONS.DOUBLE];
        const best = bestOf(evs);
        const sorted = Object.values(evs).sort((a, b) => b - a);
        cells[cellKey(kind, v, u)] = { code: codeFor(kind, evs), best, evs, margin: sorted[0] - (sorted[1] ?? sorted[0]) };
      }
    }
  }
  return { rules: r, cells };
}

// --- Gesamterwartungswert einer Strategie (Profil) im Modell -----------------

/** Policy aus Profil-Overrides: (t, s, count, afterSplit, pairValue) -> Aktion. */
export function profilePolicy(overrides, strategyRules, tableRules) {
  const tr = normalizeRules(tableRules);
  return (up, t, s, count, afterSplit, pairValue = null) => {
    const allowed = {
      double: count === 2 && (!afterSplit || tr.das),
      split: pairValue != null && !afterSplit,
      das: tr.das
    };
    const look = (kind, value) => {
      const key = cellKey(kind, value, up);
      const own = overrides && overrides[key] != null ? modernCode(overrides[key]) : null;
      const code = own != null && CODES_BY_KIND[kind].includes(own) ? own : standardCode(kind, value, up, strategyRules);
      return resolveCode(code, allowed);
    };
    if (pairValue != null) {
      const a = look('pair', pairValue);
      if (a) return a;
    }
    if (s && t <= 12) return ACTIONS.HIT;
    return s ? look('soft', t) : look('hard', Math.max(5, t));
  };
}

function policyHandEV(m, policy, t, s, count, afterSplit, memo) {
  const key = `${t}|${s}|${count > 2 ? 3 : count}|${afterSplit ? 1 : 0}`;
  if (memo.has(key)) return memo.get(key);
  const a = policy(m.up, t, s, count, afterSplit);
  let ev;
  if (a === ACTIONS.STAND) ev = m.stand(t);
  else if (a === ACTIONS.DOUBLE) ev = m.double(t, s);
  else {
    ev = 0;
    for (let i = 0; i < CARD_VALUES.length; i++) {
      const [nt, ns] = addCard(t, s, CARD_VALUES[i]);
      ev += CARD_P[i] * (nt > 21 ? -1 : policyHandEV(m, policy, nt, ns, count + 1, afterSplit, memo));
    }
  }
  memo.set(key, ev);
  return ev;
}

/**
 * Erwartungswert pro Einsatz einer Strategie bei Tischregeln (Modell: unendliches Deck).
 * policy: wie profilePolicy; ohne policy = beste Entscheidungen des Modells.
 * Liefert { ev, perUpcard }.
 */
export function strategyEV(rules, policy = null) {
  const r = normalizeRules(rules);
  const payout = r.payout === '6:5' ? 1.2 : 1.5;
  let total = 0;
  const perUpcard = {};
  for (let ui = 0; ui < CARD_VALUES.length; ui++) {
    const up = CARD_VALUES[ui];
    const m = modelFor(up, r);
    const pDbj = dealerBlackjackChance(up);
    const memo = new Map();
    let evUp = 0;
    for (let i = 0; i < CARD_VALUES.length; i++) {
      for (let j = 0; j < CARD_VALUES.length; j++) {
        const p = CARD_P[i] * CARD_P[j];
        const a = CARD_VALUES[i];
        const b = CARD_VALUES[j];
        const [t, s] = addCard(...addCard(0, 0, a), b);
        if (t === 21) { evUp += p * (1 - pDbj) * payout; continue; } // Spieler-Blackjack
        const pair = a === b ? a : null;
        let ev;
        if (policy) {
          const act = policy(up, t, s, 2, false, pair);
          if (act === ACTIONS.SPLIT) ev = splitPolicyEV(m, policy, pair);
          else if (act === ACTIONS.STAND) ev = m.stand(t);
          else if (act === ACTIONS.DOUBLE) ev = m.double(t, s);
          else ev = policyHandEV(m, policy, t, s, 2, false, memo);
          // HIT: Folgekarten nach Policy (memo-Schlüssel ohne Paarinformation ok, da count > 2)
          if (act === ACTIONS.HIT) {
            ev = 0;
            for (let k = 0; k < CARD_VALUES.length; k++) {
              const [nt, ns] = addCard(t, s, CARD_VALUES[k]);
              ev += CARD_P[k] * (nt > 21 ? -1 : policyHandEV(m, policy, nt, ns, 3, false, memo));
            }
          }
        } else {
          const evs = m.cellEVs(pair ? 'pair' : (s ? 'soft' : 'hard'), pair || t);
          ev = Math.max(...Object.values(evs));
        }
        evUp += p * ((1 - pDbj) * ev - pDbj);
      }
    }
    perUpcard[up] = evUp;
    total += CARD_P[ui] * evUp;
  }
  return { ev: total, perUpcard };
}

function splitPolicyEV(m, policy, v) {
  const memo = new Map();
  let per = 0;
  for (let i = 0; i < CARD_VALUES.length; i++) {
    const [t, s] = addCard(...addCard(0, 0, v), CARD_VALUES[i]);
    if (v === 11) per += CARD_P[i] * m.stand(t);
    else per += CARD_P[i] * policyHandEV(m, policy, t, s, 2, true, memo);
  }
  return 2 * per;
}
