// Standardstrategie (Basic Strategy) für 4–8 Decks, US-Regeln mit Peek.
// Reine Logik (ohne DOM) -> testbar.
//
// Quelle (Textregeln, vom Entwickler am 2026-11-22 abgerufen und übernommen):
//   „Blackjack Basic Strategy Chart (4–8 Decks)“, Wizard of Odds,
//   https://wizardofodds.com/games/blackjack/strategy/4-decks/
// Die Tabelle wird hier aus diesen Regeln abgeleitet – abhängig von
// Dealer bei Soft 17 (steht/zieht) und Verdoppeln nach Split.
// Ab Version 0.6.0 gibt es KEIN Aufgeben (Surrender) mehr: Die Tabelle entspricht
// der Quelle für „Surrender not allowed“.
// Für 1–2 Decks gibt es kleine Abweichungen; dort gilt diese Tabelle als
// bewährter Rückfall (siehe Analyse im Rechenmodell).

export const STANDARD_SOURCE = Object.freeze({
  title: 'Blackjack Basic Strategy Chart (4–8 Decks) – Wizard of Odds',
  url: 'https://wizardofodds.com/games/blackjack/strategy/4-decks/',
  retrievedAt: '2026-11-22',
  note: 'Textregeln der Seite, beim Entwickeln von Version 0.5.0 abgerufen (nicht durch die App).'
});

// Codes (wie in üblichen Strategietabellen):
//   H  ziehen · S stehen · D verdoppeln, sonst ziehen · Ds verdoppeln, sonst stehen
//   P  splitten · Ph splitten nur mit Verdoppeln nach Split, sonst wie Gesamtwert
export const CODES = ['H', 'S', 'D', 'Ds', 'P', 'Ph'];
export const CODE_LABEL = {
  H: 'Ziehen', S: 'Stehen', D: 'Verdoppeln, sonst ziehen', Ds: 'Verdoppeln, sonst stehen',
  P: 'Splitten', Ph: 'Splitten mit Verdoppeln nach Split, sonst wie Gesamtwert'
};
export const CODES_BY_KIND = {
  hard: ['H', 'S', 'D', 'Ds'],
  soft: ['H', 'S', 'D', 'Ds'],
  pair: ['P', 'Ph', 'H', 'S', 'D', 'Ds']
};

// Codes aus Version 0.5.0 mit Aufgeben (Surrender). Sie werden beim Lesen alter
// Daten in die gleichwertige Aktion OHNE Aufgeben übersetzt („Aufgeben, sonst …“).
export const LEGACY_SURRENDER_CODES = Object.freeze({ Rh: 'H', Rs: 'S', Rp: 'P' });
export function modernCode(code) {
  return Object.prototype.hasOwnProperty.call(LEGACY_SURRENDER_CODES, code) ? LEGACY_SURRENDER_CODES[code] : code;
}

// Dealerkarten 2–10 und Ass (= 11).
export const UPCARDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
export const ROWS = {
  hard: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
  soft: [13, 14, 15, 16, 17, 18, 19, 20, 21],
  pair: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

export const DEFAULT_RULES = Object.freeze({ decks: 6, soft17: 'steht', das: true, payout: '3:2' });

// 0.8.0: Deckanzahl "Unbekannt". Gerechnet wird dann mit diesem dokumentierten
// Standardprofil; die App kennzeichnet das immer als Annahme (nie als erkannt).
export const UNKNOWN_DECK_PROFILE = 6;

export function normalizeRules(r) {
  const d = DEFAULT_RULES;
  const x = r || {};
  const unknown = x.decksUnknown === true;
  return {
    decks: unknown ? UNKNOWN_DECK_PROFILE : ([1, 2, 4, 6, 8].includes(x.decks) ? x.decks : d.decks),
    soft17: x.soft17 === 'zieht' ? 'zieht' : 'steht',
    das: typeof x.das === 'boolean' ? x.das : d.das,
    // "surrender" aus alten Daten wird ignoriert (Aufgeben gibt es nicht mehr).
    payout: x.payout === '6:5' ? '6:5' : '3:2',
    // Nur vorhanden, wenn die Deckanzahl unbekannt ist (alte Daten bleiben unverändert).
    ...(unknown ? { decksUnknown: true } : {})
  };
}

export function rulesEqual(a, b) {
  const x = normalizeRules(a);
  const y = normalizeRules(b);
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].every((k) => x[k] === y[k]);
}

export function decksText(r) {
  const x = normalizeRules(r);
  if (x.decksUnknown) return `Decks unbekannt (Annahme ${UNKNOWN_DECK_PROFILE})`;
  return `${x.decks} ${x.decks === 1 ? 'Deck' : 'Decks'}`;
}

export function rulesText(r) {
  const x = normalizeRules(r);
  return `${decksText(x)} · ${x.soft17 === 'zieht' ? 'H17' : 'S17'} · ${x.das ? 'DAS' : 'kein DAS'} · BJ ${x.payout}`;
}

const between = (u, lo, hi) => u >= lo && u <= hi;

function hardCode(t, u, h17) {
  if (t <= 8) return 'H';
  if (t === 9) return between(u, 3, 6) ? 'D' : 'H';
  if (t === 10) return between(u, 2, 9) ? 'D' : 'H';
  if (t === 11) return u === 11 ? (h17 ? 'D' : 'H') : 'D';
  if (t === 12) return between(u, 4, 6) ? 'S' : 'H';
  if (t <= 16) return between(u, 2, 6) ? 'S' : 'H';
  return 'S';
}

function softCode(t, u, h17) {
  if (t <= 12) return 'H';
  if (t <= 14) return between(u, 5, 6) ? 'D' : 'H';
  if (t <= 16) return between(u, 4, 6) ? 'D' : 'H';
  if (t === 17) return between(u, 3, 6) ? 'D' : 'H';
  if (t === 18) {
    if (between(u, 3, 6) || (h17 && u === 2)) return 'Ds';
    if (u === 2 || u === 7 || u === 8) return 'S';
    return 'H';
  }
  if (t === 19) return h17 && u === 6 ? 'Ds' : 'S';
  return 'S';
}

function pairCode(v, u, h17) {
  if (v === 11) return 'P';
  if (v === 10) return 'S';
  if (v === 9) return (between(u, 2, 6) || u === 8 || u === 9) ? 'P' : 'S';
  if (v === 8) return 'P';
  if (v === 7) return between(u, 2, 7) ? 'P' : 'H';
  if (v === 6) return u === 2 ? 'Ph' : (between(u, 3, 6) ? 'P' : 'H');
  if (v === 5) return hardCode(10, u, h17);
  if (v === 4) return between(u, 5, 6) ? 'Ph' : 'H';
  return u === 2 || u === 3 ? 'Ph' : (between(u, 4, 7) ? 'P' : 'H'); // 2,2 und 3,3
}

/** Code der Standardstrategie für eine Tabellenzelle. */
export function standardCode(kind, value, up, rules) {
  const h17 = normalizeRules(rules).soft17 === 'zieht';
  if (kind === 'hard') return hardCode(value, up, h17);
  if (kind === 'soft') return softCode(value, up, h17);
  if (kind === 'pair') return pairCode(value, up, h17);
  throw new Error(`Unbekannte Handart: ${kind}`);
}

export function cellKey(kind, value, up) {
  return `${kind}:${value}:${up}`;
}

export function parseKey(key) {
  const m = /^(hard|soft|pair):(\d+):(\d+)$/.exec(key || '');
  if (!m) return null;
  const kind = m[1];
  const value = Number(m[2]);
  const up = Number(m[3]);
  if (!ROWS[kind].includes(value) || !UPCARDS.includes(up)) return null;
  return { kind, value, up };
}

/** Ganze Standardtabelle für bestimmte Regeln. */
export function standardTable(rules) {
  const out = {};
  for (const kind of Object.keys(ROWS)) {
    for (const v of ROWS[kind]) for (const u of UPCARDS) out[cellKey(kind, v, u)] = standardCode(kind, v, u, rules);
  }
  return out;
}

export function upLabel(u) {
  return u === 11 ? 'A' : String(u);
}

export function rowLabel(kind, v) {
  if (kind === 'hard') return String(v);
  if (kind === 'soft') return `A,${v - 11}`;
  return v === 11 ? 'A,A' : `${v},${v}`;
}
