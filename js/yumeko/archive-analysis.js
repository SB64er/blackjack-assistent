// YUMEKO – Analyse des Spielarchivs.
// Trennt konsequent zwischen ENTSCHEIDUNGSQUALITÄT (Erwartungswert der gewählten
// Aktion im Rechenmodell, unabhängig vom Ausgang) und SPIELERGEBNIS (Gewinn/
// Verlust/Push, stark vom Zufall abhängig). Ein gewonnener Zug ist nicht
// automatisch richtig, ein verlorener nicht automatisch falsch.
// Alles ist deterministisch: gleiche Runden -> gleiches Ergebnis.
// Reine Logik (ohne DOM) -> testbar.
import { rankValue } from '../game/hand.js';
import { addCard, modelFor, strategyEV } from '../strategy/ev.js';
import { normalizeRules, rulesText, cellKey } from '../strategy/standard.js';

export const ANALYSIS_VERSION = 1;
export const MIN_SCORE = 0.8;        // Karten darunter gelten als unsicher erkannt
export const MISTAKE_EV = 0.001;     // ab 0,1 % des Einsatzes gilt eine Abweichung als Fehler
export const MIN_N_PATTERN = 5;      // so viele Fälle braucht ein Ergebnis-Muster mindestens

const rulesKey = (r) => rulesText(r);

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

function meanCI(xs) {
  const n = xs.length;
  if (!n) return { n: 0, mean: null, se: null, ci95: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, se: null, ci95: null };
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, se, ci95: [mean - 1.96 * se, mean + 1.96 * se] };
}

function situationText(d) {
  const up = d.up === 11 ? 'Ass' : String(d.up);
  if (d.kind === 'pair') return `Paar ${d.value === 11 ? 'Asse' : d.value} gegen ${up}`;
  return `${d.kind === 'soft' ? 'Weich' : 'Hart'} ${d.t}${d.count > 2 ? ` (${d.count} Karten)` : ''} gegen ${up}`;
}

/**
 * @param {Array} rounds – Archiv-Einträge (validateRound)
 * @returns Bericht mit Datenqualität, Ergebnissen, Entscheidungen, Fehlern, Mustern
 */
export function analyzeArchive(rounds, { generatedAt = new Date().toISOString() } = {}) {
  const report = {
    version: ANALYSIS_VERSION,
    generatedAt,
    roundsTotal: rounds.length,
    roundIds: [],
    roundsUsed: 0,
    handsUsed: 0,
    decisionsUsed: 0,
    excluded: { incomplete: 0, lowConfidence: 0, noDealer: 0 },
    quality: null,
    outcomes: null,
    decisionQuality: null,
    situations: [],
    mistakes: [],
    inconsistent: [],
    patterns: [],
    luck: { correctLost: 0, correctWon: 0, wrongWon: 0, wrongLost: 0 },
    recognition: { perRank: {}, corrected: 0 },
    byRules: {}
  };

  const situations = new Map();
  const nets = [];
  let manual = 0;
  let unsureFrames = 0;
  let frames = 0;
  const scores = [];

  for (const rec of [...rounds].sort((a, b) => a.id.localeCompare(b.id))) {
    report.roundIds.push(rec.id);
    if (rec.confirmation === 'manual') manual += 1;
    if (rec.recognition) {
      frames += rec.recognition.frames || 0;
      unsureFrames += rec.recognition.unsureFrames || 0;
      if (rec.recognition.minScore != null) scores.push(rec.recognition.minScore);
    }
    for (const c of rec.corrections || []) {
      for (const ch of c.changes || []) {
        if (ch.from && ch.to && ch.from !== ch.to) {
          report.recognition.corrected += 1;
          const pr = report.recognition.perRank[ch.from] || (report.recognition.perRank[ch.from] = { corrected: 0, to: {} });
          pr.corrected += 1;
          pr.to[ch.to] = (pr.to[ch.to] || 0) + 1;
        }
      }
    }
    if (rec.status === 'incomplete') { report.excluded.incomplete += 1; continue; }
    const up = rec.dealer.cards[0];
    if (!up) { report.excluded.noDealer += 1; continue; }
    const low = rec.confirmation !== 'manual' && rec.recognition && rec.recognition.minScore != null && rec.recognition.minScore < MIN_SCORE;
    if (low) { report.excluded.lowConfidence += 1; continue; }

    report.roundsUsed += 1;
    const rk = rulesKey(rec.rules);
    const br = report.byRules[rk] || (report.byRules[rk] = { rules: rec.rules, rounds: 0, hands: 0 });
    br.rounds += 1;

    for (const h of rec.hands) {
      report.handsUsed += 1;
      br.hands += 1;
      if (h.net != null) nets.push(h.net);
      for (const a of h.actions) {
        if (a.legacy || a.action === 'SURRENDER') continue; // alte Aktion: nur lesbar
        const d = decisionEVs(a.cardsBefore, up.rank, rec.rules, h.split && a.action !== 'SPLIT');
        if (!d || d.evs[a.action] == null) continue;
        report.decisionsUsed += 1;
        const loss = d.evs[d.best] - d.evs[a.action];
        const sk = `${rk}|${d.key}`;
        let st = situations.get(sk);
        if (!st) {
          st = { id: sk, key: d.key, rulesKey: rk, rules: rec.rules, text: situationText(d), kind: d.kind, value: d.value, up: d.up, count: d.count, evs: d.evs, best: d.best, n: 0, actions: {}, evLoss: 0, outcomes: { win: 0, loss: 0, push: 0, open: 0 }, nets: [], rounds: [] };
          situations.set(sk, st);
        }
        st.n += 1;
        st.actions[a.action] = (st.actions[a.action] || 0) + 1;
        st.evLoss += loss;
        st.outcomes[h.outcome || 'open'] = (st.outcomes[h.outcome || 'open'] || 0) + 1;
        if (h.net != null) st.nets.push(h.net);
        if (!st.rounds.includes(rec.id)) st.rounds.push(rec.id);
        // Glück vs. Können
        const correct = loss < MISTAKE_EV;
        if (h.outcome === 'win') { if (correct) report.luck.correctWon += 1; else report.luck.wrongWon += 1; }
        if (h.outcome === 'loss') { if (correct) report.luck.correctLost += 1; else report.luck.wrongLost += 1; }
      }
    }
  }

  // Datenqualität
  const total = rounds.length;
  const usedShare = total ? report.roundsUsed / total : 0;
  const reasons = [];
  if (total < 30) reasons.push(`Erst ${total} Runden im Archiv – für Aussagen über Ergebnisse sind Hunderte bis Tausende nötig.`);
  if (report.excluded.incomplete) reasons.push(`${report.excluded.incomplete} unvollständige Runden wurden nicht ausgewertet (Ergebnis bestätigen, um sie einzubeziehen).`);
  if (report.excluded.lowConfidence) reasons.push(`${report.excluded.lowConfidence} Runden mit unsicherer Kartenerkennung (unter ${Math.round(MIN_SCORE * 100)} %) wurden ausgeschlossen.`);
  if (report.recognition.corrected) reasons.push(`${report.recognition.corrected} Karten wurden von Hand korrigiert.`);
  report.quality = {
    usedShare,
    manualShare: total ? manual / total : 0,
    unsureFrameShare: frames ? unsureFrames / frames : null,
    avgMinScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    level: total >= 300 && usedShare >= 0.8 ? 'hoch' : (total >= 30 && usedShare >= 0.6 ? 'mittel' : 'niedrig'),
    reasons
  };

  // Ergebnisse (Zufall!) mit Unsicherheit
  const o = meanCI(nets);
  let expected = null;
  const rk0 = Object.keys(report.byRules)[0];
  if (rk0 && Object.keys(report.byRules).length === 1) expected = strategyEV(report.byRules[rk0].rules).ev;
  report.outcomes = {
    hands: nets.length,
    net: nets.reduce((a, b) => a + b, 0),
    meanPerHand: o.mean,
    ci95: o.ci95,
    expectedPerHand: expected,
    significant: o.ci95 && expected != null ? (expected < o.ci95[0] || expected > o.ci95[1]) && o.n >= 100 : false,
    note: o.n < 100 ? 'Zu wenige Hände: Das Ergebnis ist vor allem Zufall und sagt nichts über die Strategie aus.' : 'Das 95-%-Intervall zeigt, wie stark der Zufall das Ergebnis beeinflusst.'
  };

  // Situationen, Fehler, Inkonsistenzen, Muster
  const list = [...situations.values()].map((s) => {
    const r = meanCI(s.nets);
    const { nets: _, ...rest } = s;
    return { ...rest, meanNet: r.mean, ci95: r.ci95, nNet: r.n };
  }).sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  report.situations = list;
  report.decisionQuality = {
    decisions: report.decisionsUsed,
    evLossTotal: list.reduce((a, s) => a + s.evLoss, 0),
    mistakes: list.reduce((a, s) => a + Object.entries(s.actions).filter(([act]) => s.evs[s.best] - s.evs[act] >= MISTAKE_EV).reduce((x, [, c]) => x + c, 0), 0)
  };
  report.mistakes = list.flatMap((s) => Object.entries(s.actions)
    .filter(([act]) => s.evs[s.best] - s.evs[act] >= MISTAKE_EV)
    .map(([act, count]) => ({ situation: s.id, text: s.text, rulesKey: s.rulesKey, rules: s.rules, key: s.key, action: act, count, best: s.best, lossEach: s.evs[s.best] - s.evs[act], lossTotal: count * (s.evs[s.best] - s.evs[act]), rounds: s.rounds })))
    .sort((a, b) => b.lossTotal - a.lossTotal || a.situation.localeCompare(b.situation));
  report.inconsistent = list.filter((s) => Object.keys(s.actions).length > 1)
    .map((s) => ({ situation: s.id, text: s.text, rulesKey: s.rulesKey, actions: s.actions, best: s.best, rounds: s.rounds }));
  // Ergebnis-Muster: nur Hinweise (Hypothesen), nie Strategieänderungen.
  report.patterns = list.filter((s) => s.nNet >= MIN_N_PATTERN && s.ci95).map((s) => {
    const main = Object.entries(s.actions).sort((a, b) => b[1] - a[1])[0][0];
    const exp = s.evs[main];
    const outside = exp < s.ci95[0] || exp > s.ci95[1];
    return { situation: s.id, text: s.text, rulesKey: s.rulesKey, n: s.nNet, meanNet: s.meanNet, ci95: s.ci95, expected: exp, action: main, outside, rounds: s.rounds };
  }).filter((p) => p.outside);
  return report;
}
