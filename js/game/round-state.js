// Zustand EINER laufenden Spielrunde aus der Live-Erkennung.
// - Ein gemeinsames Dealer-Feld: 1. bestätigte Karte = offene Karte,
//   2. Karte = zunächst verdeckt (unbekannt), bis sie wirklich erkannt wurde,
//   weitere Karten = gezogene Karten. Keine Karte wird doppelt gezählt.
// - Spielerhand und Split-Hand getrennt.
// - Aktionen werden aus neuen Karten abgeleitet (Ziehen, Splitten, Stehen) und mit
//   der Empfehlung zum jeweiligen Zeitpunkt protokolliert.
// - Rundenende: NICHT schon, wenn kurz keine Karten sichtbar sind.
// Reine Logik (ohne DOM) -> testbar.
import { CardTracker, publicCard } from './card-tracker.js';
import { valueClass } from './hand.js';
import { totals, settleHand, dealerFinal, netResult } from './settle.js';
import { normalizeRules } from '../strategy/standard.js';

export const ROUND_END_EMPTY_MS = 5000; // so lange muss der Tisch leer sein, bis die Runde endet

export function newRoundId(now = Date.now()) {
  return `r_${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export class RoundState {
  /**
   * @param {{ id?, startedAt?, source?, advise?: (cards, up, afterSplit) => ({action}|null),
   *           confirmFrames?, confirmFor? }} opts
   */
  constructor(opts = {}) {
    this.id = opts.id || newRoundId(opts.startedAt);
    this.startedAt = opts.startedAt ?? Date.now();
    this.source = opts.source || 'auto';
    this.advise = opts.advise || (() => null);
    const tOpts = { confirmFrames: opts.confirmFrames ?? 2, confirmFor: opts.confirmFor || null };
    this.dealer = new CardTracker(tOpts);
    this.player = new CardTracker(tOpts);
    this.splitT = new CardTracker(tOpts);
    this.hands = [{ index: 0, cards: [], actions: [], split: false, initialAdvice: null }];
    this.splitDone = false;
    this.frames = 0;
    this.unsureFrames = 0;
    this.emptySince = null;
    this.lastActivityAt = this.startedAt;
  }

  get up() {
    const c = this.dealer.confirmed()[0];
    return c ? publicCard(c) : null;
  }

  dealerCards() {
    return this.dealer.confirmed().map(publicCard);
  }

  _upCard() {
    const c = this.dealer.confirmed()[0];
    return c ? { rank: c.rank, confident: true } : null;
  }

  _log(hand, action, prevCards, at, inferred = true) {
    const up = this._upCard();
    const adv = up && prevCards.length >= 2 ? this.advise(prevCards, up, hand.split) : null;
    hand.actions.push({ action, at, inferred, cardsBefore: prevCards.map((c) => c.rank), recommended: adv ? adv.action : null });
  }

  /**
   * Stabile Auswertung einspeisen.
   * @param {{ dealer: [], player: [], split: [], unsure? }} result
   */
  update(result, now = Date.now()) {
    if (!result) return [];
    this.frames += 1;
    if (result.unsure) this.unsureFrames += 1;
    const empty = !(result.dealer || []).length && !(result.player || []).length && !(result.split || []).length;
    if (empty) {
      if (this.emptySince == null) this.emptySince = now;
      return [];
    }
    this.emptySince = null;
    const changes = [];

    for (const c of this.dealer.update(result.dealer || [], now)) {
      changes.push({ type: 'card', hand: 'dealer', card: publicCard(c) });
    }

    const main = this.hands[0];
    const before = main.cards.slice();
    const freshSplit = this.splitT.update(result.split || [], now);
    const freshMain = this.player.update(result.player || [], now);

    // Split: erste Karte in der Split-Hand, Hauptkarte war ein Paar.
    if (!this.splitDone && freshSplit.length && before.length === 2 && valueClass(before[0].rank) === valueClass(before[1].rank)) {
      this.splitDone = true;
      this._log(main, 'SPLIT', before, now);
      this.player.take(valueClass(before[1].rank)); // zweite Paarkarte gehört jetzt zur Split-Hand
      this.splitCard = { rank: before[1].rank, confident: true, score: before[1].score ?? null, at: now };
      this.hands.push({ index: 1, cards: [], actions: [], split: true, initialAdvice: null });
      main.split = true;
      changes.push({ type: 'split' });
    }

    main.cards = this.player.confirmed().map(publicCard);
    if (this.splitDone) {
      const second = this.hands[1];
      const prev2 = second.cards.slice();
      // Split-Hand: Karten aus Bereich C. Liegt die übernommene Paarkarte (noch) nicht
      // in C, wird sie vorne ergänzt – ohne Doppelzählung.
      const fromC = this.splitT.confirmed().map(publicCard);
      const pc = this.splitCard;
      second.cards = fromC.length && valueClass(fromC[0].rank) === valueClass(pc.rank) ? fromC : [pc, ...fromC];
      if (second.cards.length > prev2.length && prev2.length >= 2) this._log(second, 'HIT', prev2, now);
      if (second.cards.length > prev2.length) changes.push({ type: 'card', hand: 'split' });
    }
    if (freshMain.length) {
      for (const c of freshMain) changes.push({ type: 'card', hand: 'player', card: publicCard(c) });
      if (before.length >= 2 && main.cards.length > before.length && !(this.splitDone && main.cards.length <= 2)) {
        this._log(main, 'HIT', before, now);
      }
    }
    for (const h of this.hands) {
      if (!h.initialAdvice && h.cards.length === 2 && this._upCard()) {
        const adv = this.advise(h.cards, this._upCard(), h.split);
        h.initialAdvice = adv ? adv.action : null;
      }
    }
    if (changes.length) this.lastActivityAt = now;
    return changes;
  }

  /** Runde endet, wenn der Tisch lange genug leer ist. */
  endedByEmpty(now = Date.now(), ms = ROUND_END_EMPTY_MS) {
    return this.emptySince != null && now - this.emptySince >= ms && this.hasContent();
  }

  hasContent() {
    return this.dealer.confirmed().length > 0 || this.hands.some((h) => h.cards.length > 0);
  }

  /** Für die Anzeige. */
  snapshot() {
    const dealer = this.dealerCards();
    return {
      id: this.id,
      dealer,
      up: dealer[0] || null,
      holeKnown: dealer.length >= 2,
      extra: dealer.slice(2),
      hands: this.hands.map((h) => ({ cards: h.cards, split: h.split })),
      pending: this.dealer.pending().length + this.player.pending().length + this.splitT.pending().length,
      emptySince: this.emptySince
    };
  }

  /**
   * Archiv-Eintrag erstellen.
   * @param {{ endedAt, rules, profile }} meta
   */
  toRecord({ endedAt = Date.now(), rules, profile = null, recognition = 'auto' } = {}) {
    const r = normalizeRules(rules);
    const dealer = this.dealerCards();
    const hands = this.hands.map((h) => {
      const t = h.cards.length ? totals(h.cards) : null;
      const actions = h.actions.slice();
      // Stehen: Hand ist fertig, nicht überkauft, unter 21 – letzte Entscheidung.
      if (t && h.cards.length >= 2 && !t.bust && t.total < 21 && dealer.length >= 2) {
        const up = dealer[0];
        const adv = this.advise(h.cards, { rank: up.rank, confident: true }, h.split);
        actions.push({ action: 'STAND', at: endedAt, inferred: true, cardsBefore: h.cards.map((c) => c.rank), recommended: adv ? adv.action : null });
      }
      const s = settleHand(h, dealer, r);
      return {
        index: h.index,
        split: h.split,
        cards: h.cards.map((c) => ({ rank: c.rank, score: c.score ?? null, at: c.at ?? null })),
        actions,
        initialAdvice: h.initialAdvice,
        total: t ? t.total : null,
        outcome: s.outcome,
        outcomeReason: s.reason,
        outcomeSource: s.outcome ? 'auto' : null,
        blackjack: !!s.blackjack,
        doubled: false,
        bet: null,
        payout: null,
        net: s.outcome ? netResult(s.outcome, { blackjack: s.blackjack, rules: r }) : null
      };
    });
    const scores = [...dealer, ...hands.flatMap((h) => h.cards)].map((c) => c.score).filter((x) => typeof x === 'number');
    const complete = hands.every((h) => h.outcome) && hands[0].cards.length >= 2;
    return {
      schema: 1,
      id: this.id,
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      source: this.source,
      rules: r,
      profile,
      dealer: {
        cards: dealer.map((c, i) => ({ rank: c.rank, score: c.score ?? null, role: i === 0 ? 'up' : (i === 1 ? 'hole' : 'hit'), at: c.at ?? null })),
        total: dealer.length ? totals(dealer).total : null,
        final: dealerFinal(dealer, r)
      },
      hands,
      status: complete ? 'complete' : 'incomplete',
      confirmation: recognition, // 'auto' | 'manual'
      recognition: {
        frames: this.frames,
        unsureFrames: this.unsureFrames,
        minScore: scores.length ? Math.min(...scores) : null,
        avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null
      },
      corrections: [],
      notes: ''
    };
  }
}
