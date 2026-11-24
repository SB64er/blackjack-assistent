// Tests für Version 0.11.0: Unterseiten des Yumeko-Lernzentrums (Karten, AI Table, Study, Brain).
// Nur Oberfläche: alle Werte starten bei 0, keine KI, keine Strategien, keine Beispieldaten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  YUMEKO_READY, SUBPAGES, KARTEN_TABS, kartenProgress, tableState, studyState, studyStats,
  brainState, brainStats, BRAIN_AREAS, STUDY_TYPES
} from '../js/lernzentrum/bereiche.js';
import { RANKS, cardInfo, handInfo, handGroups, deckStats, MATRIX_ROWS, HAND_TYPES } from '../js/lernzentrum/karten-wissen.js';
import { AREAS } from '../js/lernzentrum/lernzentrum.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const NEW_FILES = [
  'js/lernzentrum/bereiche.js', 'js/lernzentrum/karten-wissen.js', 'js/views/lz-common.js',
  'js/views/lz-karten-view.js', 'js/views/lz-table-view.js', 'js/views/lz-study-view.js', 'js/views/lz-brain-view.js'
];

test('Yumeko-abhängige Funktionen sind vorerst ausgeschaltet', () => {
  assert.equal(YUMEKO_READY, false);
});

test('Karten: alle Lernstände 0 %, nichts gelernt', () => {
  const p = kartenProgress();
  assert.equal(p.total, 0);
  assert.deepEqual(Object.keys(p.tabs), KARTEN_TABS.map((t) => t.id));
  assert.ok(Object.values(p.tabs).every((v) => v === 0));
  assert.deepEqual(p.cards, {});
  assert.deepEqual(p.hands, {});
  assert.deepEqual(p.matrix, {});
  assert.equal(p.dealer, null, 'keine Beispiel-Wahrscheinlichkeiten');
  assert.ok(Object.values(p.typeCounts).every((v) => v === 0));
});

test('AI Table: kein Training, Statistik 0, keine simulierten Entscheidungen', () => {
  const t = tableState();
  assert.equal(t.running, 'stopped');
  assert.deepEqual(t.stats, { hands: 0, win: 0, loss: 0, bust: 0, push: 0 });
  assert.deepEqual(t.dealer.cards, []);
  assert.deepEqual(t.player.cards, []);
  assert.equal(t.credit, null);
  assert.equal(t.decision, null);
  assert.deepEqual(t.log, []);
  assert.deepEqual(t.bankroll, []);
  assert.equal(t.progress, 0);
  assert.equal(t.saveToBrain, false);
});

test('Study: keine Lernquellen, keine Erkenntnisse, automatisches Lernen aus', () => {
  const s = studyState();
  assert.equal(s.autoLearn, false);
  assert.deepEqual(studyStats(s), { sources: 0, done: 0, open: 0, insights: 0, inBrain: 0 });
  assert.deepEqual(STUDY_TYPES.map((t) => t.label), ['YouTube', 'Video', 'Dokument', 'Text']);
  // Anschluss später: Zähler rechnen aus den gelieferten Daten
  assert.deepEqual(studyStats({ sources: [{ status: 'done' }, { status: 'open' }, { status: 'busy' }], insights: [{ inBrain: true }, {}] }),
    { sources: 3, done: 1, open: 2, insights: 2, inBrain: 1 });
});

test('Brain: leeres Gedächtnis in allen sechs Bereichen', () => {
  const b = brainState();
  assert.deepEqual(BRAIN_AREAS.map((a) => a.label), ['Knowledge', 'Experience', 'Strategies', 'Rules', 'Learning Sources', 'Errors & Insights']);
  assert.ok(Object.values(b.entries).every((l) => l.length === 0));
  assert.deepEqual(b.recent, []);
  assert.deepEqual(brainStats(b), { knowledge: 0, experience: 0, strategies: 0, sources: 0 });
});

test('Karten-Seite zeigt nur feste Regeln (Kartenwerte, Kartenschuh)', () => {
  assert.equal(RANKS.length, 13);
  assert.equal(cardInfo('A', 6).value, '1 oder 11');
  assert.equal(cardInfo('K', 6).value, '10');
  assert.equal(cardInfo('7', 8).count, 32);
  const d = deckStats(6);
  assert.deepEqual([d.total, d.aces, d.tens, d.low], [312, 24, 96, 192]);
  assert.equal(deckStats(1).blackjack, '4,83 %');
  assert.equal(MATRIX_ROWS.length, 15);
  assert.equal(HAND_TYPES.length, 5);
  const ids = handGroups().flatMap((g) => g.items.map((i) => i.id));
  assert.equal(ids.length, 18 + 10 + 10 + 2);
  assert.deepEqual(handInfo('P8').examples, [['8', '8']]);
  assert.deepEqual(handInfo('S18', 'two').examples, [['A', '7']]);
  assert.deepEqual(handInfo('H20', 'two').examples, [['10', '10']]);
  assert.deepEqual(handInfo('BJ', 'more').examples, [], 'Blackjack nie mit 3 Karten');
  // Beispielhände ergeben tatsächlich die genannte Summe
  const val = (r) => (r === 'A' ? 1 : ['J', 'Q', 'K'].includes(r) ? 10 : Number(r));
  for (let t = 4; t <= 21; t++) {
    for (const ex of handInfo(`H${t}`).examples) assert.equal(ex.reduce((s, r) => s + val(r), 0), t, `Hart ${t}: ${ex}`);
  }
  for (let t = 13; t <= 21; t++) {
    for (const ex of handInfo(`S${t}`).examples) assert.equal(ex.reduce((s, r) => s + val(r), 0) + 10, t, `Soft ${t}: ${ex}`);
  }
});

test('Keine Strategie-Empfehlungen, keine Beispieldaten aus dem Design', () => {
  const src = NEW_FILES.map(read).join('\n');
  for (const bad of ['Hand 50', '1’240', '38 %', '62 %', 'Paar 8 immer teilen', 'Basisstrategie (6 Decks', 'Strategietabelle 6 Decks', 'Soft-Hände richtig spielen', 'Bei Paar 8 immer teilen', 'Beispielwert']) {
    assert.ok(!src.includes(bad), `kein Beispielinhalt: ${bad}`);
  }
  assert.ok(!/from '\.\.\/strategy\/(engine|standard|decision)/.test(src), 'keine Strategie-Engine angebunden');
});

test('Neue Dateien: kein Netzwerk, kein KI-Speicher, keine Design-Tool-Laufzeit', () => {
  for (const f of NEW_FILES) {
    const src = read(f);
    assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|indexedDB|localStorage/.test(src), `${f}: kein Netzwerk/Speicher`);
    assert.ok(!/from '\//.test(src), `${f}: nur relative Importe`);
    assert.ok(!/react|support\.js|fonts\.googleapis/i.test(src), `${f}: keine Design-Tool-Abhängigkeiten`);
  }
  assert.ok(!/fonts\.googleapis/.test(read('css/app.css')) && !/fonts\.googleapis|react/i.test(read('index.html')));
});

test('Navigation: vier Unterseiten als Ansichten, Kacheln öffnen sie', () => {
  const app = read('js/app.js');
  for (const route of Object.values(SUBPAGES)) assert.ok(app.includes(`'${route}':`), `Route ${route}`);
  assert.deepEqual(Object.keys(SUBPAGES), AREAS.map((a) => a.id));
  const lz = read('js/views/lernzentrum-view.js');
  assert.ok(lz.includes('data-nav="${SUBPAGES[t.id]}"'));
  for (const f of ['js/views/lz-karten-view.js', 'js/views/lz-table-view.js', 'js/views/lz-study-view.js', 'js/views/lz-brain-view.js']) {
    assert.ok(read(f).includes("lzHeader("), `${f}: einheitliche Kopfzeile mit Zurück`);
  }
  assert.ok(read('js/views/lz-common.js').includes('data-nav="lernzentrum"'));
});

test('Offline: alle neuen Dateien im Service Worker, Version 0.11.0', () => {
  const sw = read('sw.js');
  for (const f of NEW_FILES) assert.ok(sw.includes(`'./${f}'`), `${f} offline verfügbar`);
  assert.match(sw, /bj-assistent-v0\.11\.0/);
  assert.match(read('js/core/version.js'), /APP_VERSION = '0\.11\.0/);
  assert.match(read('package.json'), /"version": "0\.11\.0"/);
});
