// Tests für Version 0.10.0: Grundgerüst des neuen Yumeko-Lernzentrums
// (Yumeko-Profil in den Strategieprofilen, Statistik, Ein-/Ausschalten). Keine KI-Logik.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProfileStore, migrate, STANDARD_ID, PROFILES_KEY, LEGACY_YUMEKO_KEY, YUMEKO_ID, YUMEKO_TYPE, isLockedProfile } from '../js/strategy/profiles.js';
import { yumekoStats, percentText, toggleYumeko, LERNZENTRUM_KEY, AREAS } from '../js/lernzentrum/lernzentrum.js';
import { decide } from '../js/strategy/engine.js';
import { DEFAULT_RULES } from '../js/strategy/standard.js';
import { Emitter } from '../js/core/events.js';

const R = DEFAULT_RULES;
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    load: (k, fb) => (k in data ? JSON.parse(JSON.stringify(data[k])) : fb),
    save: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); return true; }
  };
}
class FakeSettings extends Emitter { get(path) { return path === 'rules' ? R : undefined; } }
const AT = '2026-11-22T10:00:00Z';
const ownP = { id: 'p_own', name: 'Mein Profil', type: 'custom', rules: R, settings: { followTableRules: false }, overrides: { 'hard:12:3': 'S' }, data: {}, createdAt: AT, updatedAt: AT };

test('Yumeko-Profil wird erst beim Aktivieren angelegt und gespeichert', () => {
  const storage = memoryStorage();
  const s = new ProfileStore({ settings: new FakeSettings(), storage });
  assert.equal(s.yumeko, null);
  assert.equal(s.yumekoActive, false);
  const prev = s.activateYumeko();
  assert.equal(prev, STANDARD_ID);
  assert.equal(s.activeId, YUMEKO_ID);
  assert.equal(s.active.type, YUMEKO_TYPE);
  assert.equal(s.active.name, 'Yumeko');
  const saved = storage.data[PROFILES_KEY];
  assert.equal(saved.activeId, YUMEKO_ID);
  assert.ok(saved.profiles.some((p) => p.id === YUMEKO_ID));
  // Neu laden: bleibt erhalten und aktiv (wird NICHT wie das frühere 'yumeko' entfernt).
  const s2 = new ProfileStore({ settings: new FakeSettings(), storage });
  assert.equal(s2.activeId, YUMEKO_ID);
  assert.equal(storage.data[LEGACY_YUMEKO_KEY], undefined, 'keine Sicherung des alten Profils ausgelöst');
});

test('Yumeko-Profil nutzt vorerst die Standardstrategie (gleiche Empfehlungen)', () => {
  const s = new ProfileStore({ settings: new FakeSettings(), storage: memoryStorage() });
  s.activateYumeko();
  const y = s.strategyFor();
  const std = s.strategyFor(s.get(STANDARD_ID));
  for (const [cards, up] of [[['10', '6'], '10'], [['A', '7'], '9'], [['8', '8'], '10'], [['5', '6'], '6']]) {
    const a = decide(cards, up, { rules: R, strategyRules: y.strategyRules, overrides: y.overrides });
    const b = decide(cards, up, { rules: R, strategyRules: std.strategyRules, overrides: std.overrides });
    assert.equal(a.action, b.action, `${cards} gegen ${up}`);
  }
});

test('Yumeko-Profil ist gesperrt: nicht bearbeitbar, nicht löschbar, Duplikat wird benutzerdefiniert', () => {
  const s = new ProfileStore({ settings: new FakeSettings(), storage: memoryStorage() });
  s.activateYumeko();
  assert.ok(isLockedProfile(s.yumeko));
  assert.throws(() => s.setCell(YUMEKO_ID, 'hard:16:10', 'S'), { code: 'locked' });
  assert.throws(() => s.rename(YUMEKO_ID, 'X'), { code: 'locked' });
  s.activate(STANDARD_ID);
  assert.throws(() => s.remove(YUMEKO_ID), { code: 'locked' });
  const copy = s.duplicate(YUMEKO_ID);
  assert.equal(copy.type, 'custom');
  assert.equal(s.list().filter((p) => p.type === YUMEKO_TYPE).length, 1);
});

test('Gespeichertes Yumeko-Profil mit Fremdinhalt wird auf festen Inhalt zurückgesetzt; falsche ID bleibt aufbewahrt', () => {
  const raw = { version: 2, rev: 1, activeId: YUMEKO_ID, profiles: [
    { id: YUMEKO_ID, name: 'Anders', type: YUMEKO_TYPE, rules: R, settings: { followTableRules: false }, overrides: { 'hard:16:10': 'S' }, data: { a: 1 }, createdAt: AT, updatedAt: AT },
    { id: 'p_fake', name: 'Fake', type: YUMEKO_TYPE, rules: R, settings: {}, overrides: {}, data: {}, createdAt: AT, updatedAt: AT }
  ], invalid: [] };
  const m = migrate(raw, R);
  const y = m.profiles.find((p) => p.id === YUMEKO_ID);
  assert.equal(y.name, 'Yumeko');
  assert.deepEqual(y.overrides, {});
  assert.equal(y.settings.followTableRules, true);
  assert.deepEqual(y.data, { a: 1 });
  assert.equal(m.activeId, YUMEKO_ID);
  assert.ok(!m.profiles.some((p) => p.id === 'p_fake'));
  assert.ok(m.invalid.some((p) => p.id === 'p_fake'));
});

test('Ein-/Ausschalten im Lernzentrum: vorher aktives Profil wird wieder aktiv', () => {
  const storage = memoryStorage({ [PROFILES_KEY]: { version: 2, rev: 3, activeId: 'p_own', profiles: [ownP], invalid: [] } });
  const s = new ProfileStore({ settings: new FakeSettings(), storage });
  assert.equal(s.activeId, 'p_own');
  assert.equal(toggleYumeko(s, storage).active, true);
  assert.equal(s.activeId, YUMEKO_ID);
  assert.equal(storage.data[LERNZENTRUM_KEY].previousProfileId, 'p_own');
  assert.equal(toggleYumeko(s, storage).active, false);
  assert.equal(s.activeId, 'p_own');
  // Vorheriges Profil inzwischen gelöscht -> Standardstrategie
  toggleYumeko(s, storage);
  s.state.profiles = s.state.profiles.filter((p) => p.id !== 'p_own');
  toggleYumeko(s, storage);
  assert.equal(s.activeId, STANDARD_ID);
  // Eigene Profile und Tabelle unverändert
  assert.ok(s.list().some((p) => p.id === YUMEKO_ID));
});

test('Statistik: nur Hände mit aktivem Yumeko-Profil, Bust getrennt von Lose, startet bei 0', () => {
  assert.deepEqual(yumekoStats([]), { hands: 0, win: 0, loss: 0, bust: 0, push: 0 });
  const c = (...r) => r.map((rank) => ({ rank }));
  const rounds = [
    { profile: { id: YUMEKO_ID }, hands: [
      { outcome: 'win', cards: c('10', 'A') },
      { outcome: 'loss', cards: c('10', '6', '9') },   // Bust
      { outcome: 'loss', cards: c('10', '7') },        // verloren ohne Bust
      { outcome: 'push', cards: c('10', '8') },
      { outcome: null, cards: c('5') }                 // offen -> zählt nicht
    ] },
    { profile: { id: STANDARD_ID }, hands: [{ outcome: 'win', cards: c('10', '9') }] },
    { profile: null, hands: [{ outcome: 'win', cards: [] }] }
  ];
  assert.deepEqual(yumekoStats(rounds), { hands: 4, win: 1, loss: 1, bust: 1, push: 1 });
  assert.equal(percentText(1, 4), '25 %');
  assert.equal(percentText(0, 0), '– %');
});

test('Grundgerüst ohne KI: vier Bereiche, keine Lern- oder Netzwerkfunktionen', () => {
  assert.deepEqual(AREAS.map((a) => a.title), ['Karten', 'AI Table', 'Study', 'Brain']);
  for (const f of ['js/lernzentrum/lernzentrum.js', 'js/views/lernzentrum-view.js']) {
    const src = read(f);
    assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|indexedDB/.test(src), `${f}: kein Netzwerk/keine KI-Speicher`);
  }
  const sw = read('sw.js');
  for (const f of ['./js/views/lernzentrum-view.js', './js/lernzentrum/lernzentrum.js']) assert.ok(sw.includes(`'${f}'`), `${f} offline verfügbar`);
});

test('Hauptbildschirm: Lern-Knopf zwischen Kamera und Einstellungen', () => {
  const src = read('js/views/main-view.js');
  const cam = src.indexOf('data-nav="kamera"');
  const lz = src.indexOf('data-nav="lernzentrum"');
  const set = src.indexOf('data-nav="einstellungen"');
  assert.ok(cam > 0 && lz > cam && set > lz);
});
