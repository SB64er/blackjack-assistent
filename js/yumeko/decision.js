// YUMEKO – Strategieintelligenz.
// Ermittelt die Spielaktion aus Spielerkarten, Dealerkarte, Tischregeln, erlaubten
// Aktionen und aktiver Strategieversion – und begründet sie mit exakten
// Erwartungswerten des Rechenmodells. Sie weiss NICHTS über Geld oder Budget;
// das prüft die Risikointelligenz (js/risk/risk.js) getrennt.
// Reine Logik (ohne DOM) -> testbar.
import { decide, ACTION_LABEL } from '../strategy/engine.js';
import { strategyEV, profilePolicy } from '../strategy/ev.js';
import { normalizeRules, rulesText } from '../strategy/standard.js';
import { decisionEVs } from './archive-analysis.js';

const pctTxt = (x, d = 2) => `${(x * 100).toFixed(d).replace('-', '−')} %`;

/**
 * @param {{ cards: Array<{rank}>, up: {rank}, rules, overrides?, strategyRules?, afterSplit?, profileName?, version? }} input
 * @returns {{ action, label, evs, best, lossVsBest, deviatesFromModel, explanation, source } | null}
 */
export function strategyAdvice({ cards, up, rules, overrides = null, strategyRules = null, afterSplit = false, profileName = '', version = null }) {
  const r = normalizeRules(rules);
  const d = decide(cards, up, { rules: r, strategyRules: strategyRules || r, overrides, afterSplit });
  if (!d.action) return null;
  const evInfo = decisionEVs(cards.map((c) => c.rank), up.rank, r, afterSplit);
  const evs = evInfo ? evInfo.evs : null;
  const best = evInfo ? evInfo.best : null;
  const lossVsBest = evs && evs[d.action] != null && best ? evs[best] - evs[d.action] : null;
  const parts = [];
  if (evs) {
    const list = Object.entries(evs).sort((a, b) => b[1] - a[1]).map(([a, v]) => `${ACTION_LABEL[a]} ${pctTxt(v, 1)}`);
    parts.push(`Erwartungswerte im Rechenmodell: ${list.join(', ')}.`);
  }
  if (lossVsBest != null && lossVsBest > 1e-9) parts.push(`Die Tabelle von ${profileName || 'diesem Profil'} weicht um ${pctTxt(lossVsBest, 2)} des Einsatzes vom Modellbesten (${ACTION_LABEL[best]}) ab.`);
  else if (evs) parts.push('Das ist die Aktion mit dem höchsten Erwartungswert.');
  parts.push('Das ist eine Spielentscheidung, keine Empfehlung, Geld einzusetzen.');
  return {
    action: d.action,
    label: ACTION_LABEL[d.action],
    evs,
    best,
    lossVsBest,
    deviatesFromModel: lossVsBest != null && lossVsBest > 1e-9,
    explanation: parts.join(' '),
    source: version ? `Strategieversion ${version}` : (profileName || 'Profil'),
    situation: evInfo ? situationLabel(evInfo) : null
  };
}

export function situationLabel(d) {
  const up = d.up === 11 ? 'Ass' : String(d.up);
  if (d.kind === 'pair') return `Paar ${d.value === 11 ? 'Asse' : d.value} gegen ${up}`;
  return `${d.kind === 'soft' ? 'Weich' : 'Hart'} ${d.t} gegen ${up}`;
}

/** Erwartungswert der aktiven Strategie (exakt, Modell mit unendlichem Deck). */
export function activeStrategyEV({ rules, overrides = null, strategyRules = null }) {
  const r = normalizeRules(rules);
  const ev = strategyEV(r, profilePolicy(overrides, strategyRules || r, r)).ev;
  return { ev, label: `Rechenmodell, ${rulesText(r)}`, method: 'exakt berechnet (unendliches Deck)' };
}

const cache = new Map();
/** Wie activeStrategyEV, aber zwischengespeichert (Berechnung dauert einige Millisekunden). */
export function activeStrategyEVCached(input) {
  const key = JSON.stringify([normalizeRules(input.rules), input.overrides || null, input.strategyRules ? normalizeRules(input.strategyRules) : null]);
  if (!cache.has(key)) {
    if (cache.size > 20) cache.clear();
    cache.set(key, activeStrategyEV(input));
  }
  return cache.get(key);
}
