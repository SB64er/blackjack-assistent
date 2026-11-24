// Feste Blackjack-Regeln für die Seite "Karten" (ab 0.11.0).
// Nur Spielregeln und Kartenzahlen (Kartenwerte, Handtypen, Zusammensetzung des Kartenschuhs).
// KEINE Strategie, keine Empfehlungen und nichts, was Yumeko gelernt hätte.

export const RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
export const UPCARDS = Object.freeze(['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A']);
export const DECK_OPTIONS = Object.freeze([1, 2, 4, 6, 8]);
const NAMES = { A: 'Ass', J: 'Bube', Q: 'Dame', K: 'König' };
const TENS = ['10', 'J', 'Q', 'K'];

export function cardInfo(rank, decks) {
  const face = ['J', 'Q', 'K'].includes(rank);
  return {
    rank,
    name: NAMES[rank] || `Karte ${rank}`,
    short: rank === 'A' ? '1/11' : (TENS.includes(rank) ? '10' : rank),
    kind: rank === 'A' ? 'Ass' : (face ? 'Bildkarte' : 'Zahlenkarte'),
    value: rank === 'A' ? '1 oder 11' : (TENS.includes(rank) ? '10' : rank),
    valueNote: rank === 'A' ? 'zählt 11, ausser die Hand würde über 21 gehen' : (face ? 'alle Bildkarten zählen 10' : 'Wert entspricht der Zahl'),
    count: 4 * decks
  };
}

/** Gruppen der Spielerhände (Kennungen H<n>, S<n>, P<rang>, BJ, BUST). */
export function handGroups() {
  const hard = []; for (let t = 4; t <= 21; t++) hard.push({ id: `H${t}`, label: String(t) });
  const soft = []; for (let t = 12; t <= 21; t++) soft.push({ id: `S${t}`, label: String(t) });
  const pairs = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map((r) => ({ id: `P${r}`, label: `${r},${r}` }));
  return [
    { label: 'Hart', items: hard },
    { label: 'Soft', items: soft },
    { label: 'Paare', items: pairs },
    { label: 'Besonders', items: [{ id: 'BJ', label: 'Blackjack' }, { id: 'BUST', label: 'Bust' }] }
  ];
}

/** Beschreibung und Beispielkarten einer Spielerhand (rein nach Regeln). filter: all | two | more */
export function handInfo(id, filter = 'all') {
  const three = filter === 'more';
  if (id === 'BJ') return { title: 'Blackjack', note: 'Nur mit den ersten zwei Karten möglich: Ass und Zehnerwert.', examples: three ? [] : [['A', 'K'], ['A', '10'], ['A', 'Q']] };
  if (id === 'BUST') return { title: 'Bust', note: 'Mehr als 21 – entsteht immer erst ab drei Karten.', examples: filter === 'two' ? [] : [['10', '6', '9'], ['8', '7', '9'], ['5', '9', '4', '8']] };
  const n = id.slice(1);
  if (id[0] === 'P') return { title: `Paar ${n}`, note: 'Zwei gleichwertige Startkarten. Kann geteilt werden.', examples: three ? [] : [[n, n]] };
  const v = Number(n);
  if (id[0] === 'S') {
    const r = v - 11;
    const two = r === 1 ? [['A', 'A']] : (r === 10 ? [['A', '10'], ['A', 'K']] : [['A', String(r)]]);
    const more = r >= 3 ? [['A', '2', String(r - 2)]] : [['A', 'A', 'A'].slice(0, r + 1)].filter((x) => x.length >= 3);
    const ex = filter === 'two' ? two : (three ? more : two.concat(more));
    return { title: `Soft ${v}`, note: 'Ass zählt 11. Eine weitere Karte kann die Hand nicht überkaufen.', examples: ex.slice(0, 3) };
  }
  const two = [];
  for (let a = 2; a <= 10 && two.length < 3; a++) { const b = v - a; if (b >= a && b <= 10) two.push([String(a), String(b)]); }
  const more = [];
  if (v >= 6 && v - 4 <= 10) more.push(['2', '2', String(v - 4)]);
  if (v >= 15) more.push(['5', '6', String(v - 11)]);
  if (v >= 7 && v - 5 <= 10) more.push(['2', '3', String(v - 5)]);
  const ex = filter === 'two' ? two : (three ? more : two.slice(0, 2).concat(more.slice(0, 1)));
  return { title: `Hart ${v}`, note: v === 21 ? '21 mit mehr als zwei Karten – kein Blackjack.' : 'Kein Ass, oder jedes Ass zählt als 1.', examples: ex };
}

/** Zeilen der Matrix Spieler × Dealer. */
export const MATRIX_ROWS = Object.freeze([
  ['h5-8', 'Hart 5–8', 'h'], ['h9', 'Hart 9', 'h'], ['h10', 'Hart 10', 'h'], ['h11', 'Hart 11', 'h'], ['h12', 'Hart 12', 'h'],
  ['h13', 'Hart 13', 'h'], ['h14', 'Hart 14', 'h'], ['h15', 'Hart 15', 'h'], ['h16', 'Hart 16', 'h'], ['h17', 'Hart 17+', 'h'],
  ['s13-14', 'Soft 13–14', 's'], ['s15-16', 'Soft 15–16', 's'], ['s17', 'Soft 17', 's'], ['s18', 'Soft 18', 's'], ['s19', 'Soft 19+', 's']
].map(([id, label, kind]) => ({ id, label, kind })));

export const HAND_TYPES = Object.freeze([
  { id: 'hard', title: 'Hart', color: '#93C5FD', text: 'Hand ohne Ass oder mit Ass, das als 1 zählt.', example: ['10', '6'] },
  { id: 'soft', title: 'Soft', color: '#C4B5FD', text: 'Ein Ass zählt als 11, ohne dass die Hand über 21 geht.', example: ['A', '7'] },
  { id: 'pair', title: 'Paar', color: '#F2F4F7', text: 'Zwei gleiche Startkarten – Teilen (Split) ist möglich.', example: ['8', '8'] },
  { id: 'blackjack', title: 'Blackjack', color: '#6EE7B7', text: 'Ass und Zehnerwert als erste zwei Karten.', example: ['A', 'K'] },
  { id: 'bust', title: 'Bust', color: '#FDBA74', text: 'Die Handsumme liegt über 21 – die Hand ist verloren.', example: ['10', '6', '9'] }
]);

/** Zusammensetzung des Kartenschuhs (reine Abzählung). */
export function deckStats(decks) {
  const total = 52 * decks;
  const pBJ = 2 * (4 * decks / total) * (16 * decks / (total - 1));
  return {
    total, aces: 4 * decks, tens: 16 * decks, low: 32 * decks,
    blackjack: `${(pBJ * 100).toFixed(2).replace('.', ',')} %`
  };
}
