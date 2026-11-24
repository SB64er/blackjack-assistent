// Yumeko-Lernzentrum (ab 0.11.0): Datenquellen der vier Bereiche Karten, AI Table, Study, Brain.
//
// WICHTIG: Hier gibt es bewusst KEINE KI, keine Lernalgorithmen, keine Strategien und keine
// Beispieldaten. Alle Funktionen liefern den leeren Startzustand (0, 0 %, leere Listen).
// Die Oberflächen lesen ihre Anzeigen ausschliesslich über diese Funktionen. Sobald die neue
// Yumeko-KI entwickelt ist, wird sie hier angeschlossen – die Ansichten bleiben unverändert.
//
// `YUMEKO_READY` schaltet die von Yumeko abhängigen Bedienelemente frei (vorerst aus).
export const YUMEKO_READY = false;

/** Hinweis für deaktivierte Funktionen. */
export const NOT_READY_TEXT = 'Folgt, sobald Yumeko lernen kann.';

/** Unterseiten des Lernzentrums (Route = Ansicht in app.js). */
export const SUBPAGES = Object.freeze({
  karten: 'lz-karten',
  table: 'lz-table',
  study: 'lz-study',
  brain: 'lz-brain'
});

// ---------- Karten ----------

export const KARTEN_TABS = Object.freeze([
  { id: 'cards', label: 'Einzelkarten', sub: 'Jede Karte von 2 bis Ass und ihr Wert' },
  { id: 'player', label: 'Spielerhände', sub: 'Alle Handsummen mit zwei oder mehr Karten' },
  { id: 'dealer', label: 'Dealer-Hände', sub: 'Von der offenen Karte bis zur Endhand' },
  { id: 'matrix', label: 'Spieler × Dealer', sub: 'Jede Spielerhand gegen jede offene Dealerkarte' },
  { id: 'types', label: 'Handtypen', sub: 'Harte und weiche Hände, Paare, Blackjack und Bust' },
  { id: 'decks', label: 'Kartendecks', sub: 'Spielsituationen mit einem oder mehreren Decks' }
]);

/** Lernstände 0 = neu, 1 = gesehen, 2 = geübt, 3 = sicher. */
export const LEVELS = Object.freeze(['neu', 'gesehen', 'geübt', 'sicher']);

/**
 * Lernstand des Bereichs Karten. Leer: alles 0 %, jede Karte/Hand/Situation "neu".
 * Später: Lernstand je Karte (`cards[rank]`), Hand (`hands[id]`) und Matrixfeld (`matrix[key]`).
 */
export function kartenProgress() {
  return {
    total: 0,                                   // Prozent gesamt
    tabs: Object.fromEntries(KARTEN_TABS.map((t) => [t.id, 0])),
    cards: {}, hands: {}, matrix: {},           // fehlender Eintrag = 0 (neu)
    dealer: null,                               // später: { [Dealerkarte]: { '17': p, …, bust: p } }
    typeCounts: { hard: 0, soft: 0, pair: 0, blackjack: 0, bust: 0 }
  };
}

// ---------- AI Table ----------

/** Zustand des virtuellen Trainingstischs (Sim-Geld, kein Echtgeld). Leer: kein Training. */
export function tableState() {
  return {
    running: 'stopped',                          // 'running' | 'paused' | 'stopped'
    hand: null,                                  // später: { no, of }
    dealer: { cards: [], total: null },
    player: { cards: [], label: null },
    result: null,                                // später: { tone, text }
    credit: null, bet: null,
    settings: { hands: null, decks: null, capital: null, rules: null },
    stats: { hands: 0, win: 0, loss: 0, bust: 0, push: 0 },
    bankroll: [],                                // Verlauf Sim-Geld
    decision: null,                              // später: { hand, title, reason }
    log: [],                                     // später: [{ ok, text, hand }]
    errors: 0, progress: 0,
    saveToBrain: false
  };
}

// ---------- Study ----------

export const STUDY_TYPES = Object.freeze([
  { id: 'yt', label: 'YouTube' },
  { id: 'vid', label: 'Video' },
  { id: 'doc', label: 'Dokument' },
  { id: 'txt', label: 'Text' }
]);

export const STUDY_FILTERS = Object.freeze([
  { id: 'all', label: 'Alle' },
  { id: 'busy', label: 'In Arbeit' },
  { id: 'open', label: 'Offen' },
  { id: 'done', label: 'Verarbeitet' }
]);

/** Lernmaterial für Yumeko. Leer: keine Quellen, keine Erkenntnisse. */
export function studyState() {
  return {
    autoLearn: false,
    sources: [],                                 // später: [{ tag, title, meta, status: 'busy'|'open'|'done', progress }]
    current: null,                               // später: { title, kind, activity, progress }
    queue: [],
    insights: [],                                // später: [{ text, source, inBrain }]
    running: 'stopped'
  };
}

export function studyStats(state = studyState()) {
  const src = state.sources || [];
  return {
    sources: src.length,
    done: src.filter((s) => s.status === 'done').length,
    open: src.filter((s) => s.status !== 'done').length,
    insights: (state.insights || []).length,
    inBrain: (state.insights || []).filter((i) => i.inBrain).length
  };
}

// ---------- Brain ----------

export const BRAIN_AREAS = Object.freeze([
  { id: 'knowledge', label: 'Knowledge', color: '#60A5FA', glow: 'rgba(96,165,250,0.6)' },
  { id: 'experience', label: 'Experience', color: '#34D399', glow: 'rgba(52,211,153,0.6)' },
  { id: 'strategies', label: 'Strategies', color: '#A78BFA', glow: 'rgba(167,139,250,0.6)' },
  { id: 'rules', label: 'Rules', color: '#2DD4BF', glow: 'rgba(45,212,191,0.6)' },
  { id: 'sources', label: 'Learning Sources', color: '#FB923C', glow: 'rgba(251,146,60,0.6)' },
  { id: 'errors', label: 'Errors & Insights', color: '#F472B6', glow: 'rgba(244,114,182,0.6)' }
]);

/** Yumekos Gedächtnis. Leer: kein Eintrag in keinem Bereich. */
export function brainState() {
  return {
    entries: Object.fromEntries(BRAIN_AREAS.map((a) => [a.id, []])), // später: [{ title, text, source, date, verified, ok, confidence, history, links }]
    recent: []
  };
}

export function brainStats(state = brainState()) {
  const n = (id) => (state.entries[id] || []).length;
  return {
    knowledge: BRAIN_AREAS.reduce((s, a) => s + n(a.id), 0),
    experience: n('experience'),
    strategies: n('strategies'),
    sources: n('sources')
  };
}
