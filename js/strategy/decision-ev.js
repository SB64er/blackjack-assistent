// Erwartungswerte einer einzelnen Spielentscheidung im Rechenmodell.
// Gemeinsam genutzt von Hauptansicht, Spielarchiv (Fehler laut Rechenmodell)
// und Strategieintelligenz. Bis 0.8.0 Teil von js/yumeko/archive-analysis.js;
// die frühere YUMEKO-Archivanalyse (Lernalgorithmus) ist ab 0.9.0 entfernt.
// Reine Logik (ohne DOM) -> testbar.
import { rankValue } from '../game/hand.js';
import { addCard, modelFor } from './ev.js';
import { normalizeRules, cellKey } from './standard.js';

export const MIN_SCORE = 0.8;        // Karten darunter gelten als unsicher erkannt
export const MISTAKE_EV = 0.001;     // ab 0,1 % des Einsatzes gilt eine Abweichung als Fehler

/** Lage einer Entscheidung: Handart, Wert, Dealerkarte, erlaubte Aktionen und deren Erwartungswerte. */
export function decisionEVs(cardsBefore, upRank, rules, afterSplit = false) {
  const r = normalizeRules(rules);
  const up = rankValue(upRank);
  if (!(up >= 2 && up <= 11) || !cardsBefore || cardsBefore.length < 2) return null;
  let t = 0;
  let s = 0;
  const vals = cardsBefore.map(rankValue);
  if (vals.some((v) => !(v >= 2 && v <= 11))) return null;
  for (const v of vals) [t, s] = addCard(t, s, v);
  if (t >= 21) return null;
  const m = modelFor(up, r);
  const count = vals.length;
  const pair = count === 2 && vals[0] === vals[1] && !afterSplit ? vals[0] : null;
  const evs = { STAND: m.stand(t), HIT: m.hit(t, s) };
  if (count === 2 && (!afterSplit || r.das)) evs.DOUBLE = m.double(t, s);
  if (pair) evs.SPLIT = m.split(pair);
  let best = null;
  for (const [a, v] of Object.entries(evs)) if (best == null || v > evs[best] + 1e-12) best = a;
  const kind = pair ? 'pair' : (s && t >= 13 ? 'soft' : 'hard');
  const value = pair || (kind === 'hard' ? Math.max(5, t) : t);
  return { kind, value, up, t, soft: !!s, count, afterSplit, evs, best, key: count === 2 ? cellKey(kind, value, up) : `${kind}:${value}:${up}:${count}k` };
}
