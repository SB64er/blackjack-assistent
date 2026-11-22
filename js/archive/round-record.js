// Archiv-Einträge (Spielrunden): Prüfen, Neuberechnen, Suchen, Zusammenfassen.
// Reine Logik (ohne DOM) -> testbar.
import { RANKS } from '../game/hand.js';
import { totals, settleHand, dealerFinal, netResult, OUTCOMES } from '../game/settle.js';
import { normalizeRules } from '../strategy/standard.js';
import { computedPayout } from '../risk/bankroll.js';

// Schema 2 (0.7.0): Geldbeträge getrennt von Einsatz-Einheiten.
//   hand.net       – Ergebnis in Einsatz-Einheiten (immer aus dem Ergebnis berechnet)
//   hand.bet       – tatsächlicher Einsatz in Geld (nur wenn eingegeben)
//   hand.extraBet  – Zusatzeinsatz bei Verdoppeln (Split: jede Hand hat ihren eigenen Einsatz)
//   hand.payout    – tatsächliche Auszahlung inkl. Einsatz (eingegeben oder aus Einsatz+Ergebnis berechnet)
//   hand.moneyNet  – payout − bet − extraBet
//   round.money    – { currency, balanceBefore, balanceAfter, ledgerId } aus dem Echtgeld-Protokoll
export const RECORD_SCHEMA = 2;
// Aktionen ab 0.6.0. "SURRENDER" kann in alten/importierten Daten vorkommen und
// bleibt lesbar, wird aber nie mehr empfohlen oder neu erfasst.
export const ACTIONS_NOW = ['HIT', 'STAND', 'DOUBLE', 'SPLIT'];
export const ACTIONS_READABLE = [...ACTIONS_NOW, 'SURRENDER'];
export const ACTION_TEXT = { HIT: 'Ziehen', STAND: 'Stehen', DOUBLE: 'Verdoppeln', SPLIT: 'Splitten', SURRENDER: 'Aufgeben (alt)' };
export const STATUS_TEXT = { complete: 'Vollständig (automatisch)', confirmed: 'Manuell bestätigt', incomplete: 'Unvollständig' };

const isRank = (r) => RANKS.includes(r);
const iso = (s, fb) => (typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? s : fb);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const amount = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x * 100) / 100 : null);

function cleanCards(list) {
  return (Array.isArray(list) ? list : []).filter((c) => c && isRank(c.rank)).map((c) => ({
    rank: c.rank, score: num(c.score), at: c.at ?? null, ...(c.role ? { role: c.role } : {}), ...(c.corrected ? { corrected: true } : {})
  }));
}

/** Eintrag prüfen (Import, Laden). Liefert bereinigten Eintrag oder null. */
export function validateRound(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(r.id)) return null;
  const startedAt = iso(r.startedAt, null);
  if (!startedAt) return null;
  const handsIn = Array.isArray(r.hands) ? r.hands : [];
  if (!handsIn.length) return null;
  const oldSchema = !(r.schema >= 2);
  const hands = handsIn.slice(0, 4).map((h, i) => ({
    index: i,
    split: !!h.split,
    cards: cleanCards(h.cards),
    actions: (Array.isArray(h.actions) ? h.actions : []).filter((a) => a && ACTIONS_READABLE.includes(a.action)).map((a) => ({
      action: a.action, at: a.at ?? null, inferred: !!a.inferred,
      cardsBefore: Array.isArray(a.cardsBefore) ? a.cardsBefore.filter(isRank) : [],
      recommended: ACTIONS_READABLE.includes(a.recommended) ? a.recommended : null,
      ...(a.legacy ? { legacy: true } : {})
    })),
    initialAdvice: ACTIONS_READABLE.includes(h.initialAdvice) ? h.initialAdvice : null,
    total: num(h.total),
    outcome: OUTCOMES.includes(h.outcome) || h.outcome === 'surrender' ? h.outcome : null,
    outcomeReason: typeof h.outcomeReason === 'string' ? h.outcomeReason.slice(0, 200) : null,
    outcomeSource: h.outcomeSource === 'manual' || h.outcomeSource === 'auto' ? h.outcomeSource : null,
    blackjack: !!h.blackjack,
    doubled: !!h.doubled,
    bet: amount(h.bet),
    extraBet: oldSchema ? null : amount(h.extraBet),
    // Bis 0.6.0 war "payout" kein echter Auszahlungsbetrag -> wird neu berechnet.
    payout: oldSchema ? null : amount(h.payout),
    payoutSource: !oldSchema && (h.payoutSource === 'manual' || h.payoutSource === 'computed') ? h.payoutSource : null,
    moneyNet: oldSchema ? null : num(h.moneyNet),
    net: num(h.net)
  }));
  const dealerIn = r.dealer && typeof r.dealer === 'object' ? r.dealer : {};
  return {
    schema: RECORD_SCHEMA,
    id: r.id,
    startedAt,
    endedAt: iso(r.endedAt, startedAt),
    updatedAt: iso(r.updatedAt, iso(r.endedAt, startedAt)),
    source: typeof r.source === 'string' ? r.source.slice(0, 20) : 'unbekannt',
    rules: normalizeRules(r.rules),
    profile: r.profile && typeof r.profile === 'object' ? { id: String(r.profile.id || ''), name: String(r.profile.name || '').slice(0, 60), type: String(r.profile.type || ''), ...(r.profile.version != null ? { version: r.profile.version } : {}) } : null,
    dealer: { cards: cleanCards(dealerIn.cards), total: num(dealerIn.total), final: !!dealerIn.final },
    hands,
    status: ['complete', 'confirmed', 'incomplete'].includes(r.status) ? r.status : 'incomplete',
    confirmation: r.confirmation === 'manual' ? 'manual' : 'auto',
    recognition: r.recognition && typeof r.recognition === 'object' ? {
      frames: num(r.recognition.frames), unsureFrames: num(r.recognition.unsureFrames),
      minScore: num(r.recognition.minScore), avgScore: num(r.recognition.avgScore)
    } : null,
    corrections: Array.isArray(r.corrections) ? r.corrections.slice(-50) : [],
    money: r.money && typeof r.money === 'object' ? {
      currency: typeof r.money.currency === 'string' ? r.money.currency.slice(0, 4) : 'CHF',
      balanceBefore: num(r.money.balanceBefore),
      balanceAfter: num(r.money.balanceAfter),
      ledgerId: typeof r.money.ledgerId === 'string' ? r.money.ledgerId : null
    } : null,
    ...(oldSchema ? { migratedFrom: r.schema || 1 } : (r.migratedFrom ? { migratedFrom: r.migratedFrom } : {})),
    notes: typeof r.notes === 'string' ? r.notes.slice(0, 1000) : ''
  };
}

/**
 * Nach einer Korrektur neu berechnen: Summen, automatisch bestimmte Ergebnisse,
 * Nettoergebnis und Status. Manuell gesetzte Ergebnisse bleiben unverändert.
 */
export function recomputeRound(rec) {
  const r = rec.rules;
  const dealer = rec.dealer.cards;
  rec.dealer.total = dealer.length ? totals(dealer).total : null;
  rec.dealer.final = dealerFinal(dealer, r);
  for (const h of rec.hands) {
    h.total = h.cards.length ? totals(h.cards).total : null;
    if (h.outcomeSource !== 'manual') {
      const s = settleHand(h, dealer, r);
      h.outcome = s.outcome;
      h.outcomeReason = s.reason;
      h.outcomeSource = s.outcome ? 'auto' : null;
      h.blackjack = !!s.blackjack;
    }
    h.doubled = h.doubled || h.actions.some((a) => a.action === 'DOUBLE');
    // Einsatz-Einheiten (immer)
    h.net = h.outcome === 'surrender' ? -0.5 : netResult(h.outcome, { bet: 1, doubled: h.doubled, blackjack: h.blackjack, rules: r });
    // Geld (nur mit eingegebenem Einsatz; nichts wird erfunden)
    if (h.bet != null) {
      if (h.extraBet == null && h.doubled) h.extraBet = h.bet;
      if (h.payoutSource !== 'manual') {
        const p = h.outcome === 'surrender' ? Math.round(h.bet * 50) / 100 : computedPayout({ outcome: h.outcome, stake: h.bet, extra: h.extraBet || 0, blackjack: h.blackjack, payoutRule: r.payout });
        h.payout = p;
        h.payoutSource = p != null ? 'computed' : null;
      }
      h.moneyNet = h.payout != null ? Math.round((h.payout - h.bet - (h.extraBet || 0)) * 100) / 100 : null;
    } else {
      if (h.payoutSource !== 'manual') { h.payout = null; h.payoutSource = null; }
      h.extraBet = null;
      h.moneyNet = null;
    }
  }
  const allKnown = rec.hands.every((h) => h.outcome) && rec.hands[0].cards.length >= 2;
  if (!allKnown) rec.status = 'incomplete';
  else rec.status = rec.confirmation === 'manual' || rec.hands.some((h) => h.outcomeSource === 'manual') ? 'confirmed' : 'complete';
  return rec;
}

/** Gesamtergebnis einer Runde (für Filter): win, loss, push, mixed, open. */
export function roundOutcome(rec) {
  const o = rec.hands.map((h) => h.outcome);
  if (o.some((x) => !x)) return 'open';
  const net = rec.hands.reduce((a, h) => a + (h.net ?? 0), 0);
  if (o.every((x) => x === 'push')) return 'push';
  if (net > 0) return 'win';
  if (net < 0) return 'loss';
  return o.length > 1 ? 'mixed' : 'push';
}

const cardsText = (list) => list.map((c) => c.rank).join(' ');

/** Suchen und filtern. filter.outcome: 'all'|'win'|'loss'|'push'|'open'; text: Freitext. */
export function filterRounds(rounds, { text = '', outcome = 'all' } = {}) {
  const q = text.trim().toLowerCase();
  return rounds.filter((r) => {
    if (outcome !== 'all' && roundOutcome(r) !== outcome) return false;
    if (!q) return true;
    const hay = [
      r.id, r.startedAt.slice(0, 10), r.profile ? r.profile.name : '', r.notes,
      `dealer ${cardsText(r.dealer.cards)}`, ...r.hands.map((h) => `hand ${cardsText(h.cards)} ${h.total ?? ''}`),
      STATUS_TEXT[r.status] || ''
    ].join(' ').toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
}

/** Zahlen für Übersicht (nur aus echten Einträgen). */
export function summarizeRounds(rounds) {
  const s = { rounds: rounds.length, hands: 0, win: 0, loss: 0, push: 0, open: 0, incomplete: 0, net: 0, netHands: 0, moneyHands: 0, staked: 0, moneyNet: 0 };
  for (const r of rounds) {
    if (r.status === 'incomplete') s.incomplete += 1;
    for (const h of r.hands) {
      s.hands += 1;
      if (h.outcome === 'win') s.win += 1;
      else if (h.outcome === 'loss' || h.outcome === 'surrender') s.loss += 1;
      else if (h.outcome === 'push') s.push += 1;
      else s.open += 1;
      if (h.net != null) { s.net += h.net; s.netHands += 1; }
      if (h.bet != null && h.moneyNet != null) { s.moneyHands += 1; s.staked += h.bet + (h.extraBet || 0); s.moneyNet += h.moneyNet; }
    }
  }
  return s;
}
