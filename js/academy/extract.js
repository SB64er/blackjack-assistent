// Blackjack-Aussagen aus Text (Transkript/Untertitel) erkennen – Phase 8.2.
// Regelbasierte Texterkennung für Deutsch und Englisch. KEINE KI und kein Sprachmodell:
// Erkannt werden nur klar formulierte Aussagen (z. B. „16 gegen 10 ziehen“,
// „always split aces and eights“, „dealer stands on soft 17“). Alles andere wird nicht
// erfunden, sondern höchstens als Thema markiert. Reine Logik -> testbar.

export const TOPICS = {
  basic: 'Basic Strategy',
  hitStand: 'Hit und Stand',
  double: 'Double Down',
  split: 'Split',
  surrender: 'Surrender',
  dealer: 'Dealer-Regeln',
  decks: 'Deckanzahl',
  probability: 'Wahrscheinlichkeiten',
  mistakes: 'Häufige Strategiefehler',
  variants: 'Blackjack-Varianten'
};

const TOPIC_WORDS = {
  basic: /\b(basic strategy|basisstrategie|grundstrategie|strategy chart|strategietabelle)\b/,
  hitStand: /\b(hit|stand|ziehen|stehen|hitting|standing)\b/,
  double: /\b(double down|doubling|double|verdoppeln|verdoppel\w*)\b/,
  split: /\b(split\w*|teilen)\b/,
  surrender: /\b(surrender\w*|aufgeben|aufgabe)\b/,
  dealer: /\b(soft 17|h17|s17|dealer (?:stands|hits|must|steht|zieht)|peek|hole card|verdeckte karte)\b/,
  decks: /\b(\d+|single|double|one|two|four|six|eight|ein|zwei|vier|sechs|acht)[- ]?(deck|decks)\b/,
  probability: /\b(probabilit\w*|chance\w*|percent|prozent|wahrscheinlich\w*|house edge|hausvorteil|odds|bust rate|%)/,
  mistakes: /\b(mistake\w*|fehler\w*|wrong|falsch\w*|never do|nie machen)\b/,
  variants: /\b(european|american|spanish 21|free bet|blackjack switch|double exposure|pontoon|europäisch\w*|amerikanisch\w*|variante\w*|variant\w*)\b/
};

const NUM_WORDS = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, 'twenty one': 21, 'twenty-one': 21,
  zwei: 2, drei: 3, vier: 4, 'fünf': 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, 'zwölf': 12, zwoelf: 12,
  dreizehn: 13, vierzehn: 14, 'fünfzehn': 15, fuenfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19, zwanzig: 20, einundzwanzig: 21
};
const PAIR_WORDS = {
  aces: 11, asse: 11, 'assen': 11, twos: 2, deuces: 2, zweier: 2, threes: 3, dreier: 3, fours: 4, vierer: 4, fives: 5, 'fünfer': 5,
  sixes: 6, sechser: 6, sevens: 7, siebener: 7, eights: 8, achten: 8, achter: 8, nines: 9, neuner: 9, tens: 10, zehner: 10, 'zehnen': 10, 'face cards': 10, bildkarten: 10
};
const PAIR_RE = `(?:${Object.keys(PAIR_WORDS).sort((a, b) => b.length - a.length).join('|')}|(?:[2-9]|10)'?s)`;

const ACTION_WORDS = [
  ['SURRENDER', /\b(surrender\w*|aufgeben|aufgabe|gib auf|gibst auf)\b/g],
  ['SPLIT', /\b(split\w*|teilen|teile|teilst)\b/g],
  ['DOUBLE', /\b(double(?: down)?|doubling|doubled|verdoppel\w*|doppeln)\b/g],
  ['HIT', /\b(hit|hitting|take a card|take another card|draw|ziehen|zieh|ziehst|karte nehmen|noch eine karte)\b/g],
  ['STAND', /\b(stand|standing|stay|stick|stehen|steh|stehst|bleiben|keine karte)\b/g]
];
const NEG_RE = /\b(never|don'?t|do not|not|nie|niemals|nicht|kein|keine)\b[^.!?,]{0,14}$/;

const ALL_UPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const UP_TOKEN = '(\\d{1,2}|ace|ass|as)';

/** Text vereinheitlichen: Kleinschreibung, Zahlwörter -> Ziffern, Schreibweisen von A,7. */
export function normalizeText(text) {
  let t = String(text || '')
    .replace(/\b[Aa]\s*[,/-]\s*([2-9])\b/g, 'soft $1@ace')   // A,7 -> weich (wird unten aufgelöst)
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/\s+/g, ' ');
  const keys = Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length);
  for (const k of keys) t = t.replace(new RegExp(`(^|[^\\p{L}])${k}(?=[^\\p{L}]|$)`, 'gu'), `$1${NUM_WORDS[k]}`);
  t = t.replace(/soft (\d)@ace/g, (_, d) => `soft ${11 + Number(d)}`);
  t = t.replace(/\b(ace|ass)[ -](\d)\b(?! ?(?:through|to|bis|or))/g, (m, a, d) => (Number(d) >= 2 && Number(d) <= 9 ? `soft ${11 + Number(d)}` : m));
  return t;
}

function upValue(tok) {
  if (tok == null) return null;
  if (/^(ace|ass|as|a)$/.test(tok)) return 11;
  const n = Number(tok);
  if (n === 1) return 11;
  return n >= 2 && n <= 11 ? n : null;
}

/** Dealerkarten aus einer Angabe wie "7", "2 through 6", "7 or higher", "anything". */
export function parseUps(spec) {
  const s = String(spec || '').trim();
  if (/^(anything|everything|any(?: dealer)? card|all|alles|jede\w* karte|jede\w*|alle\w*)$/.test(s)) return ALL_UPS.slice();
  let m = new RegExp(`^${UP_TOKEN}\\s*(?:through|thru|to|bis|-|–|and)\\s*${UP_TOKEN}$`).exec(s);
  if (m) {
    const a = upValue(m[1]); const b = upValue(m[2]);
    if (a && b) return ALL_UPS.filter((u) => u >= Math.min(a, b) && u <= Math.max(a, b));
  }
  m = new RegExp(`^${UP_TOKEN}\\s*(?:or higher|or more|or above|or better|und höher|oder höher|oder mehr|\\+)$`).exec(s);
  if (m) { const a = upValue(m[1]); if (a) return ALL_UPS.filter((u) => u >= a); }
  m = new RegExp(`^${UP_TOKEN}\\s*(?:or lower|or less|or below|und tiefer|oder tiefer|oder weniger)$`).exec(s);
  if (m) { const a = upValue(m[1]); if (a) return ALL_UPS.filter((u) => u <= a && u !== 11); }
  m = new RegExp(`^${UP_TOKEN}$`).exec(s);
  if (m) { const a = upValue(m[1]); if (a) return [a]; }
  // Aufzählung: "9, 10 and ace" – gültige Karten am Anfang übernehmen
  const list = [];
  for (const tok of s.split(/\s*(?:,|\band\b|\bund\b|\bor\b|\boder\b|\s)\s*/).filter(Boolean)) {
    const v = upValue(tok);
    if (!v) break;
    if (!list.includes(v)) list.push(v);
  }
  return list.length ? list : null;
}

const UP_SPEC = `(?:anything|everything|any(?: dealer)? card|alles|jede\\w* karte|${UP_TOKEN}(?:\\s*(?:through|thru|to|bis|-|–)\\s*${UP_TOKEN}|\\s*(?:or higher|or more|or above|or lower|or less|und höher|oder höher|oder mehr|oder tiefer)|(?:\\s*(?:,|and|und|or|oder)?\\s+${UP_TOKEN}){1,9})?)`;
const UP_PREFIX = `(?:(?:a|an|the|ein|einen|eine|die|der|dealer'?s?|dealers|des dealers|dealer shows|dealer showing|up ?card|offene karte|karte)\\s+)*`;
const VS = '(?:against|vs\\.?|versus|gegen|when the dealer shows|wenn der dealer|if the dealer shows|with the dealer showing)';

const SITUATION_RES = [
  // Paar gegen Dealerkarte: "pair of 8s against 10", "eights against a ten", "8,8 gegen 10"
  { kind: 'pair', re: new RegExp(`\\b(?:pair of |a pair of |paar |pärchen )?(${PAIR_RE}|(?:[2-9]|10|ace)\\s*[,/]\\s*(?:[2-9]|10|ace))\\s+${VS}\\s+${UP_PREFIX}(${UP_SPEC})`, 'g') },
  // Hart/weich gegen Dealerkarte: "hard 16 against a 10", "soft 18 vs 9", "12 gegen 2"
  { kind: 'total', re: new RegExp(`\\b(hard|soft|hart\\w*|weich\\w*)?\\s*(\\d{1,2})\\s+${VS}\\s+${UP_PREFIX}(${UP_SPEC})`, 'g') }
];

function pairValue(tok) {
  const t = tok.trim();
  if (PAIR_WORDS[t] != null) return PAIR_WORDS[t];
  let m = /^([2-9]|10)'?s$/.exec(t);
  if (m) return Number(m[1]);
  m = /^([2-9]|10|ace)\s*[,/]\s*([2-9]|10|ace)$/.exec(t);
  if (m && m[1] === m[2]) return m[1] === 'ace' ? 11 : Number(m[1]);
  return null;
}

function cellsFor(kind, value, ups) {
  if (kind === 'hard' && (value < 5 || value > 21)) return [];
  if (kind === 'soft' && (value < 13 || value > 21)) return [];
  if (kind === 'pair' && !(value >= 2 && value <= 11)) return [];
  return ups.map((up) => ({ kind, value, up }));
}

function findAction(win, aStart, aEnd) {
  let best = null;
  for (const [action, re] of ACTION_WORDS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(win))) {
      const wStart = m.index;
      const wEnd = m.index + m[0].length;
      if (wStart < aEnd && wEnd > aStart) continue; // Wort liegt in der Situation selbst
      const afterAnchor = wStart >= aEnd;
      // "stand on 16 …", "double 11 …": gehört zur NÄCHSTEN Hand, nicht zu dieser.
      if (afterAnchor && /^\s+(?:down\s+)?(?:on|with|at|bei|mit|auf|hard|soft|hart|weich|\d)/.test(win.slice(wEnd))) continue;
      const dist = afterAnchor ? wStart - aEnd : aStart - wEnd;
      if (!best || dist < best.dist || (dist === best.dist && !afterAnchor)) {
        const before = win.slice(Math.max(0, wStart - 22), wStart);
        best = { action, dist, negated: NEG_RE.test(before), word: m[0] };
      }
    }
  }
  return best;
}

function excerpt(text, start, end) {
  const a = Math.max(0, start - 40);
  const b = Math.min(text.length, end + 40);
  return `${a > 0 ? '…' : ''}${text.slice(a, b).trim()}${b < text.length ? '…' : ''}`;
}

/**
 * Aussagen erkennen.
 * @param {string|Array<{start?, text}>} input – Text oder Transkript-Abschnitte (mit Zeit in s)
 * @returns {{ claims: Array, topics: string[], chars: number }}
 */
export function extractClaims(input) {
  const segments = Array.isArray(input)
    ? input.filter((s) => s && typeof s.text === 'string').map((s) => ({ start: Number.isFinite(s.start) ? s.start : null, text: s.text }))
    : [{ start: null, text: String(input || '') }];
  // Zusammenhängender Text mit Positionen der Abschnitte (Transkripte haben oft keine Satzzeichen).
  let text = '';
  const marks = [];
  for (const s of segments) {
    const n = normalizeText(s.text);
    marks.push({ pos: text.length, start: s.start });
    text += `${n} `;
  }
  const timeAt = (pos) => {
    let t = null;
    for (const m of marks) { if (m.pos <= pos) t = m.start; else break; }
    return t;
  };

  const claims = [];
  const seen = new Set();
  const push = (c) => {
    const key = claimKey(c);
    if (seen.has(key)) return;
    seen.add(key);
    claims.push({ ...c, key });
  };

  // 1) Situationen "X gegen Y" mit einer Aktion in der Nähe
  const hits = [];
  for (const { kind, re } of SITUATION_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (hits.some((h) => m.index < h.end && m.index + m[0].length > h.start)) continue;
      let k; let value; let upSpec;
      if (kind === 'pair') {
        value = pairValue(m[1]);
        if (value == null) continue;
        k = 'pair'; upSpec = m[2];
      } else {
        value = Number(m[2]);
        k = /^(soft|weich)/.test(m[1] || '') ? 'soft' : 'hard';
        upSpec = m[3];
      }
      const ups = parseUps(upSpec.replace(/^(?:a|an|the|ein|einen|eine|die|der)\s+/, ''));
      if (!ups) continue;
      hits.push({ start: m.index, end: m.index + m[0].length, kind: k, value, ups });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  hits.forEach((h, i) => {
    const lo = Math.max(i ? hits[i - 1].end : 0, h.start - 45);
    const hi = Math.min(i + 1 < hits.length ? hits[i + 1].start : text.length, h.end + 45);
    // Satzzeichen begrenzen das Fenster, wenn vorhanden (Transkripte haben oft keine).
    const before = text.slice(lo, h.start);
    const cut = Math.max(before.lastIndexOf('. '), before.lastIndexOf('? '), before.lastIndexOf('! '));
    const lo2 = cut >= 0 ? lo + cut + 2 : lo;
    const after = text.slice(h.end, hi);
    const endM = /[.?!](\s|$)/.exec(after);
    const hi2 = endM ? h.end + endM.index : hi;
    const win = text.slice(lo2, hi2);
    const act = findAction(win, h.start - lo2, h.end - lo2);
    if (!act) return;
    const cells = cellsFor(h.kind, h.value, h.ups);
    if (!cells.length) return;
    push({ type: 'play', cells, action: act.action, negated: act.negated, excerpt: excerpt(text, h.start, h.end), at: timeAt(h.start) });
  });

  // 2) "always split aces and eights", "never split tens", "Asse und Achten immer teilen"
  const pairRule = [
    new RegExp(`\\b(always|never|immer|nie|niemals)\\s+(?:split|teilen|splitten|teile)\\s+(?:a pair of |pairs of )?(${PAIR_RE})(?:\\s*(?:and|und|&)\\s*(${PAIR_RE}))?`, 'g'),
    new RegExp(`\\b(${PAIR_RE})(?:\\s*(?:and|und|&)\\s*(${PAIR_RE}))?\\s+(?:always|never|immer|nie|niemals)\\s+(?:split\\w*|teilen|splitten)`, 'g')
  ];
  pairRule.forEach((re, idx) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const word = idx === 0 ? m[1] : /(always|never|immer|nie|niemals)/.exec(m[0])[1];
      const neg = /^(never|nie|niemals)$/.test(word);
      const toks = idx === 0 ? [m[2], m[3]] : [m[1], m[2]];
      for (const t of toks.filter(Boolean)) {
        const v = pairValue(t);
        if (v == null) continue;
        push({ type: 'play', cells: cellsFor('pair', v, ALL_UPS), action: 'SPLIT', negated: neg, excerpt: excerpt(text, m.index, m.index + m[0].length), at: timeAt(m.index) });
      }
    }
  });

  // 3) "always stand on (hard) 17", "never hit 17 or more", "always double 11"
  const handRule = /\b(always|never|immer|nie|niemals)\s+(stand|hit|double(?: down)?|stehen|ziehen|verdoppeln)\s+(?:on |with |at |bei |mit |auf )?(?:a |an |einer )?(hard |soft |harte\w* |weiche\w* )?(\d{1,2})(\s*(?:or (?:more|higher|above)|und mehr|oder mehr|und höher|\+))?/g;
  let m;
  while ((m = handRule.exec(text))) {
    const neg = /^(never|nie|niemals)$/.test(m[1]);
    const a = /^(stand|stehen)/.test(m[2]) ? 'STAND' : (/^(hit|ziehen)/.test(m[2]) ? 'HIT' : 'DOUBLE');
    const kind = /^(soft|weich)/.test((m[3] || '').trim()) ? 'soft' : 'hard';
    const v = Number(m[4]);
    const values = m[5] ? Array.from({ length: Math.max(0, 22 - v) }, (_, i) => v + i) : [v];
    const cells = values.flatMap((x) => cellsFor(kind, x, ALL_UPS));
    if (cells.length) push({ type: 'play', cells, action: a, negated: neg, excerpt: excerpt(text, m.index, m.index + m[0].length), at: timeAt(m.index) });
  }

  // 4) Tischregeln (Informationen, keine Strategie)
  const rules = [
    [/\bdealer (?:must |has to |will |always )?(?:stand|stands|stay|stays) on (?:all |soft )?17\b|\bs17\b|\bdealer steht (?:bei|auf) (?:allen |weich\w* |soft )?17\b/g, { rule: 'soft17', value: 'steht' }],
    [/\bdealer (?:must |has to |will |always )?(?:hit|hits|draw|draws) (?:on )?soft 17\b|\bh17\b|\bdealer zieht (?:bei|auf) (?:weich\w* |soft )17\b/g, { rule: 'soft17', value: 'zieht' }],
    [/\b(?:blackjack )?pays? (?:out )?3 ?(?:to|:|zu) ?2\b|\bzahlt 3 ?(?:zu|:) ?2\b/g, { rule: 'payout', value: '3:2' }],
    [/\b(?:blackjack )?pays? (?:out )?6 ?(?:to|:|zu) ?5\b|\bzahlt 6 ?(?:zu|:) ?5\b/g, { rule: 'payout', value: '6:5' }],
    [/\bdouble after split(?:ting)? (?:is )?(?:allowed|permitted)|\bdas (?:is )?allowed|verdoppeln nach (?:dem )?split(?:ten)? (?:ist )?erlaubt/g, { rule: 'das', value: true }],
    [/\b(?:no double after split|double after split(?:ting)? (?:is )?not allowed|verdoppeln nach (?:dem )?split(?:ten)? (?:ist )?nicht erlaubt)/g, { rule: 'das', value: false }],
    [/\blate surrender\b|\bspätes aufgeben\b/g, { rule: 'surrender', value: 'spaet' }]
  ];
  for (const [re, info] of rules) {
    re.lastIndex = 0;
    while ((m = re.exec(text))) push({ type: 'rule', ...info, excerpt: excerpt(text, m.index, m.index + m[0].length), at: timeAt(m.index) });
  }
  const deckRe = /\b(1|2|4|6|8|single|double)[- ]?(?:deck|decks|deck game|deck-spiel)\b/g;
  while ((m = deckRe.exec(text))) {
    const n = m[1] === 'single' ? 1 : (m[1] === 'double' ? 2 : Number(m[1]));
    push({ type: 'rule', rule: 'decks', value: n, excerpt: excerpt(text, m.index, m.index + m[0].length), at: timeAt(m.index) });
  }

  // 5) Versicherung
  const insRe = /\b(?:never|don'?t|do not|nie|niemals|keine?)\s+(?:take |buy |nehmen |abschliessen |abschließen )?(?:the |an |eine |die )?(?:insurance|versicherung)\b|\b(?:insurance|versicherung) (?:is|ist) (?:a )?(?:sucker bet|bad bet|eine schlechte wette|schlecht)/g;
  while ((m = insRe.exec(text))) push({ type: 'insurance', action: 'never', excerpt: excerpt(text, m.index, m.index + m[0].length), at: timeAt(m.index) });

  // 6) Wahrscheinlichkeiten, die sich nachrechnen lassen
  const bustRe = new RegExp(`\\bdealer (?:will |would )?(?:bust|busts|busting|überkauft sich|überkauft)[^.%]{0,40}?(\\d{1,2}(?:[.,]\\d+)?) ?(?:%|percent|prozent)[^.]{0,40}?(?:with|showing|when showing|mit|bei)(?: a| an| einer| einem)? ${UP_TOKEN}\\b`, 'g');
  while ((m = bustRe.exec(text))) {
    const up = upValue(m[2]);
    if (up) push({ type: 'probability', metric: 'dealerBust', up, value: Number(m[1].replace(',', '.')) / 100, excerpt: excerpt(text, m.index, m.index + m[0].length), at: timeAt(m.index) });
  }
  const bustRe2 = new RegExp(`\\b(?:with|when the dealer shows|mit|bei)(?: a| an| einer| einem)? ${UP_TOKEN}[^.%]{0,40}?(?:bust|busts|überkauft)[^.%]{0,30}?(\\d{1,2}(?:[.,]\\d+)?) ?(?:%|percent|prozent)`, 'g');
  while ((m = bustRe2.exec(text))) {
    const up = upValue(m[1]);
    if (up) push({ type: 'probability', metric: 'dealerBust', up, value: Number(m[2].replace(',', '.')) / 100, excerpt: excerpt(text, m.index, m.index + m[0].length), at: timeAt(m.index) });
  }
  const bustRe3 = new RegExp(`\\bdealer (?:überkauft sich|überkauft|busts|will bust)(?: mit| with| bei)(?: a| an| einer| einem)? ${UP_TOKEN}\\b[^.%]{0,30}?(\\d{1,2}(?:[.,]\\d+)?) ?(?:%|percent|prozent)`, 'g');
  while ((m = bustRe3.exec(text))) {
    const up = upValue(m[1]);
    if (up) push({ type: 'probability', metric: 'dealerBust', up, value: Number(m[2].replace(',', '.')) / 100, excerpt: excerpt(text, m.index, m.index + m[0].length), at: timeAt(m.index) });
  }
  const edgeRe = /\b(?:house edge|hausvorteil)[^.%]{0,30}?(\d(?:[.,]\d+)?) ?(?:%|percent|prozent)/g;
  while ((m = edgeRe.exec(text))) push({ type: 'houseEdge', value: Number(m[1].replace(',', '.')) / 100, excerpt: excerpt(text, m.index, m.index + m[0].length), at: timeAt(m.index) });

  const topics = Object.keys(TOPIC_WORDS).filter((k) => TOPIC_WORDS[k].test(text));
  return { claims, topics, chars: text.trim().length };
}

/** Eindeutiger Schlüssel einer Aussage (Erkennung doppelter Einträge). */
export function claimKey(c) {
  if (c.type === 'play') {
    const cells = [...c.cells].map((x) => `${x.kind}:${x.value}:${x.up}`).sort().join(',');
    return `play|${c.negated ? '!' : ''}${c.action}|${cells}`;
  }
  if (c.type === 'rule') return `rule|${c.rule}|${c.value}`;
  if (c.type === 'insurance') return 'insurance|never';
  if (c.type === 'probability') return `prob|${c.metric}|${c.up}|${Math.round(c.value * 1000)}`;
  if (c.type === 'houseEdge') return `edge|${Math.round(c.value * 10000)}`;
  return `other|${String(c.text || '').slice(0, 80)}`;
}

const UP_DE = (u) => (u === 11 ? 'Ass' : String(u));
const ACTION_DE = { HIT: 'Ziehen', STAND: 'Stehen', DOUBLE: 'Verdoppeln', SPLIT: 'Splitten', SURRENDER: 'Aufgeben' };

export function upsText(ups) {
  const s = [...new Set(ups)].sort((a, b) => a - b);
  if (s.length === 10) return 'jede Dealerkarte';
  const contiguous = s.every((u, i) => i === 0 || u === s[i - 1] + 1);
  if (s.length > 2 && contiguous) return `Dealer ${UP_DE(s[0])} bis ${UP_DE(s[s.length - 1])}`;
  return `Dealer ${s.map(UP_DE).join(', ')}`;
}

function handText(kind, value) {
  if (kind === 'pair') return `Paar ${value === 11 ? 'A,A' : `${value},${value}`}`;
  if (kind === 'soft') return `Weich ${value} (A,${value - 11})`;
  return `Hart ${value}`;
}

/** Verständlicher Satz zu einer Aussage (Deutsch). */
export function claimText(c) {
  if (c.type === 'play') {
    const groups = new Map();
    for (const x of c.cells) {
      const k = `${x.kind}:${x.value}`;
      if (!groups.has(k)) groups.set(k, { kind: x.kind, value: x.value, ups: [] });
      groups.get(k).ups.push(x.up);
    }
    const hands = [...groups.values()];
    const sameUps = hands.every((h) => h.ups.length === hands[0].ups.length);
    const who = sameUps && hands.length > 1
      ? `${hands.length > 4 ? `${handText(hands[0].kind, hands[0].value)} bis ${handText(hands[hands.length - 1].kind, hands[hands.length - 1].value)}` : hands.map((h) => handText(h.kind, h.value)).join(', ')} gegen ${upsText(hands[0].ups)}`
      : hands.map((h) => `${handText(h.kind, h.value)} gegen ${upsText(h.ups)}`).join('; ');
    return `${who}: ${c.negated ? 'nicht ' : ''}${ACTION_DE[c.action]}`;
  }
  if (c.type === 'rule') {
    if (c.rule === 'soft17') return `Tischregel: Dealer ${c.value === 'zieht' ? 'zieht' : 'steht'} bei Soft 17`;
    if (c.rule === 'payout') return `Tischregel: Blackjack zahlt ${c.value}`;
    if (c.rule === 'das') return `Tischregel: Verdoppeln nach Split ${c.value ? 'erlaubt' : 'nicht erlaubt'}`;
    if (c.rule === 'surrender') return 'Tischregel: spätes Aufgeben erlaubt';
    if (c.rule === 'decks') return `Tischregel: ${c.value} ${c.value === 1 ? 'Deck' : 'Decks'}`;
  }
  if (c.type === 'insurance') return 'Keine Versicherung nehmen';
  if (c.type === 'probability') return `Dealer überkauft sich mit ${UP_DE(c.up)} in ${(c.value * 100).toFixed(1).replace('.', ',')} % der Fälle`;
  if (c.type === 'houseEdge') return `Hausvorteil ${(c.value * 100).toFixed(2).replace('.', ',')} %`;
  return String(c.text || 'Aussage');
}
