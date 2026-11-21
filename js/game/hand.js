// Kartenwerte und Handbeschreibung nach Blackjack-Regeln.

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export const RANK_NAMES = {
  A: 'Ass', J: 'Bube', Q: 'Dame', K: 'König'
};

// Blackjack-Wert einer Karte (Ass = 11, wird bei Bedarf zu 1).
export function rankValue(rank) {
  if (rank === 'A') return 11;
  if (rank === 'J' || rank === 'Q' || rank === 'K' || rank === '10') return 10;
  const n = Number(rank);
  return Number.isFinite(n) ? n : 0;
}

// Wertklasse: 10/J/Q/K sind gleichwertig (Verwechslung ist unschädlich).
export function valueClass(rank) {
  const v = rankValue(rank);
  return v === 11 ? 'A' : String(v);
}

export function handInfo(cards) {
  const list = (cards || []).filter(Boolean);
  if (list.length === 0) return { total: null, soft: false, pair: false, blackjack: false, bust: false, text: '' };
  if (list.some((c) => c.confident === false)) return { total: null, soft: false, pair: false, blackjack: false, bust: false, text: '' };
  let total = 0;
  let aces = 0;
  for (const c of list) {
    if (c.rank === 'A') aces += 1;
    total += rankValue(c.rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  const soft = aces > 0 && total <= 21;
  const pair = list.length === 2 && valueClass(list[0].rank) === valueClass(list[1].rank);
  const blackjack = list.length === 2 && total === 21;
  const bust = total > 21;
  let text;
  if (blackjack) text = 'Blackjack';
  else if (bust) text = `Überkauft (${total})`;
  else if (pair) text = list[0].rank === 'A' ? 'Paar Asse' : `Paar ${rankValue(list[0].rank)}`;
  else text = `${soft ? 'Soft' : 'Hart'} ${total}`;
  return { total, soft, pair, blackjack, bust, text };
}

export function upcardLabel(card) {
  if (!card || card.confident === false) return '–';
  if (card.rank === 'A') return '1/11';
  return String(rankValue(card.rank));
}
