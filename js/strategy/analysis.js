// Strategieanalyse eines Profils – nachvollziehbar und klar gekennzeichnet:
//   "berechnet"  = exakte Rechnung im Modell (unendliches Deck, siehe ev.js)
//   "simulation" = Zufallssimulation mit endlichem Schuh (siehe simulate.js)
//   "annahme"    = nicht überprüfte Annahmen / Grenzen
import { ROWS, UPCARDS, cellKey, standardCode, normalizeRules, CODES_BY_KIND } from './standard.js';
import { ACTIONS } from './engine.js';
import { computeStrategy, strategyEV, profilePolicy, addCard, MODEL_ASSUMPTIONS, CARD_P, CARD_VALUES } from './ev.js';

const pOf = (v) => CARD_P[CARD_VALUES.indexOf(v)];

// Wahrscheinlichkeit einer Startzelle (2 Karten, unendliches Deck) – für Gewichtung.
function cellProbability(kind, value) {
  let p = 0;
  for (const a of CARD_VALUES) {
    for (const b of CARD_VALUES) {
      const [t, s] = addCard(...addCard(0, 0, a), b);
      if (t === 21) continue;
      if (kind === 'pair') { if (a === b && a === value) p += pOf(a) * pOf(b); continue; }
      if (a === b) continue;
      if (kind === 'soft' && s && t === value) p += pOf(a) * pOf(b);
      if (kind === 'hard' && !s && t === value) p += pOf(a) * pOf(b);
    }
  }
  return p;
}

function cellState(kind, value) {
  if (kind === 'pair') return [...addCard(...addCard(0, 0, value), value), value];
  return [value, kind === 'soft' ? 1 : 0, null];
}

/**
 * @param {object} profile
 * @param {object} tableRules – aktuelle Tischregeln
 */
export function analyzeProfile(profile, tableRules) {
  const rules = normalizeRules(tableRules);
  const strategyRules = profile.settings && profile.settings.followTableRules ? rules : normalizeRules(profile.rules);
  const t0 = Date.now();
  const calc = computeStrategy(rules);
  const pol = profilePolicy(profile.overrides, strategyRules, rules);
  const std = profilePolicy(null, rules, rules);
  const opt = (up, t, s, count, afterSplit, pair) => {
    // beste Aktion für Startzellen, sonst ziehen/stehen optimal
    if (count === 2 && !afterSplit) {
      const kind = pair != null ? 'pair' : (s ? 'soft' : 'hard');
      const v = pair != null ? pair : (kind === 'hard' ? Math.max(5, t) : t);
      const c = calc.cells[cellKey(kind, v, up)];
      if (c) return c.best;
    }
    return std(up, t, s, count, afterSplit, pair);
  };

  const vsStandard = [];
  const vsModel = [];
  const invalidCells = [];
  for (const [k, code] of Object.entries(profile.overrides || {})) {
    const kind = k.split(':')[0];
    if (!CODES_BY_KIND[kind] || !CODES_BY_KIND[kind].includes(code)) invalidCells.push(k);
  }
  for (const kind of Object.keys(ROWS)) {
    for (const v of ROWS[kind]) {
      if (kind !== 'pair' && v === 21) continue;
      for (const up of UPCARDS) {
        const key = cellKey(kind, v, up);
        const [t, s, pair] = cellState(kind, v);
        const a = pol(up, t, s, 2, false, pair);
        const b = std(up, t, s, 2, false, pair);
        const cell = calc.cells[key];
        const evA = cell.evs[a];
        const evBest = cell.evs[cell.best];
        const weight = cellProbability(kind, v) * pOf(up);
        if (a !== b) vsStandard.push({ key, kind, value: v, up, profile: a, standard: b, evProfile: cell.evs[a], evStandard: cell.evs[b], weight });
        if (evA != null && evBest - evA > 1e-9) vsModel.push({ key, kind, value: v, up, profile: a, best: cell.best, loss: evBest - evA, weight, margin: cell.margin });
      }
    }
  }

  const evProfile = strategyEV(rules, pol).ev;
  const evStandard = strategyEV(rules, std).ev;
  const evModelBest = strategyEV(rules, opt).ev;

  return {
    computedAt: new Date().toISOString(),
    ms: Date.now() - t0,
    rules,
    strategyRules,
    computed: {
      label: 'Berechnet (Modell)',
      evProfile,
      evStandard,
      evModelBest,
      vsStandard,
      vsModel: vsModel.sort((x, y) => y.loss * y.weight - x.loss * x.weight)
    },
    assumptions: [
      ...MODEL_ASSUMPTIONS,
      'Folgeentscheidungen (ab der 3. Karte) nach der Tabelle des Profils; Verdoppeln ist dann nicht mehr möglich.',
      'Der Gesamterwartungswert ist ein Modellwert und keine Garantie für echte Spiele.'
    ],
    invalidCells,
    notes: [
      rules.decks <= 2 ? 'Bei 1–2 Decks weicht die beste Strategie leicht vom Modell ab. Für genauere Werte eine Simulation mit endlichem Schuh starten.' : null,
      profile.settings && !profile.settings.followTableRules && JSON.stringify(normalizeRules(profile.rules)) !== JSON.stringify(rules)
        ? 'Das Profil wurde für andere Tischregeln erstellt. Bewertet wird es mit den aktuellen Tischregeln.' : null
    ].filter(Boolean)
  };
}

/** Kurzer, gut lesbarer Prozentwert mit Vorzeichen. */
export function pct(x, digits = 2) {
  const v = (x * 100).toFixed(digits);
  return `${x >= 0 ? '+' : ''}${v.replace('.', ',')} %`;
}

export { ACTIONS };
