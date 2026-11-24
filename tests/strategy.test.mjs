// Tests Phase 5: Strategie-Engine, Strategieprofile, Rechenmodell, KI-Recherche.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decide, ACTIONS } from '../js/strategy/engine.js';
import { standardCode, standardTable, DEFAULT_RULES, ROWS, UPCARDS, cellKey } from '../js/strategy/standard.js';
import { ProfileStore, migrate, STANDARD_ID, PROFILES_KEY } from '../js/strategy/profiles.js';
import { computeStrategy, strategyEV, profilePolicy, dealerDistribution } from '../js/strategy/ev.js';
import { analyzeProfile } from '../js/strategy/analysis.js';
import { Simulation } from '../js/strategy/simulate.js';
import {
  developStrategy, RemoteResearchProvider, validateEndpoint, validateResearchResponse, codesEquivalent
} from '../js/strategy/research.js';
import { DEMO_SCENARIOS } from '../js/demo/scenarios.js';
import { Emitter } from '../js/core/events.js';

const R = DEFAULT_RULES; // 6 Decks, S17, DAS, spätes Aufgeben, 3:2
const H17 = { ...R, soft17: 'zieht' };
const c = (...ranks) => ranks.map((rank) => ({ rank, confident: true }));
const up = (rank) => ({ rank, confident: true });
const act = (cards, u, rules = R, extra = {}) => decide(c(...cards), up(u), { rules, ...extra }).action;

// --- Hilfen: Speicher und Einstellungen ohne Browser ---------------------
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
  setRule(k, v) { this.rules[k] = v; this.emit('change', { path: `rules.${k}`, value: v }); }
}
const store = (storage = memoryStorage(), settings = new FakeSettings()) => new ProfileStore({ settings, storage });

// --- 7. Harte und weiche Hände -------------------------------------------
test('Strategie: harte Hände (Standard, 6 Decks S17)', () => {
  assert.equal(act(['10', '6'], '6'), ACTIONS.STAND);
  assert.equal(act(['10', '2'], '3'), ACTIONS.HIT);
  assert.equal(act(['10', '2'], '4'), ACTIONS.STAND);
  assert.equal(act(['7', '5'], '9'), ACTIONS.HIT);
  assert.equal(act(['6', '3'], '3'), ACTIONS.DOUBLE);
  assert.equal(act(['6', '3'], '2'), ACTIONS.HIT);
  assert.equal(act(['6', '4'], '9'), ACTIONS.DOUBLE);
  assert.equal(act(['6', '4'], 'K'), ACTIONS.HIT);
  assert.equal(act(['6', '5'], 'A'), ACTIONS.HIT);
  // Ab 0.6.0 kein Aufgeben: 16 und 15 gegen 10 = Ziehen
  assert.equal(act(['9', '7'], '10'), ACTIONS.HIT);
  assert.equal(act(['9', '6'], '10'), ACTIONS.HIT);
  assert.equal(act(['9', '6'], '9'), ACTIONS.HIT);
  assert.equal(act(['10', '7'], 'A'), ACTIONS.STAND);
});

test('Strategie: weiche Hände', () => {
  assert.equal(act(['A', '2'], '5'), ACTIONS.DOUBLE);
  assert.equal(act(['A', '2'], '4'), ACTIONS.HIT);
  assert.equal(act(['A', '4'], '4'), ACTIONS.DOUBLE);
  assert.equal(act(['A', '6'], '3'), ACTIONS.DOUBLE);
  assert.equal(act(['A', '7'], '2'), ACTIONS.STAND);
  assert.equal(act(['A', '7'], '4'), ACTIONS.DOUBLE);
  assert.equal(act(['A', '7'], '9'), ACTIONS.HIT);
  assert.equal(act(['A', '8'], '6'), ACTIONS.STAND);
  assert.equal(act(['A', '7', '2'], '3'), ACTIONS.STAND);
  // Verdoppeln mit 3 Karten nicht möglich -> Rückfall
  assert.equal(act(['A', '3', '4'], '4'), ACTIONS.STAND, 'Ds wird ohne Verdoppeln zu Stehen');
  assert.equal(act(['A', '2', '2'], '5'), ACTIONS.HIT, 'D wird ohne Verdoppeln zu Ziehen');
});

// --- 8. Paare -------------------------------------------------------------
test('Strategie: Paare', () => {
  assert.equal(act(['A', 'A'], '10'), ACTIONS.SPLIT);
  assert.equal(act(['8', '8'], 'A'), ACTIONS.SPLIT);
  assert.equal(act(['8', '8'], '10'), ACTIONS.SPLIT, '8,8 nie aufgeben (S17)');
  assert.equal(act(['10', 'K'], '6'), ACTIONS.STAND, 'Zehner nie splitten');
  assert.equal(act(['5', '5'], '6'), ACTIONS.DOUBLE, '5,5 wie harte 10');
  assert.equal(act(['9', '9'], '7'), ACTIONS.STAND);
  assert.equal(act(['9', '9'], '8'), ACTIONS.SPLIT);
  assert.equal(act(['7', '7'], '7'), ACTIONS.SPLIT);
  assert.equal(act(['7', '7'], '8'), ACTIONS.HIT);
  assert.equal(act(['6', '6'], '2'), ACTIONS.SPLIT);
  assert.equal(act(['4', '4'], '5'), ACTIONS.SPLIT);
  assert.equal(act(['2', '2'], '3'), ACTIONS.SPLIT);
  assert.equal(act(['2', '2'], '8'), ACTIONS.HIT);
  // Nach einem Split wird nicht erneut gesplittet
  assert.equal(act(['8', '8'], '6', R, { afterSplit: true }), ACTIONS.STAND);
});

// --- 9. Tischregeln --------------------------------------------------------
test('Strategie: Tischregeln verändern die Empfehlung', () => {
  assert.equal(act(['6', '5'], 'A', H17), ACTIONS.DOUBLE, 'H17: 11 gegen Ass verdoppeln');
  assert.equal(act(['A', '7'], '2', H17), ACTIONS.DOUBLE, 'H17: Soft 18 gegen 2 verdoppeln');
  assert.equal(act(['A', '8'], '6', H17), ACTIONS.DOUBLE, 'H17: Soft 19 gegen 6 verdoppeln');
  assert.equal(act(['10', '5'], 'A', H17), ACTIONS.HIT, 'H17: 15 gegen Ass ziehen (kein Aufgeben)');
  assert.equal(act(['10', '7'], 'A', H17), ACTIONS.STAND, 'H17: 17 gegen Ass stehen');
  assert.equal(act(['8', '8'], 'A', H17), ACTIONS.SPLIT, 'H17: 8,8 gegen Ass splitten');
  const noDas = { ...R, das: false };
  assert.equal(act(['2', '2'], '2', noDas), ACTIONS.HIT);
  assert.equal(act(['4', '4'], '5', noDas), ACTIONS.HIT);
  assert.equal(act(['6', '6'], '2', noDas), ACTIONS.HIT);
  assert.equal(act(['6', '6'], '3', noDas), ACTIONS.SPLIT);
  // Alte Regel "Aufgeben erlaubt" wird ignoriert
  assert.equal(act(['9', '7'], '10', { ...R, surrender: 'spaet' }), ACTIONS.HIT, 'alte Aufgeben-Regel wirkt nicht mehr');
  // Ungültige Aktionen ausgeschlossen: kein Verdoppeln nach Split ohne DAS
  assert.equal(act(['6', '5'], '6', noDas, { afterSplit: true }), ACTIONS.HIT);
  assert.equal(act(['6', '5'], '6', R, { afterSplit: true }), ACTIONS.DOUBLE);
  assert.equal(act(['9', '7'], '10', R, { afterSplit: true }), ACTIONS.HIT);
});

test('Strategie: keine Empfehlung bei Blackjack, Überkauft, unsicheren Karten', () => {
  assert.equal(decide(c('A', 'K'), up('6'), { rules: R }).reason, 'blackjack');
  assert.equal(decide(c('K', 'Q', '5'), up('6'), { rules: R }).reason, 'ueberkauft');
  assert.equal(decide([{ rank: '?', confident: false }, { rank: '9' }], up('6'), { rules: R }).action, null);
  assert.equal(decide(c('9', '7'), null, { rules: R }).action, null);
});

test('Bestehende Demo-Empfehlungen bleiben mit der Standardstrategie unverändert', () => {
  const map = { HIT: 'ZIEHEN', STAND: 'STEHEN', DOUBLE: 'VERDOPPELN', SPLIT: 'SPLITTEN' };
  for (const s of DEMO_SCENARIOS.filter((x) => x.recommendation)) {
    const d = decide(s.player, s.dealerUp, { rules: R });
    assert.equal(map[d.action], s.recommendation, s.id);
  }
});

test('Profil-Abweichung und Rückfall auf Standard bei ungültiger Zelle', () => {
  const d = decide(c('10', '6'), up('10'), { rules: R, overrides: { 'hard:16:10': 'S' } });
  assert.equal(d.action, ACTIONS.STAND);
  assert.equal(d.source, 'profile');
  assert.equal(d.deviates, true);
  assert.equal(d.standardAction, ACTIONS.HIT);
  const bad = decide(c('10', '6'), up('10'), { rules: R, overrides: { 'hard:16:10': 'P' } });
  assert.equal(bad.source, 'fallback');
  assert.equal(bad.action, ACTIONS.HIT);
});

// --- Rechenmodell -----------------------------------------------------------
test('Rechenmodell: Dealerverteilung summiert zu 1', () => {
  for (const u of UPCARDS) {
    const d = dealerDistribution(u, R);
    assert.ok(Math.abs(d.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  }
});

test('Rechenmodell bestätigt die Standardstrategie bis auf bekannte Grenzfälle', () => {
  for (const rules of [R, H17, { ...R, das: false }, { ...R, surrender: 'keine' }]) {
    const calc = computeStrategy(rules);
    const std = standardTable(rules);
    const diffs = Object.keys(std).filter((k) => !k.endsWith(':21:2') && !/^(hard|soft):21:/.test(k) && !codesEquivalent(std[k], calc.cells[k].code, rules, k));
    // Bekannt: Modell mit unendlichem Deck zieht bei A,2 gegen 5 und A,4 gegen 4 (knapp).
    for (const k of diffs) assert.ok(['soft:13:5', 'soft:15:4'].includes(k), `${k}: std ${std[k]} / Modell ${calc.cells[k].code}`);
  }
});

test('Rechenmodell: Erwartungswert plausibel und Standard nahe am Modellbesten', () => {
  const best = strategyEV(R).ev;
  const std = strategyEV(R, profilePolicy(null, R, R)).ev;
  assert.ok(best < 0 && best > -0.01, `Modell: ${best}`);
  assert.ok(best - std < 0.0005, 'Standard höchstens 0,05 % schlechter');
  assert.ok(strategyEV(H17).ev < best, 'H17 ist schlechter für den Spieler');
  assert.ok(strategyEV({ ...R, payout: '6:5' }).ev < best - 0.01, '6:5 kostet über 1 %');
});

test('Analyse: Abweichungen kosten Erwartungswert', () => {
  const prof = { overrides: { 'hard:16:10': 'S' }, settings: { followTableRules: true }, rules: R };
  const a = analyzeProfile(prof, R);
  assert.equal(a.computed.vsStandard.length, 1);
  assert.ok(a.computed.evProfile < a.computed.evStandard);
  assert.ok(a.assumptions.length > 3);
});

test('Simulation ist reproduzierbar (gleicher Startwert)', () => {
  const a = new Simulation({ rules: R, seed: 42 }).step(20000);
  const b = new Simulation({ rules: R, seed: 42 }).step(20000);
  const d = new Simulation({ rules: R, seed: 43 }).step(20000);
  assert.equal(a.ev, b.ev);
  assert.notEqual(a.ev, d.ev);
  assert.ok(a.ci95[0] < a.ev && a.ev < a.ci95[1]);
});

// --- 1.–5. Profile ---------------------------------------------------------
test('Profile: mehrere Profile, genau eines aktiv, Wechsel', () => {
  const s = store();
  const a = s.create({ name: 'Casino A' });
  const b = s.create({ name: 'Casino B' });
  s.create({ name: 'Casino A' }); // gleicher Name -> eindeutig gemacht
  assert.equal(s.list().length, 4, 'Standard + 3 eigene');
  assert.equal(new Set(s.list().map((p) => p.name)).size, 4);
  assert.equal(s.activeId, STANDARD_ID);
  s.activate(a.id);
  assert.equal(s.active.id, a.id);
  s.activate(b.id);
  assert.equal(s.active.id, b.id);
  assert.equal(s.list().filter((p) => p.id === s.activeId).length, 1);
});

test('Profile: speichern und wiederherstellen (App neu öffnen)', () => {
  const storage = memoryStorage();
  const s1 = store(storage);
  const p = s1.create({ name: 'Mein Profil', description: 'Test' });
  s1.setCell(p.id, 'hard:16:10', 'S');
  s1.activate(p.id);
  const s2 = store(storage);
  assert.equal(s2.activeId, p.id);
  assert.equal(s2.get(p.id).overrides['hard:16:10'], 'S');
  assert.equal(s2.get(p.id).description, 'Test');
});

test('Profile: bearbeiten, umbenennen, duplizieren, löschen', () => {
  const s = store();
  const p = s.create({ name: 'Alt' });
  s.rename(p.id, 'Neu');
  assert.equal(s.get(p.id).name, 'Neu');
  s.update(p.id, { description: 'Beschreibung', followTableRules: false, rules: { ...R, decks: 2 } });
  assert.equal(s.get(p.id).rules.decks, 2);
  assert.throws(() => s.setCell(p.id, 'hard:16:10', 'P'), /nicht möglich/);
  const copy = s.duplicate(p.id);
  assert.notEqual(copy.id, p.id);
  assert.equal(copy.rules.decks, 2);
  s.activate(p.id);
  assert.throws(() => s.remove(p.id), /aktive Profil/);
  s.activate(copy.id);
  s.remove(p.id);
  assert.equal(s.get(p.id), null);
  assert.throws(() => s.remove(STANDARD_ID), /Standardstrategie/);
  assert.throws(() => s.setCell(STANDARD_ID, 'hard:16:10', 'S'), /Standardstrategie/);
});

test('Profile: kein unkontrolliertes Überschreiben (zweites Fenster)', () => {
  const storage = memoryStorage();
  const s1 = store(storage);
  const s2 = store(storage);
  s1.create({ name: 'Von Fenster 1' });
  assert.throws(() => s2.create({ name: 'Von Fenster 2' }), /an anderer Stelle geändert/);
  // Nach dem Neuladen enthält Fenster 2 das Profil von Fenster 1 und kann speichern.
  assert.ok(s2.list().some((p) => p.name === 'Von Fenster 1'));
  s2.create({ name: 'Von Fenster 2' });
  assert.equal(store(storage).list().length, 3);
});

// --- 6./12. Migration und Rückwärtskompatibilität ---------------------------
test('Migration von 0.4.0: Standardprofil aktiv, andere Daten unberührt', () => {
  const old = {
    settings: { roundMode: 'automatisch', rules: { decks: 8, soft17: 'zieht', das: false, surrender: 'keine', payout: '6:5' } },
    calibration: { version: 1, regions: {} },
    templates: { version: 1, consent: true, items: [] }
  };
  const storage = memoryStorage(old);
  const s = store(storage, new FakeSettings(old.settings.rules));
  assert.equal(s.activeId, STANDARD_ID);
  assert.equal(s.active.rules.decks, 8);
  assert.ok(storage.data[PROFILES_KEY]);
  assert.deepEqual(storage.data.settings, old.settings);
  assert.deepEqual(storage.data.calibration, old.calibration);
  assert.deepEqual(storage.data.templates, old.templates);
});

test('Rückwärtskompatibilität: beschädigte Einträge werden aufbewahrt, nicht gelöscht', () => {
  const raw = {
    version: 1, rev: 3, activeId: 'gibts-nicht',
    profiles: [
      { id: 'ok1', name: 'Gut', type: 'custom', rules: R, overrides: { 'hard:16:10': 'S', 'quatsch': 'X' }, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'bad', type: 'unbekannt' },
      'kein Objekt'
    ]
  };
  const m = migrate(raw, R);
  assert.equal(m.activeId, STANDARD_ID, 'unbekannte aktive ID -> Standard');
  assert.ok(m.profiles.some((p) => p.id === 'ok1'));
  assert.deepEqual(m.profiles.find((p) => p.id === 'ok1').overrides, { 'hard:16:10': 'S' });
  assert.equal(m.invalid.length, 2);
  const storage = memoryStorage({ [PROFILES_KEY]: raw });
  const s = store(storage);
  s.create({ name: 'Neu' });
  assert.equal(storage.data[PROFILES_KEY].invalid.length, 2, 'beim Speichern erhalten');
});

test('Rückwärtskompatibilität: neueres Datenformat wird nie überschrieben', () => {
  const raw = { version: 99, profiles: [{ future: true }] };
  const storage = memoryStorage({ [PROFILES_KEY]: raw });
  const s = store(storage);
  assert.equal(s.readOnly, true);
  assert.throws(() => s.create({ name: 'x' }));
  assert.deepEqual(storage.data[PROFILES_KEY], raw);
});

test('Standardprofil folgt den Tischregeln ohne Neuladen', () => {
  const settings = new FakeSettings();
  const s = store(memoryStorage(), settings);
  let changed = 0;
  s.on('change', () => changed++);
  settings.setRule('soft17', 'zieht');
  assert.equal(s.active.rules.soft17, 'zieht');
  assert.ok(changed > 0);
  const st = s.strategyFor();
  assert.equal(decide(c('6', '5'), up('A'), { rules: settings.rules, strategyRules: st.strategyRules, overrides: st.overrides }).action, ACTIONS.DOUBLE);
});

// --- 10./11. KI-Strategie: offline und fehlgeschlagene Recherche -------------
test('KI-Strategie: offline -> berechnete Strategie, Recherche ehrlich als offline markiert', async () => {
  const remote = new RemoteResearchProvider({ endpoint: 'https://example.org/research', consentAt: '2026-11-22', online: () => false, fetchImpl: () => { throw new Error('darf nicht aufgerufen werden'); } });
  const out = await developStrategy(R, { remote, useOnline: true });
  assert.equal(out.data.research.status, 'offline');
  assert.ok(Object.keys(out.overrides).length <= 3);
  assert.ok(!out.data.research.sources, 'keine erfundenen Quellen');
});

test('KI-Strategie: ohne eingerichteten Server wird nichts gesendet', async () => {
  let called = false;
  const remote = new RemoteResearchProvider({ online: () => true, fetchImpl: () => { called = true; } });
  const out = await developStrategy(R, { remote, useOnline: true });
  assert.equal(out.data.research.status, 'not-configured');
  assert.equal(called, false);
});

test('KI-Strategie: fehlgeschlagene Recherche (Netzwerk, HTTP, ungültige Antwort)', async () => {
  const mk = (fetchImpl) => new RemoteResearchProvider({ endpoint: 'https://example.org/r', consentAt: 'x', online: () => true, fetchImpl });
  let out = await developStrategy(R, { remote: mk(async () => { throw new TypeError('Failed to fetch'); }), useOnline: true });
  assert.equal(out.data.research.status, 'failed');
  out = await developStrategy(R, { remote: mk(async () => ({ ok: false, status: 500 })), useOnline: true });
  assert.equal(out.data.research.status, 'failed');
  out = await developStrategy(R, { remote: mk(async () => ({ ok: true, json: async () => ({ summary: 'ohne Quellen' }) })), useOnline: true });
  assert.equal(out.data.research.status, 'invalid');
  // Strategie trotzdem vorhanden
  assert.ok(out.overrides);
});

test('KI-Strategie: Vorschläge werden mit dem Rechenmodell geprüft', async () => {
  const body = {
    summary: 'Test', sources: [{ title: 'Quelle', url: 'https://example.org/a', retrievedAt: '2026-11-22' }],
    suggestions: [{ key: 'hard:16:10', code: 'Rh' }, { key: 'hard:12:4', code: 'H' }]
  };
  const remote = new RemoteResearchProvider({ endpoint: 'https://example.org/r', consentAt: 'x', online: () => true, fetchImpl: async () => ({ ok: true, json: async () => body }) });
  const out = await developStrategy(R, { remote, useOnline: true });
  assert.equal(out.data.research.status, 'ok');
  assert.equal(out.data.research.suggestions[0].verdict, 'bestätigt');
  assert.equal(out.data.research.suggestions[1].verdict, 'widerspricht dem Rechenmodell');
});

test('KI-Strategie: Server-Adresse ohne Schlüssel und nur https', () => {
  assert.throws(() => validateEndpoint('http://example.org'), /https/);
  assert.throws(() => validateEndpoint('https://example.org/?api_key=geheim'), /Schlüssel/);
  assert.throws(() => validateEndpoint('https://user:pw@example.org'), /Zugangsdaten/);
  assert.equal(validateEndpoint('https://example.org/research'), 'https://example.org/research');
  assert.throws(() => validateResearchResponse({ sources: [{ title: 'x', url: 'http://unsicher', retrievedAt: '2026' }] }));
});

test('Alle Zellen der Standardtabelle sind gültig', () => {
  for (const kind of Object.keys(ROWS)) for (const v of ROWS[kind]) for (const u of UPCARDS) {
    assert.ok(standardCode(kind, v, u, R), cellKey(kind, v, u));
  }
});
