// Intelligentes Spielarchiv (Phase 8.4): Strategieabweichungen je Runde, Lernfortschritt
// über die Zeit, wiederkehrende Fehler und Gewinn-/Verluststatistik.
// Alles nur aus gespeicherten Runden berechnet. Reine Logik -> testbar.
import { decisionEVs, MISTAKE_EV, MIN_SCORE } from '../yumeko/archive-analysis.js';
import { summarizeRounds, ACTION_TEXT } from './round-record.js';
import { decksText } from '../strategy/standard.js';

export const SOURCE_TEXT = { auto: 'Kamera (Live-Erkennung)', manual: 'Von Hand erfasst', import: 'Import', demo: 'Demo', unbekannt: 'Unbekannt' };

/** Unsicher erkannte Karten einer Runde (Erkennungswert unter der Schwelle). */
export function uncertainCards(rec) {
  const out = [];
  rec.dealer.cards.forEach((c, i) => { if (c.score != null && c.score < MIN_SCORE && !c.corrected) out.push({ where: 'dealer', index: i, rank: c.rank, score: c.score }); });
  rec.hands.forEach((h, hi) => h.cards.forEach((c, i) => { if (c.score != null && c.score < MIN_SCORE && !c.corrected) out.push({ where: `hand${hi}`, index: i, rank: c.rank, score: c.score }); }));
  return out;
}

/**
 * Entscheidungen einer Runde mit Empfehlung und Rechenmodell vergleichen.
 * @returns {Array<{ hand, action, recommended, best, loss, deviatesFromAdvice, mathMistake, situation }>}
 */
export function roundDecisions(rec) {
  const up = rec.dealer.cards[0];
  const out = [];
  rec.hands.forEach((h, hi) => {
    for (const a of h.actions) {
      if (a.legacy || a.action === 'SURRENDER') continue;
      const d = up ? decisionEVs(a.cardsBefore, up.rank, rec.rules, h.split && a.action !== 'SPLIT') : null;
      const loss = d && d.evs[a.action] != null ? d.evs[d.best] - d.evs[a.action] : null;
      out.push({
        hand: hi,
        action: a.action,
        inferred: !!a.inferred,
        recommended: a.recommended || null,
        best: d ? d.best : null,
        loss,
        deviatesFromAdvice: !!(a.recommended && a.recommended !== a.action),
        mathMistake: loss != null && loss > MISTAKE_EV,
        situation: d ? situationLabel(d) : null,
        cardsBefore: a.cardsBefore
      });
    }
  });
  return out;
}

function situationLabel(d) {
  const up = d.up === 11 ? 'Ass' : String(d.up);
  if (d.kind === 'pair') return `Paar ${d.value === 11 ? 'Asse' : d.value} gegen ${up}`;
  return `${d.kind === 'soft' ? 'Weich' : 'Hart'} ${d.t}${d.count > 2 ? ` (${d.count} Karten)` : ''} gegen ${up}`;
}

/** Kurzfassung je Runde für die Archivliste. */
export function roundInsight(rec) {
  const ds = roundDecisions(rec);
  return {
    decisions: ds.length,
    deviations: ds.filter((d) => d.deviatesFromAdvice).length,
    mathMistakes: ds.filter((d) => d.mathMistake).length,
    evLoss: ds.reduce((a, d) => a + (d.mathMistake ? d.loss : 0), 0),
    uncertain: uncertainCards(rec).length,
    reported: !!(rec.recognition && rec.recognition.reported),
    source: SOURCE_TEXT[rec.source] || rec.source,
    decks: decksText(rec.rules)
  };
}

/**
 * Lernfortschritt: Entscheidungen in zeitlicher Reihenfolge, in Blöcken ausgewertet.
 * @returns {{ blocks: Array<{ from, to, decisions, mistakes, rate, evLoss }>, trend: number|null, decisions }}
 */
export function learningProgress(rounds, { blockSize = 20 } = {}) {
  const list = [...rounds].filter((r) => r.status !== 'incomplete').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const all = [];
  for (const r of list) for (const d of roundDecisions(r)) if (d.loss != null && !d.inferred) all.push({ at: r.startedAt, ...d });
  const blocks = [];
  for (let i = 0; i < all.length; i += blockSize) {
    const part = all.slice(i, i + blockSize);
    const mistakes = part.filter((d) => d.mathMistake).length;
    blocks.push({ from: part[0].at, to: part[part.length - 1].at, decisions: part.length, mistakes, rate: mistakes / part.length, evLoss: part.reduce((a, d) => a + (d.mathMistake ? d.loss : 0), 0) });
  }
  const full = blocks.filter((b) => b.decisions >= Math.min(blockSize, 5));
  const trend = full.length >= 2 ? full[full.length - 1].rate - full[0].rate : null;
  return { blocks, trend, decisions: all.length, blockSize };
}

/** Wiederkehrende Fehler: gleiche Situation, gleiche falsche Aktion, mindestens minCount-mal. */
export function recurringMistakes(rounds, { minCount = 2 } = {}) {
  const map = new Map();
  for (const r of rounds) {
    if (r.status === 'incomplete') continue;
    for (const d of roundDecisions(r)) {
      if (!d.mathMistake || d.inferred) continue;
      const k = `${d.situation}|${d.action}`;
      const e = map.get(k) || { situation: d.situation, action: d.action, best: d.best, count: 0, evLoss: 0, rounds: [] };
      e.count += 1;
      e.evLoss += d.loss;
      if (!e.rounds.includes(r.id)) e.rounds.push(r.id);
      map.set(k, e);
    }
  }
  return [...map.values()].filter((e) => e.count >= minCount).sort((a, b) => b.count - a.count || b.evLoss - a.evLoss)
    .map((e) => ({ ...e, text: `${e.situation}: ${ACTION_TEXT[e.action]} statt ${ACTION_TEXT[e.best]}` }));
}

/** Gewinn-/Verluststatistik, auch getrennt nach Quelle und Deckangabe. */
export function resultStats(rounds) {
  const total = summarizeRounds(rounds);
  const group = (keyFn) => {
    const m = new Map();
    for (const r of rounds) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].map(([k, rs]) => ({ key: k, ...summarizeRounds(rs) }));
  };
  return {
    total,
    bySource: group((r) => SOURCE_TEXT[r.source] || r.source),
    byDecks: group((r) => decksText(r.rules)),
    deviations: rounds.reduce((a, r) => a + roundInsight(r).deviations, 0),
    reported: rounds.filter((r) => r.recognition && r.recognition.reported).length
  };
}
