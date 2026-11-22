// Strategie-Engine: Empfehlung für eine Hand gegen die offene Dealerkarte.
// - Profilabhängig (Tabellen-Abweichungen des aktiven Profils)
// - Tischregeln bestimmen, welche Aktionen erlaubt sind
// - Ungültige Aktionen werden ausgeschlossen (z. B. Verdoppeln mit 3 Karten)
// - Fehlt eine Profilzelle oder ist sie ungültig: Rückfall auf die Standardstrategie
// Reine Logik (ohne DOM) -> testbar.
import { rankValue } from '../game/hand.js';
import { standardCode, cellKey, CODES_BY_KIND, normalizeRules, modernCode } from './standard.js';

// Ab 0.6.0 ohne Aufgeben (Surrender).
export const ACTIONS = Object.freeze({
  HIT: 'HIT', STAND: 'STAND', DOUBLE: 'DOUBLE', SPLIT: 'SPLIT'
});

// Anzeige (Schlüssel wie in demo/scenarios.js RECOMMENDATIONS)
export const ACTION_TO_RECOMMENDATION = {
  HIT: 'ZIEHEN', STAND: 'STEHEN', DOUBLE: 'VERDOPPELN', SPLIT: 'SPLITTEN'
};
export const ACTION_LABEL = { HIT: 'Ziehen', STAND: 'Stehen', DOUBLE: 'Verdoppeln', SPLIT: 'Splitten' };

/** Hand einordnen: hart/weich/Paar, Gesamtwert. cards: [{rank}] */
export function classify(cards) {
  const vals = cards.map((c) => rankValue(c.rank));
  let total = 0;
  let aces = 0;
  for (const v of vals) { total += v; if (v === 11) aces += 1; }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  const soft = aces > 0;
  const pair = cards.length === 2 && vals[0] === vals[1];
  return { total, soft, pair, pairValue: pair ? vals[0] : null, count: cards.length, bust: total > 21, blackjack: cards.length === 2 && total === 21 };
}

export function upValue(card) {
  const v = rankValue(card && card.rank);
  return v >= 2 && v <= 11 ? v : null;
}

/** Code einer Zelle: Profil (falls gültig) oder Standard. */
export function cellCode(kind, value, up, { rules, overrides = null } = {}) {
  const key = cellKey(kind, value, up);
  const std = standardCode(kind, value, up, rules);
  const own = overrides && overrides[key] != null ? modernCode(overrides[key]) : null;
  if (own != null) {
    if (CODES_BY_KIND[kind].includes(own)) return { code: own, source: 'profile', key, standard: std };
    return { code: std, source: 'fallback', key, standard: std, invalid: own };
  }
  return { code: std, source: 'standard', key, standard: std };
}

/**
 * Code in eine erlaubte Aktion auflösen.
 * allowed: { double, split, das }
 * Alte Codes mit Aufgeben (Rh/Rs/Rp aus 0.5.0) werden ohne Aufgeben aufgelöst.
 * Gibt null zurück, wenn die Zelle "wie Gesamtwert ohne Split" behandelt werden muss.
 */
export function resolveCode(code, allowed) {
  switch (code) {
    case 'H': return ACTIONS.HIT;
    case 'S': return ACTIONS.STAND;
    case 'D': return allowed.double ? ACTIONS.DOUBLE : ACTIONS.HIT;
    case 'Ds': return allowed.double ? ACTIONS.DOUBLE : ACTIONS.STAND;
    case 'P': return allowed.split ? ACTIONS.SPLIT : null;
    case 'Ph': return allowed.split && allowed.das ? ACTIONS.SPLIT : null;
    case 'Rh': return ACTIONS.HIT;
    case 'Rs': return ACTIONS.STAND;
    case 'Rp': return allowed.split ? ACTIONS.SPLIT : null;
    default: return null;
  }
}

/**
 * Empfehlung.
 * @param {Array} cards – Spielerkarten [{rank}]
 * @param {{rank}} dealerUp
 * @param {{ rules, overrides?, afterSplit? }} opts
 *   rules: Tischregeln (bestimmen, welche Aktionen erlaubt sind)
 *   overrides: Zellen des aktiven Profils ({ 'hard:16:10': 'S', … })
 *   strategyRules: Regeln, für die die Standardtabelle berechnet wird (Profilregeln);
 *                  Standard: rules
 * @returns {{ action, code, source, key, kind, value, up, standardAction, reason } | { action: null, reason }}
 */
export function decide(cards, dealerUp, opts = {}) {
  const rules = normalizeRules(opts.rules);
  const strategyRules = normalizeRules(opts.strategyRules || rules);
  const list = (cards || []).filter(Boolean);
  if (list.length < 2) return { action: null, reason: 'zu-wenig-karten' };
  if (list.some((c) => c.confident === false || !rankValue(c.rank))) return { action: null, reason: 'unsicher' };
  const up = upValue(dealerUp);
  if (!up || (dealerUp && dealerUp.confident === false)) return { action: null, reason: 'keine-dealerkarte' };
  const info = classify(list);
  if (info.bust) return { action: null, reason: 'ueberkauft' };
  if (info.blackjack && !opts.afterSplit) return { action: null, reason: 'blackjack' };

  const afterSplit = !!opts.afterSplit;
  const two = list.length === 2;
  const allowed = {
    double: two && (!afterSplit || rules.das),
    split: info.pair && !afterSplit,               // erneutes Splitten wird nicht empfohlen
    das: rules.das
  };

  const evaluate = (kind, value) => {
    const c = cellCode(kind, value, up, { rules: strategyRules, overrides: opts.overrides });
    const stdAction = resolveCode(c.standard, allowed);
    return { ...c, action: resolveCode(c.code, allowed), stdAction, kind, value };
  };

  let r = null;
  if (info.pair) {
    r = evaluate('pair', info.pairValue);
    if (!r.action) r = null; // nicht splitten -> wie Gesamtwert
  }
  if (!r) {
    const kind = info.soft && info.total >= 13 ? 'soft' : 'hard';
    const value = kind === 'hard' ? Math.max(5, info.total) : info.total;
    r = info.soft && info.total <= 12
      ? { code: 'H', source: 'standard', key: 'soft:12', standard: 'H', action: ACTIONS.HIT, stdAction: ACTIONS.HIT, kind: 'soft', value: 12 }
      : evaluate(kind, value);
  }

  // Standardaktion derselben Hand (für "weicht von Standard ab")
  let standardAction = r.stdAction;
  if (info.pair && r.kind === 'pair' && standardAction == null) {
    const kind = info.soft && info.total >= 13 ? 'soft' : 'hard';
    standardAction = info.soft && info.total <= 12 ? ACTIONS.HIT : resolveCode(standardCode(kind, Math.max(5, info.total), up, strategyRules), allowed);
  }
  if (r.kind !== 'pair' && info.pair) {
    // Profil sagt "nicht splitten": Standard für das Paar prüfen
    const stdPair = resolveCode(standardCode('pair', info.pairValue, up, strategyRules), allowed);
    if (stdPair) standardAction = stdPair;
  }

  return {
    action: r.action,
    code: r.code,
    source: r.source,
    key: r.key,
    kind: r.kind,
    value: r.value,
    up,
    standardAction,
    deviates: standardAction != null && standardAction !== r.action,
    invalidCell: r.invalid || null,
    hand: info
  };
}
