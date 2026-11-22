// Tests für Phase 6 (Version 0.6.0): YUMEKO, Spielarchiv, gemeinsames Dealer-Feld,
// Entfernen von Aufgeben, Migration. Aufruf: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CardTracker } from '../js/game/card-tracker.js';
import { RoundState } from '../js/game/round-state.js';
import { settleHand, dealerFinal } from '../js/game/settle.js';
import { RoundTracker } from '../js/recognition/round-tracker.js';
import { migrateCalibrationV1, REGION_DEFS, CALIBRATION_VERSION } from '../js/calibration/calibration-store.js';
import { MemoryDatabase } from '../js/core/idb.js';
import { ArchiveStore, EXPORT_FORMAT } from '../js/archive/archive-store.js';
import { validateRound, filterRounds, summarizeRounds, roundOutcome } from '../js/archive/round-record.js';
import { KnowledgeStore, STATUS } from '../js/yumeko/knowledge.js';
import { analyzeArchive, decisionEVs } from '../js/yumeko/archive-analysis.js';
import { Yumeko, buildDraft, verifyVersion, checkShownDecision } from '../js/yumeko/yumeko.js';
import { SceneDetector } from '../js/yumeko/video-learner.js';
import { decide, ACTIONS } from '../js/strategy/engine.js';
import { DEFAULT_RULES, standardTable, CODES, CODES_BY_KIND, normalizeRules, rulesText } from '../js/strategy/standard.js';
import { ProfileStore, migrate, STANDARD_ID, YUMEKO_ID, PROFILES_KEY } from '../js/strategy/profiles.js';
import { Emitter } from '../js/core/events.js';
import { RECOMMENDATIONS } from '../js/demo/scenarios.js';

const R = DEFAULT_RULES;
const det = (rank, x, y = 0.2, score = 0.95) => ({ rank, score, confident: true, box: { x, y, w: 0.02, h: 0.04 } });
const advise = (cards, up, afterSplit) => decide(cards, up, { rules: R, afterSplit });

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    load: (k, fb) => (k in data ? JSON.parse(JSON.stringify(data[k])) : fb),
    save: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); return true; }
  };
}
class FakeSettings extends Emitter {
  constructor(rules = R) { super(); this.rules = { ...rules }; }
  get(path) { return path === 'rules' ? this.rules : undefined; }
}

// Runde mehrfach (stabil) einspeisen.
function feed(round, result, times = 2, t0 = 0) {
  let now = t0;
  for (let i = 0; i < times; i++) { now += 250; round.update(result, now); }
  return now;
}

// Archiv-Eintrag für Analysen erzeugen.
function makeRound(id, { player, dealer, actions, rules = R }) {
  const r = new RoundState({ id, startedAt: Date.parse('2026-11-22T10:00:00Z'), advise });
  let now = Date.parse('2026-11-22T10:00:00Z');
  const shown = { dealer: [det(dealer[0], 0.4)], player: [], split: [] };
  player.forEach((p, i) => {
    shown.player = player.slice(0, i + 1).map((rank, k) => det(rank, 0.3 + k * 0.05, 0.7));
    if (i >= 1) now = feed(r, shown, 2, now);
  });
  shown.dealer = dealer.map((rank, k) => det(rank, 0.4 + k * 0.05));
  now = feed(r, shown, 2, now);
  const rec = r.toRecord({ endedAt: now, rules, profile: { id: 'standard', name: 'Standardstrategie', type: 'standard' } });
  if (actions) rec.hands[0].actions = actions;
  return rec;
}

// --- 9./10. Gemeinsames Dealer-Feld, verdeckte Karte ---------------------
test('Dealer-Feld: offene Karte, verdeckte Karte unbekannt, Aufdecken, weitere Karten', () => {
  const r = new RoundState({ advise });
  let now = feed(r, { dealer: [det('6', 0.40)], player: [det('10', 0.3, 0.7), det('6', 0.35, 0.7)], split: [] });
  let s = r.snapshot();
  assert.equal(s.up.rank, '6');
  assert.equal(s.holeKnown, false, 'verdeckte Karte ist unbekannt');
  assert.equal(s.dealer.length, 1);
  // Empfehlung nutzt nur die offene Karte
  assert.equal(advise(s.hands[0].cards, s.up).action, ACTIONS.STAND);
  // Aufdecken im selben Feld
  now = feed(r, { dealer: [det('6', 0.40), det('10', 0.45)], player: [det('10', 0.3, 0.7), det('6', 0.35, 0.7)], split: [] }, 2, now);
  s = r.snapshot();
  assert.equal(s.holeKnown, true);
  assert.deepEqual(s.dealer.map((c) => c.rank), ['6', '10']);
  // Weitere Karte, Karten leicht verschoben -> keine Doppelzählung
  feed(r, { dealer: [det('6', 0.405, 0.21), det('10', 0.455), det('5', 0.5)], player: [det('10', 0.3, 0.7), det('6', 0.35, 0.7)], split: [] }, 2, now);
  s = r.snapshot();
  assert.deepEqual(s.dealer.map((c) => c.rank), ['6', '10', '5']);
  assert.equal(s.extra.length, 1);
});

test('Dealer-Feld: Karte wird erst nach mehrfacher Erkennung bestätigt', () => {
  const t = new CardTracker({ confirmFrames: 2 });
  assert.equal(t.update([det('7', 0.4)]).length, 0, 'einmal gesehen = noch nicht bestätigt');
  assert.equal(t.update([det('7', 0.4)]).length, 1);
  // Kurz verdeckt: bestätigte Karte bleibt erhalten
  t.update([]);
  assert.equal(t.confirmed().length, 1);
  // Einmaliger Fehltreffer verschwindet wieder
  t.update([det('7', 0.4), det('3', 0.6)]);
  t.update([det('7', 0.4)]);
  assert.equal(t.confirmed().length, 1);
  assert.equal(t.pending().length, 0);
});

// --- 8. Doppelte Kartenerkennung verhindern -----------------------------
test('Doppelte Kartenerkennung wird verhindert (Bewegung, Wiederholung)', () => {
  const t = new CardTracker();
  t.update([det('K', 0.40)]); t.update([det('K', 0.40)]);
  for (let i = 0; i < 5; i++) t.update([det('K', 0.40 + i * 0.004)]);
  assert.equal(t.confirmed().length, 1, 'gleiche Karte, leicht bewegt');
  // Karte wird weiter weg geschoben (fehlt an alter Stelle) -> dieselbe Karte
  t.update([det('K', 0.62)]); t.update([det('K', 0.62)]);
  assert.equal(t.confirmed().length, 1, 'verschobene Karte nicht doppelt');
  // Zehner-Wertklasse: Q statt K an gleicher Stelle zählt nicht doppelt
  t.update([det('Q', 0.62)]);
  assert.equal(t.confirmed().length, 1);
  // Eine echte zweite Karte desselben Werts an anderer Stelle wird gezählt
  t.update([det('K', 0.62), det('K', 0.8)]); t.update([det('K', 0.62), det('K', 0.8)]);
  assert.equal(t.confirmed().length, 2);
});

test('Kurz keine Karten sichtbar beendet die Runde nicht', () => {
  const r = new RoundState({ advise });
  let now = feed(r, { dealer: [det('9', 0.4)], player: [det('10', 0.3, 0.7), det('7', 0.35, 0.7)], split: [] });
  r.update({ dealer: [], player: [], split: [] }, now + 250);
  assert.equal(r.endedByEmpty(now + 1500), false);
  now = feed(r, { dealer: [det('9', 0.4)], player: [det('10', 0.3, 0.7), det('7', 0.35, 0.7)], split: [] }, 2, now + 1500);
  assert.equal(r.snapshot().hands[0].cards.length, 2, 'keine doppelten Karten nach der Lücke');
  r.update({ dealer: [], player: [], split: [] }, now + 250);
  assert.equal(r.endedByEmpty(now + 6000), true, 'lange leer = Runde beendet');
  // RoundTracker: kurze Lücke -> keine neue Runde
  const t = new RoundTracker({ auto: true });
  const raw = (dealer, player) => ({ dealer: dealer.map((x) => det(x, 0.4)), player: player.map((x, i) => det(x, 0.3 + i * 0.05, 0.7)), split: [], unsure: false, cardFaceWithoutRank: false });
  const evs = [];
  const push = (rw, ms) => evs.push(...t.push(rw, ms).events.map((e) => e.type));
  push(raw(['9'], ['10', '7']), 0); push(raw(['9'], ['10', '7']), 250);
  push(raw([], []), 500); push(raw([], []), 750);
  push(raw(['9'], ['10', '7']), 1500); push(raw(['9'], ['10', '7']), 1750);
  assert.equal(evs.filter((e) => e === 'round-start').length, 1, 'kurze Lücke: gleiche Runde');
  push(raw([], []), 2000); push(raw([], []), 2250);
  push(raw(['5'], ['3', '4']), 6000); push(raw(['5'], ['3', '4']), 6250);
  assert.equal(evs.filter((e) => e === 'round-start').length, 2, 'lange leer: neue Runde');
});

// --- 3./4. Spielrunden speichern, Gewonnen/Verloren/Push ------------------
test('Ergebnis: Gewonnen, Verloren, Push und unvollständig', () => {
  const h = (...r) => ({ cards: r.map((rank) => ({ rank })) });
  const d = (...r) => r.map((rank) => ({ rank }));
  assert.equal(settleHand(h('10', '9'), d('10', '7'), R).outcome, 'win');
  assert.equal(settleHand(h('10', '6'), d('10', '7'), R).outcome, 'loss');
  assert.equal(settleHand(h('10', '7'), d('10', '7'), R).outcome, 'push');
  assert.equal(settleHand(h('10', '6', '9'), d('6'), R).outcome, 'loss', 'überkauft = verloren, auch ohne Dealerkarten');
  assert.equal(settleHand(h('10', '6'), d('6', '10', '9'), R).outcome, 'win', 'Dealer überkauft');
  assert.equal(settleHand(h('A', 'K'), d('6'), R).outcome, 'win', 'Blackjack gegen 6');
  assert.equal(settleHand(h('A', 'K'), d('10'), R).outcome, null, 'Blackjack gegen 10: zweite Karte nötig');
  assert.equal(settleHand(h('10', '8'), d('6'), R).outcome, null, 'verdeckte Karte unbekannt -> kein Ergebnis');
  assert.equal(settleHand(h('10', '8'), d('6', '10'), R).outcome, null, 'Dealer 16 muss noch ziehen');
  assert.equal(dealerFinal(d('A', '6'), R), true, 'S17: weiche 17 steht');
  assert.equal(dealerFinal(d('A', '6'), { ...R, soft17: 'zieht' }), false, 'H17: weiche 17 zieht');
});

test('Spielrunde wird mit Aktionen, Empfehlungen und Ergebnis archiviert', () => {
  const rec = makeRound('r_test1', { player: ['10', '2', '9'], dealer: ['4', '10', '8'] });
  assert.equal(rec.status, 'complete');
  assert.equal(rec.hands[0].outcome, 'win', '21 gegen 22');
  const hit = rec.hands[0].actions.find((a) => a.action === 'HIT');
  assert.ok(hit, 'Ziehen erkannt');
  assert.deepEqual(hit.cardsBefore, ['10', '2']);
  assert.equal(hit.recommended, 'STAND', 'Empfehlung zum Zeitpunkt: 12 gegen 4 stehen');
  assert.deepEqual(rec.dealer.cards.map((c) => c.role), ['up', 'hole', 'hit']);
  assert.equal(rec.rules.decks, 6);
  assert.equal(rec.profile.id, 'standard');
  assert.ok(rec.recognition.minScore > 0.9);
  const inc = makeRound('r_test2', { player: ['10', '8'], dealer: ['6'] });
  assert.equal(inc.status, 'incomplete', 'Dealer-Endstand fehlt');
  assert.equal(inc.hands[0].outcome, null);
});

// --- 5. Split-Hände separat ------------------------------------------------
test('Split-Hände werden getrennt verwaltet und bewertet', () => {
  const r = new RoundState({ advise });
  let now = feed(r, { dealer: [det('6', 0.4)], player: [det('8', 0.3, 0.7), det('8', 0.35, 0.7)], split: [] });
  // Zweite 8 wandert in den Split-Bereich C
  now = feed(r, { dealer: [det('6', 0.4)], player: [det('8', 0.3, 0.7)], split: [det('8', 0.7, 0.7)] }, 2, now);
  assert.equal(r.hands.length, 2);
  assert.equal(r.hands[0].actions[0].action, 'SPLIT');
  assert.equal(r.hands[0].actions[0].recommended, 'SPLIT');
  now = feed(r, { dealer: [det('6', 0.4)], player: [det('8', 0.3, 0.7), det('3', 0.35, 0.7)], split: [det('8', 0.7, 0.7), det('K', 0.75, 0.7)] }, 2, now);
  const s = r.snapshot();
  assert.deepEqual(s.hands[0].cards.map((c) => c.rank), ['8', '3']);
  assert.deepEqual(s.hands[1].cards.map((c) => c.rank), ['8', 'K']);
  now = feed(r, { dealer: [det('6', 0.4), det('10', 0.45), det('9', 0.5)], player: [det('8', 0.3, 0.7), det('3', 0.35, 0.7)], split: [det('8', 0.7, 0.7), det('K', 0.75, 0.7)] }, 2, now);
  const rec = r.toRecord({ endedAt: now, rules: R });
  assert.equal(rec.hands.length, 2);
  assert.equal(rec.hands[0].outcome, 'win');
  assert.equal(rec.hands[1].outcome, 'win');
  assert.equal(rec.hands[1].split, true);
  assert.equal(rec.hands[0].blackjack, false);
});

// --- 6. Export/Import --------------------------------------------------------
test('Archiv: speichern, korrigieren, suchen, filtern, exportieren, importieren, löschen', async () => {
  const a = new ArchiveStore({ db: new MemoryDatabase() });
  await a.ready();
  await a.add(makeRound('r_a', { player: ['10', '9'], dealer: ['10', '7'] }));
  await a.add(makeRound('r_b', { player: ['10', '6'], dealer: ['10', '7'] }));
  await a.add(makeRound('r_c', { player: ['10', '8'], dealer: ['6'] }));
  assert.equal(a.rounds.length, 3);
  assert.equal(roundOutcome(a.get('r_a')), 'win');
  assert.equal(roundOutcome(a.get('r_b')), 'loss');
  assert.equal(filterRounds(a.rounds, { outcome: 'win' }).length, 1);
  assert.equal(filterRounds(a.rounds, { outcome: 'open' }).length, 1);
  assert.equal(filterRounds(a.rounds, { text: 'hand 16' }).length, 1);
  // Korrektur: unvollständige Runde manuell bestätigen
  await a.update('r_c', (rec) => { rec.hands[0].outcome = 'push'; rec.hands[0].outcomeSource = 'manual'; }, 'Ergebnis bestätigt');
  assert.equal(a.get('r_c').status, 'confirmed');
  assert.equal(a.get('r_c').confirmation, 'manual');
  // Kartenkorrektur berechnet neu
  await a.update('r_b', (rec) => { rec.hands[0].cards[1].rank = '9'; }, 'Karte korrigiert');
  assert.equal(a.get('r_b').hands[0].outcome, 'win');
  const s = summarizeRounds(a.rounds);
  assert.equal(s.win, 2);
  assert.equal(s.push, 1);
  // Export -> Import in leeres Archiv
  const data = JSON.parse(JSON.stringify(await a.exportData()));
  assert.equal(data.format, EXPORT_FORMAT);
  const b = new ArchiveStore({ db: new MemoryDatabase() });
  const res = await b.importData(data);
  assert.deepEqual(res, { added: 3, skipped: 0, invalid: 0 });
  assert.deepEqual(b.rounds.map((r) => r.id).sort(), ['r_a', 'r_b', 'r_c']);
  // Nochmals importieren: nichts überschrieben
  assert.deepEqual(await b.importData(data), { added: 0, skipped: 3, invalid: 0 });
  await assert.rejects(b.importData({ format: 'falsch', rounds: [] }), /Dateiformat/);
  // Einzelne Runde löschen, alles nur mit Bestätigung löschen
  await b.remove('r_a');
  assert.equal(b.rounds.length, 2);
  await assert.rejects(b.clearAll(), /bestätigen/);
  await b.clearAll({ confirmed: true });
  assert.equal(b.rounds.length, 0);
});

test('Archiv bleibt nach Neustart erhalten (dauerhafter Speicher)', async () => {
  const storage = memoryStorage();
  const a = new ArchiveStore({ db: new MemoryDatabase({ persist: storage }) });
  await a.add(makeRound('r_p', { player: ['10', '9'], dealer: ['10', '7'] }));
  const b = new ArchiveStore({ db: new MemoryDatabase({ persist: storage }) });
  await b.ready();
  assert.equal(b.rounds.length, 1);
  assert.equal(b.rounds[0].hands[0].outcome, 'win');
});

// --- 11. Surrender entfernt -------------------------------------------------
test('Aufgeben ist aus der aktiven Logik entfernt, alte Daten bleiben lesbar', () => {
  assert.equal(ACTIONS.SURRENDER, undefined);
  assert.ok(!CODES.some((c) => c.startsWith('R')));
  assert.ok(!Object.values(CODES_BY_KIND).flat().some((c) => c.startsWith('R')));
  assert.equal(RECOMMENDATIONS.AUFGEBEN, undefined);
  assert.ok(!('surrender' in normalizeRules({ surrender: 'spaet' })));
  assert.ok(!/Aufgeben/.test(rulesText({ surrender: 'spaet' })));
  for (const rules of [R, { ...R, soft17: 'zieht' }, { ...R, das: false }]) {
    for (const code of Object.values(standardTable(rules))) assert.ok(!code.startsWith('R'), code);
  }
  // Alle Kombinationen: nie Aufgeben, auch mit alter Regel
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A'];
  for (const a of ranks) for (const b of ranks) for (const u of ranks) {
    const d = decide([{ rank: a }, { rank: b }], { rank: u }, { rules: { ...R, surrender: 'spaet' } });
    assert.notEqual(d.action, 'SURRENDER');
  }
  // Alter Profilcode Rh wird ohne Aufgeben aufgelöst
  assert.equal(decide([{ rank: '10' }, { rank: '6' }], { rank: '10' }, { rules: R, overrides: { 'hard:16:10': 'Rs' } }).action, ACTIONS.STAND);
  // Alter Archiveintrag mit Aufgeben bleibt lesbar
  const old = validateRound({ id: 'r_old', startedAt: '2026-11-01T10:00:00Z', hands: [{ cards: [{ rank: '10' }, { rank: '6' }], actions: [{ action: 'SURRENDER' }], outcome: 'surrender' }], dealer: { cards: [{ rank: '10' }] } });
  assert.ok(old);
  assert.equal(old.hands[0].actions[0].action, 'SURRENDER');
  assert.equal(summarizeRounds([old]).loss, 1);
  assert.equal(analyzeArchive([old]).decisionsUsed, 0, 'Aufgeben wird nicht als Entscheidung ausgewertet');
});

// --- 12. Migration ------------------------------------------------------------
test('Migration: Kalibrierung mit zwei Dealer-Feldern -> ein Dealer-Feld', () => {
  assert.equal(CALIBRATION_VERSION, 2);
  assert.deepEqual(REGION_DEFS.map((d) => d.id), ['dealer', 'player', 'split']);
  const v1 = { version: 1, savedAt: '2026-11-21T22:18:39Z', frame: { width: 1920, height: 1080, aspect: 1.778, orientation: 'landscape' }, regions: { dealerUp: { x: 0.38, y: 0.12, w: 0.1, h: 0.22 }, dealerHole: { x: 0.5, y: 0.12, w: 0.1, h: 0.22 }, player: { x: 0.28, y: 0.56, w: 0.34, h: 0.28 }, split: { x: 0.64, y: 0.56, w: 0.3, h: 0.28 } }, splitEnabled: true };
  const m = migrateCalibrationV1(v1);
  assert.equal(m.version, 2);
  const d = m.regions.dealer;
  assert.ok(Math.abs(d.x - 0.38) < 1e-9 && Math.abs(d.y - 0.12) < 1e-9);
  assert.ok(Math.abs(d.x + d.w - 0.6) < 1e-9, 'umschliesst beide Felder');
  assert.deepEqual(m.regions.player, v1.regions.player);
  assert.equal(m.splitEnabled, true);
  assert.deepEqual(m.legacy.dealerUp, v1.regions.dealerUp, 'alte Felder bleiben nachvollziehbar');
  assert.equal(migrateCalibrationV1({ version: 1, frame: {}, regions: {} }), null);
});

test('Migration: Strategieprofile aus 0.5.0 (Aufgeben-Codes, YUMEKO ergänzt)', () => {
  const raw = {
    version: 1, rev: 4, activeId: 'p_mine',
    profiles: [
      { id: 'standard', name: 'Standardstrategie', type: 'standard', rules: { ...R, surrender: 'spaet' }, settings: { followTableRules: true }, overrides: {}, data: {}, createdAt: '2026-11-22T01:00:00Z', updatedAt: '2026-11-22T01:00:00Z' },
      { id: 'p_mine', name: 'Mein Casino', type: 'custom', rules: { ...R, surrender: 'spaet' }, settings: { followTableRules: false }, overrides: { 'hard:16:10': 'Rh', 'pair:8:11': 'Rp', 'hard:12:3': 'S' }, data: {}, createdAt: '2026-11-22T01:00:00Z', updatedAt: '2026-11-22T01:00:00Z' }
    ],
    invalid: []
  };
  const m = migrate(raw, R);
  assert.equal(m.migratedFrom, '0.5.0');
  assert.equal(m.activeId, 'p_mine', 'aktives Profil bleibt aktiv');
  const mine = m.profiles.find((p) => p.id === 'p_mine');
  assert.deepEqual(mine.overrides, { 'hard:16:10': 'H', 'pair:8:11': 'P', 'hard:12:3': 'S' });
  assert.deepEqual(mine.data.legacySurrender, { 'hard:16:10': 'Rh', 'pair:8:11': 'Rp' });
  assert.ok(!('surrender' in mine.rules));
  assert.deepEqual(m.profiles.map((p) => p.id).slice(0, 2), [STANDARD_ID, YUMEKO_ID]);
  // Gespeichert wird Version 2, Speichern erhält alles
  const storage = memoryStorage({ [PROFILES_KEY]: raw });
  const s = new ProfileStore({ settings: new FakeSettings(), storage });
  assert.equal(storage.data[PROFILES_KEY].version, 2);
  assert.equal(s.list().length, 3);
  assert.equal(s.active.id, 'p_mine');
});

// --- 1./2. Yumeko-Profil, genau ein aktives Profil ---------------------------
test('YUMEKO-Profil: vorhanden, aktivierbar, nicht löschbar, genau ein aktives Profil', () => {
  const s = new ProfileStore({ settings: new FakeSettings(), storage: memoryStorage() });
  const y = s.get(YUMEKO_ID);
  assert.equal(y.name, 'YUMEKO AI');
  assert.equal(y.description, 'Adaptive Blackjack Intelligence.');
  assert.equal(y.type, 'yumeko');
  s.activate(YUMEKO_ID);
  assert.equal(s.activeId, YUMEKO_ID);
  assert.equal(s.list().filter((p) => p.id === s.activeId).length, 1);
  const own = s.create({ name: 'Eigenes' });
  s.activate(own.id);
  assert.equal(s.activeId, own.id);
  assert.throws(() => s.remove(YUMEKO_ID), /nicht gelöscht/);
  assert.throws(() => s.setCell(YUMEKO_ID, 'hard:16:10', 'S'), /Strategieversionen/);
  assert.throws(() => s.applyYumekoVersion({ id: 'v', number: 1, overrides: {} }), /nicht mathematisch geprüft/);
  // Duplikat ist frei bearbeitbar
  const copy = s.duplicate(YUMEKO_ID);
  assert.equal(copy.type, 'custom');
});

// --- 7. Lerninformationen dauerhaft speichern ------------------------------
test('YUMEKO: Wissensspeicher bleibt erhalten, Korrigieren und Löschen', async () => {
  const storage = memoryStorage();
  const k1 = new KnowledgeStore({ db: new MemoryDatabase({ persist: storage }) });
  await k1.ready();
  await k1.upsert({ id: 'a:exp:test', category: 'experience', content: 'Test', status: STATUS.observed, auto: true }, { fromAnalysis: true });
  await k1.upsert({ id: 'u:1', category: 'hypothesis', content: 'Meine Vermutung', status: STATUS.unconfirmed });
  await k1.correct('u:1', { content: 'Korrigierte Vermutung', status: STATUS.rejected });
  // App "neu öffnen"
  const k2 = new KnowledgeStore({ db: new MemoryDatabase({ persist: storage }) });
  await k2.ready();
  assert.equal(k2.items.length, 2);
  assert.equal(k2.get('u:1').content, 'Korrigierte Vermutung');
  assert.equal(k2.get('u:1').edited, true);
  // Gelöschte automatische Erkenntnis kommt bei neuer Analyse nicht zurück
  await k2.remove('a:exp:test');
  assert.equal(await k2.upsert({ id: 'a:exp:test', category: 'experience', content: 'Test', auto: true }, { fromAnalysis: true }), null);
  // Korrigierte Erkenntnis wird nicht überschrieben
  await k2.upsert({ id: 'u:1', category: 'hypothesis', content: 'Automatisch', auto: true }, { fromAnalysis: true });
  assert.equal(k2.get('u:1').content, 'Korrigierte Vermutung');
});

test('YUMEKO-Analyse: Entscheidungsqualität unabhängig vom Ergebnis, reproduzierbar', () => {
  // 16 gegen 7: gestanden und GEWONNEN -> trotzdem rechnerisch schlechter als Ziehen
  const rounds = [
    makeRound('r_1', { player: ['10', '6'], dealer: ['7', '5', 'K'] }),      // stehen, Dealer überkauft -> gewonnen
    makeRound('r_2', { player: ['10', '6'], dealer: ['7', '10'] }),          // stehen, verloren
    makeRound('r_3', { player: ['10', '6', '4'], dealer: ['7', '10'] })      // gezogen, 20 gegen 17 -> gewonnen
  ];
  const rep = analyzeArchive(rounds, { generatedAt: 'fest' });
  const rep2 = analyzeArchive([...rounds].reverse(), { generatedAt: 'fest' });
  assert.deepEqual(rep, rep2, 'gleiche Daten -> gleiches Ergebnis');
  assert.equal(rep.roundsUsed, 3);
  const m = rep.mistakes.find((x) => x.key === 'hard:16:7' && x.action === 'STAND');
  assert.ok(m, 'Stehen bei 16 gegen 7 als Fehler erkannt');
  assert.equal(m.count, 2);
  assert.equal(m.best, 'HIT');
  assert.equal(rep.luck.wrongWon, 1, 'falsche Entscheidung trotzdem gewonnen');
  assert.ok(rep.inconsistent.some((x) => x.situation.endsWith('hard:16:7')), 'unterschiedliche Entscheidungen in gleicher Lage');
  assert.equal(rep.quality.level, 'niedrig', 'wenige Daten = niedrige Verlässlichkeit');
  assert.ok(rep.outcomes.note.includes('Zufall'));
  const d = decisionEVs(['10', '6'], '10', R);
  assert.ok(d.evs.HIT > d.evs.STAND);
  // 16 gegen 10 ist knapp (unter 0,1 %) und gilt nicht als Fehler
  assert.ok(d.evs.HIT - d.evs.STAND < 0.001);
});

test('YUMEKO: Strategieentwurf, mathematische Prüfung und Bestätigung', async () => {
  const settings = new FakeSettings();
  const profiles = new ProfileStore({ settings, storage: memoryStorage() });
  const db = new MemoryDatabase();
  const archive = new ArchiveStore({ db });
  const knowledge = new KnowledgeStore({ db });
  const y = new Yumeko({ archive, knowledge, profiles, settings });
  await archive.add(makeRound('r_1', { player: ['10', '6'], dealer: ['7', '5', '8'] }));
  const rep = await y.analyzeArchive();
  assert.equal(rep.roundsUsed, 1);
  assert.ok(knowledge.byCategory('verified').some((i) => i.id.includes('hard:16:7')));
  assert.equal(y.status().fresh, 0);
  // Bestätigte Lerninformation, die die Prüfung NICHT besteht, wird nicht übernommen
  await knowledge.upsert({ id: 'u:bad', category: 'hypothesis', content: '16 gegen 10 immer stehen', status: STATUS.userConfirmed, data: { cell: { key: 'hard:12:2', code: 'D' } } });
  const draft = await y.draft();
  assert.equal(draft.status, 'entwurf');
  assert.ok(draft.basis.rejected.some((x) => x.id === 'u:bad'));
  await assert.rejects(y.confirm(draft.id), /Prüfung/);
  const checked = await y.verify(draft.id);
  assert.equal(checked.verification.ok, true, checked.verification.problems.join('; '));
  assert.ok(checked.verification.evVersion >= checked.verification.evStandard - 1e-12);
  const active = await y.confirm(draft.id);
  assert.equal(active.status, 'aktiv');
  assert.equal(profiles.get(YUMEKO_ID).data.strategyVersion, 1);
  assert.deepEqual(profiles.get(YUMEKO_ID).overrides, draft.overrides);
  // Version mit schlechter Zelle wird abgelehnt
  const bad = verifyVersion({ rules: R, overrides: { 'hard:16:10': 'S' } });
  assert.equal(bad.ok, false);
  assert.ok(buildDraft({ rules: R, number: 9 }).basis.method.includes('Rechenmodell'));
  // Erkennungskorrekturen -> zusätzliche Prüfungen für diesen Kartenwert
  await archive.update('r_1', (rec) => { rec.dealer.cards[2].rank = '7'; }, 'Karte', [{ from: '8', to: '7' }]);
  await archive.update('r_1', (rec) => { rec.dealer.cards[2].rank = '8'; }, 'Karte', [{ from: '7', to: '8' }]);
  await archive.update('r_1', (rec) => { rec.dealer.cards[2].rank = '7'; }, 'Karte', [{ from: '8', to: '7' }]);
  await archive.update('r_1', (rec) => { rec.dealer.cards[2].rank = '8'; }, 'Karte', [{ from: '8', to: '7' }]);
  await y.analyzeArchive();
  assert.equal(y.confirmFor('8'), 1);
  assert.equal(y.confirmFor('5'), 0);
});

// --- Video-Lernen ---------------------------------------------------------------
test('Video-Lernen: Szenenwechsel mit Zeitstempeln, unsichere Erkennungen markiert', () => {
  const sd = new SceneDetector({ stableFrames: 2 });
  const f = (t, cards) => sd.push(cards, t);
  f(0, [det('10', 0.3, 0.7), det('6', 0.35, 0.7), det('10', 0.4, 0.2)]);
  f(0.5, [det('10', 0.3, 0.7), det('6', 0.35, 0.7), det('10', 0.4, 0.2)]);
  f(1.0, [det('10', 0.3, 0.7), det('6', 0.35, 0.7), det('10', 0.4, 0.2)]);
  f(1.5, [det('10', 0.3, 0.7), det('6', 0.35, 0.7), det('10', 0.4, 0.2), det('5', 0.4, 0.7, 0.7)]);
  f(2.0, [det('10', 0.3, 0.7), det('6', 0.35, 0.7), det('10', 0.4, 0.2), det('5', 0.4, 0.7, 0.7)]);
  const scenes = sd.finish(2.5);
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].t0, 0);
  assert.equal(scenes[1].t0, 1.5);
  assert.equal(scenes[0].cards.find((c) => c.y < 0.5).role, 'dealer', 'obere Bildhälfte = Dealer (änderbar)');
  assert.equal(scenes[1].cards.filter((c) => c.unsure).length, 1, 'unsichere Karte markiert');
  const chk = checkShownDecision(['10', '6'], '7', 'STAND', R);
  assert.equal(chk.agrees, false);
  assert.equal(checkShownDecision(['10', '6'], '7', 'HIT', R).agrees, true);
});
