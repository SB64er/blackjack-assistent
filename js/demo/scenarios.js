// Simulierte Spielzustände für den Demo-Modus (Phase 1).
// Format entspricht dem späteren Ergebnis der Kartenerkennung, damit die
// Oberfläche ohne Änderungen auf echte Daten umgestellt werden kann.

const RED = new Set(['♥', '♦']);
const card = (rank, suit) => ({ rank, suit, red: RED.has(suit), confident: true });
const unknown = () => ({ rank: '?', suit: '', red: false, confident: false });

export const RECOMMENDATIONS = {
  ZIEHEN:     { label: 'ZIEHEN',     spoken: 'Ziehen',     tone: 'hit' },
  STEHEN:     { label: 'STEHEN',     spoken: 'Stehen',     tone: 'stand' },
  VERDOPPELN: { label: 'VERDOPPELN', spoken: 'Verdoppeln', tone: 'double' },
  SPLITTEN:   { label: 'SPLITTEN',   spoken: 'Splitten',   tone: 'split' },
  AUFGEBEN:   { label: 'AUFGEBEN',   spoken: 'Aufgeben',   tone: 'surrender' }
};

export const DEMO_SCENARIOS = [
  { id: 'stehen',     dealerUp: card('6', '♠'),  player: [card('10', '♥'), card('6', '♣')], handText: 'Harte 16 gegen 6',  recommendation: 'STEHEN' },
  { id: 'ziehen',     dealerUp: card('9', '♠'),  player: [card('7', '♦'), card('5', '♥')],  handText: 'Harte 12 gegen 9',  recommendation: 'ZIEHEN' },
  { id: 'verdoppeln', dealerUp: card('5', '♥'),  player: [card('6', '♦'), card('5', '♣')],  handText: 'Harte 11 gegen 5',  recommendation: 'VERDOPPELN' },
  { id: 'splitten',   dealerUp: card('6', '♣'),  player: [card('8', '♥'), card('8', '♠')],  handText: 'Paar 8 gegen 6',    recommendation: 'SPLITTEN' },
  { id: 'aufgeben',   dealerUp: card('10', '♦'), player: [card('9', '♠'), card('7', '♥')],  handText: 'Harte 16 gegen 10', recommendation: 'AUFGEBEN' },
  { id: 'soft',       dealerUp: card('3', '♣'),  player: [card('A', '♠'), card('7', '♦'), card('2', '♥')], handText: 'Soft 20 gegen 3', recommendation: 'STEHEN' },
  { id: 'unsicher',   dealerUp: card('7', '♥'),  player: [unknown(), card('9', '♦')],       handText: '',                  recommendation: null }
];

// Handwert nach Blackjack-Regeln (Ass = 1 oder 11).
export function handValue(cards) {
  if (cards.some((c) => !c.confident)) return null;
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === 'A') { aces += 1; total += 11; }
    else if (['K', 'Q', 'J', 'B', 'D'].includes(c.rank)) total += 10;
    else total += Number(c.rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return total;
}

export function cardValueLabel(c) {
  if (!c || !c.confident) return '–';
  if (c.rank === 'A') return '1/11';
  if (['K', 'Q', 'J', 'B', 'D'].includes(c.rank)) return '10';
  return c.rank;
}
