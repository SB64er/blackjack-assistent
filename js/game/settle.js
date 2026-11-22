// Ergebnis einer Hand bestimmen – nur wenn es aus den Karten ZUVERLÄSSIG folgt.
// Sonst null mit Grund (die Runde wird dann als unvollständig gespeichert und
// kann manuell bestätigt werden). Reine Logik (ohne DOM) -> testbar.
import { rankValue } from './hand.js';
import { normalizeRules } from '../strategy/standard.js';

export const OUTCOMES = ['win', 'loss', 'push'];
export const OUTCOME_LABEL = { win: 'Gewonnen', loss: 'Verloren', push: 'Push' };

export function totals(cards) {
  let t = 0;
  let aces = 0;
  for (const c of cards) {
    const v = rankValue(c.rank);
    t += v;
    if (v === 11) aces += 1;
  }
  while (t > 21 && aces > 0) { t -= 10; aces -= 1; }
  return { total: t, soft: aces > 0, bust: t > 21, blackjack: cards.length === 2 && t === 21 };
}

/** Steht der Dealer endgültig (nach den Regeln)? */
export function dealerFinal(cards, rules) {
  if (cards.length < 2) return false;
  const r = normalizeRules(rules);
  const d = totals(cards);
  if (d.bust) return true;
  if (d.total > 17) return true;
  if (d.total === 17) return !(d.soft && r.soft17 === 'zieht');
  return false;
}

/**
 * @param {{ cards, split?: boolean }} hand
 * @param {Array} dealer – Dealerkarten in Reihenfolge (offene zuerst)
 * @returns {{ outcome: 'win'|'loss'|'push'|null, reason, blackjack? }}
 */
export function settleHand(hand, dealer, rules) {
  const cards = hand.cards || [];
  if (cards.length < 2) return { outcome: null, reason: 'Hand hat weniger als zwei Karten.' };
  const p = totals(cards);
  if (p.bust) return { outcome: 'loss', reason: 'Überkauft' };
  const natural = p.blackjack && !hand.split;
  const d = dealer.length ? totals(dealer) : null;
  const upV = dealer.length ? rankValue(dealer[0].rank) : 0;

  if (natural) {
    if (dealer.length >= 2) return d.blackjack ? { outcome: 'push', reason: 'Beide Blackjack' } : { outcome: 'win', reason: 'Blackjack', blackjack: true };
    if (dealer.length === 1 && upV !== 10 && upV !== 11) return { outcome: 'win', reason: 'Blackjack (Dealer kann keinen Blackjack haben)', blackjack: true };
    return { outcome: null, reason: 'Blackjack – zweite Dealerkarte nicht erkannt.' };
  }
  if (!d) return { outcome: null, reason: 'Keine Dealerkarte erkannt.' };
  if (dealer.length >= 2 && d.blackjack) return { outcome: 'loss', reason: 'Dealer hat Blackjack' };
  if (!dealerFinal(dealer, rules)) return { outcome: null, reason: 'Endstand des Dealers nicht erkannt.' };
  if (d.bust) return { outcome: 'win', reason: 'Dealer überkauft' };
  if (p.total > d.total) return { outcome: 'win', reason: `${p.total} gegen ${d.total}` };
  if (p.total < d.total) return { outcome: 'loss', reason: `${p.total} gegen ${d.total}` };
  return { outcome: 'push', reason: `${p.total} gegen ${d.total}` };
}

/** Nettoergebnis in Einsatzeinheiten bzw. Geld (wenn bet angegeben). */
export function netResult(outcome, { bet = 1, doubled = false, blackjack = false, rules } = {}) {
  if (!outcome || !(bet >= 0)) return null;
  const r = normalizeRules(rules);
  const stake = bet * (doubled ? 2 : 1);
  if (outcome === 'push') return 0;
  if (outcome === 'loss') return -stake;
  if (blackjack) return bet * (r.payout === '6:5' ? 1.2 : 1.5);
  return stake;
}
