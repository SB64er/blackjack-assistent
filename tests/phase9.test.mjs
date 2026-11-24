// Tests für Version 0.9.0: Entfernen der früheren YUMEKO-KI, des Lernzentrums,
// der Lernalgorithmen und der Academy – mit Sicherung des KI-Gedächtnisses.
// Aufruf: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MemoryDatabase, STORES } from '../js/core/idb.js';
import { LegacyAiMemory, LEGACY_FORMAT, LEGACY_STORES, BACKUP_MARK_KEY } from '../js/core/legacy-ai.js';
import { ProfileStore, migrate, STANDARD_ID, PROFILES_KEY, LEGACY_YUMEKO_KEY, YUMEKO_SAVED_ID } from '../js/strategy/profiles.js';
import { decide } from '../js/strategy/engine.js';
import { DEFAULT_RULES } from '../js/strategy/standard.js';
import { Emitter } from '../js/core/events.js';
import { ArchiveStore } from '../js/archive/archive-store.js';
import { SimulationStore } from '../js/strategy/sim-store.js';
import { BankrollStore } from '../js/risk/bankroll.js';

const R = DEFAULT_RULES;
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

function memoryStorage(initial = {}, { failKey = null } = {}) {
  const data = { ...initial };
  return {
    data,
    load: (k, fb) => (k in data ? JSON.parse(JSON.stringify(data[k])) : fb),
    save: (k, v) => { if (k === failKey) return false; data[k] = JSON.parse(JSON.stringify(v)); return true; },
    remove: (k) => { delete data[k]; }
  };
}
class FakeSettings extends Emitter {
  get(path) { return path === 'rules' ? R : undefined; }
}

const AT = '2026-11-22T10:00:00Z';
const stdP = { id: 'standard', name: 'Standardstrategie', type: 'standard', rules: R, settings: { followTableRules: true }, overrides: {}, data: {}, createdAt: AT, updatedAt: AT };
const yumP = (overrides = {}, version = 0) => ({ id: 'yumeko', name: 'YUMEKO AI', description: 'Adaptive Blackjack Intelligence.', type: 'yumeko', rules: R, settings: { followTableRules: true }, overrides, data: { strategyVersion: version, versionId: version ? 'v_x' : null }, createdAt: AT, updatedAt: AT });
const ownP = { id: 'p_own', name: 'Mein Profil', type: 'custom', rules: R, settings: { followTableRules: false }, overrides: { 'hard:12:3': 'S' }, data: {}, createdAt: AT, updatedAt: AT };
const saved08 = (profiles, activeId) => ({ version: 2, rev: 7, activeId, profiles, invalid: [] });

// --- Profil "YUMEKO AI" ------------------------------------------------------------------
test('YUMEKO-Profil ohne eigene Tabelle: wird gesichert und entfernt, Standard wird aktiv (gleiche Empfehlungen)', () => {
  const raw = saved08([stdP, yumP(), ownP], 'yumeko');
  const storage = memoryStorage({ [PROFILES_KEY]: raw });
  const s = new ProfileStore({ settings: new FakeSettings(), storage });
  assert.deepEqual(s.list().map((p) => p.id), [STANDARD_ID, 'p_own']);
  assert.equal(s.activeId, STANDARD_ID);
  assert.ok(!storage.data[PROFILES_KEY].profiles.some((p) => p.type === 'yumeko'), 'gespeicherte Profile ohne YUMEKO');
  const backup = storage.data[LEGACY_YUMEKO_KEY];
  assert.equal(backup.wasActive, true);
  assert.deepEqual(backup.profile.id, 'yumeko');
  assert.equal(backup.profile.type, 'yumeko');
  assert.ok(storage.data[PROFILES_KEY].profiles.find((p) => p.id === 'p_own'), 'eigenes Profil bleibt');
});

test('YUMEKO-Profil mit bestätigter Tabelle: bleibt als normales Profil, Empfehlungen ändern sich nicht', () => {
  const table = { 'hard:16:10': 'S', 'hard:12:2': 'S' };
  const raw = saved08([stdP, yumP(table, 3), ownP], 'yumeko');
  const storage = memoryStorage({ [PROFILES_KEY]: raw });
  const s = new ProfileStore({ settings: new FakeSettings(), storage });
  const p = s.active;
  assert.equal(p.id, YUMEKO_SAVED_ID);
  assert.equal(p.type, 'custom');
  assert.equal(p.name, 'YUMEKO AI (gesichert)');
  assert.deepEqual(p.overrides, table);
  assert.match(p.description, /Strategieversion 3/);
  const st = s.strategyFor();
  const d = decide([{ rank: '10' }, { rank: '6' }], { rank: '10' }, { rules: R, overrides: st.overrides, strategyRules: st.strategyRules });
  assert.equal(d.action, 'STAND', 'Tabelle wirkt wie vorher');
  // frei bearbeitbar und löschbar (nach Wechsel)
  s.setCell(p.id, 'hard:12:2', null);
  s.activate(STANDARD_ID);
  s.remove(p.id);
  assert.equal(storage.data[LEGACY_YUMEKO_KEY].profile.overrides['hard:12:2'], 'S', 'Original bleibt in der Sicherung');
});

test('Inaktives YUMEKO-Profil: aktives Profil bleibt, Sicherung wird nie überschrieben', () => {
  const first = { profile: { id: 'yumeko', type: 'yumeko', marker: 'erste Sicherung' }, wasActive: true };
  const raw = saved08([stdP, yumP({ 'hard:16:10': 'S' }, 1), ownP], 'p_own');
  const storage = memoryStorage({ [PROFILES_KEY]: raw, [LEGACY_YUMEKO_KEY]: first });
  const s = new ProfileStore({ settings: new FakeSettings(), storage });
  assert.equal(s.activeId, 'p_own');
  assert.ok(s.get(YUMEKO_SAVED_ID));
  assert.deepEqual(storage.data[LEGACY_YUMEKO_KEY], first);
  // Zweiter Start: nichts mehr zu tun
  const rev = storage.data[PROFILES_KEY].rev;
  new ProfileStore({ settings: new FakeSettings(), storage });
  assert.equal(storage.data[PROFILES_KEY].rev, rev, 'kein erneutes Umschreiben');
});

test('Kann das Original nicht gesichert werden, bleiben die gespeicherten Profile unverändert', () => {
  const raw = saved08([stdP, yumP({ 'hard:16:10': 'S' }, 2)], 'yumeko');
  const storage = memoryStorage({ [PROFILES_KEY]: raw }, { failKey: LEGACY_YUMEKO_KEY });
  new ProfileStore({ settings: new FakeSettings(), storage });
  assert.deepEqual(storage.data[PROFILES_KEY], raw);
});

test('Neue YUMEKO-Profile lassen sich nicht mehr anlegen; migrate() kennt keinen YUMEKO-Typ mehr', () => {
  const s = new ProfileStore({ settings: new FakeSettings(), storage: memoryStorage() });
  assert.throws(() => s.create({ name: 'x', type: 'yumeko' }), /eingebaut/);
  const m = migrate(null, R);
  assert.deepEqual(m.profiles.map((p) => p.id), [STANDARD_ID]);
});

// --- KI-Gedächtnis: Sicherung vor dem Löschen --------------------------------------------
async function filledDb() {
  const db = new MemoryDatabase();
  await db.put('knowledge', { id: 'k1', content: 'Hart 16 gegen 10' });
  await db.put('videos', { id: 'seq1', scenes: [] });
  await db.put('versions', { id: 'v1', number: 1, overrides: { 'hard:16:10': 'S' } });
  await db.put('history', { id: 'h1', at: AT, text: 'Analyse' });
  await db.put('sources', { id: 'yt_1', videoId: 'abc' });
  await db.put('claims', { id: 'c1', text: 'Always split aces' });
  await db.put('feedback', { id: 'f1', roundId: 'r1' });
  await db.put('meta', { id: 'yumeko', dismissed: ['a:x'] });
  // Gemeinsame Daten, die erhalten bleiben müssen
  await db.put('meta', { id: 'bankroll', enabled: true, currency: 'CHF', startBalance: 100 });
  await db.put('rounds', { id: 'r1', startedAt: AT, hands: [{ cards: [{ rank: '10' }, { rank: '9' }] }], dealer: { cards: [{ rank: '10' }] } });
  await db.put('simulations', { id: 's1', at: AT, rounds: 1000, seed: 1, results: [] });
  await db.put('ledger', { id: 'l1', type: 'start', at: AT, amount: 100 });
  return db;
}
const localWith = () => memoryStorage({
  yumekoChat: [{ from: 'user', text: 'Hallo' }],
  'academy.server': { endpoint: 'https://example.org' },
  [LEGACY_YUMEKO_KEY]: { profile: { id: 'yumeko' } },
  settings: { demo: false },
  strategyProfiles: { version: 2 },
  calibration: { version: 2 }
});

test('KI-Gedächtnis: Bestandsaufnahme und vollständige Sicherung (Rohdaten unverändert)', async () => {
  const db = await filledDb();
  const mem = new LegacyAiMemory({ db, storage: localWith() });
  await mem.ready();
  assert.equal(mem.summary.total, 7 + 1 + 3);
  for (const s of LEGACY_STORES) assert.equal(mem.summary.counts[s], 1, s);
  const data = await mem.exportData({ now: new Date(AT) });
  assert.equal(data.format, LEGACY_FORMAT);
  assert.equal(data.version, 1);
  assert.deepEqual(data.indexedDB.versions[0], { id: 'v1', number: 1, overrides: { 'hard:16:10': 'S' } });
  assert.deepEqual(data.indexedDB.meta.map((m) => m.id), ['yumeko'], 'meta bankroll gehört nicht dazu');
  assert.ok(!('rounds' in data.indexedDB) && !('simulations' in data.indexedDB) && !('ledger' in data.indexedDB));
  assert.deepEqual(Object.keys(data.localStorage).sort(), ['academy.server', 'legacy.yumekoProfile', 'yumekoChat']);
  assert.ok(JSON.parse(JSON.stringify(data)), 'als JSON speicherbar');
});

test('KI-Gedächtnis: Löschen nur nach Sicherung des aktuellen Stands und mit Bestätigung', async () => {
  const db = await filledDb();
  const storage = localWith();
  const mem = new LegacyAiMemory({ db, storage });
  await mem.ready();
  await assert.rejects(() => mem.clear({ confirmed: true }), /zuerst eine Sicherung/);
  const data = await mem.exportData();
  mem.markExported(data);
  assert.equal(mem.backedUp, true);
  await assert.rejects(() => mem.clear(), /bestätigt/);
  // Stand ändert sich nach der Sicherung -> neu sichern nötig
  await db.put('knowledge', { id: 'k2', content: 'neu' });
  await assert.rejects(() => mem.clear({ confirmed: true }), /zuerst eine Sicherung/);
  assert.equal((await db.all('knowledge')).length, 2, 'nichts gelöscht');
  mem.markExported(await mem.exportData());
  await mem.clear({ confirmed: true });
  for (const s of LEGACY_STORES) assert.equal((await db.all(s)).length, 0, `${s} leer`);
  assert.equal(await db.get('meta', 'yumeko'), null);
  assert.ok(mem.empty);
  // Gemeinsame Daten unverändert
  assert.equal((await db.get('meta', 'bankroll')).currency, 'CHF');
  assert.equal((await db.all('rounds')).length, 1);
  assert.equal((await db.all('simulations')).length, 1);
  assert.equal((await db.all('ledger')).length, 1);
  assert.ok(!('yumekoChat' in storage.data) && !('academy.server' in storage.data) && !(LEGACY_YUMEKO_KEY in storage.data));
  for (const k of ['settings', 'strategyProfiles', 'calibration']) assert.ok(k in storage.data, `${k} bleibt`);
  assert.ok(storage.data[BACKUP_MARK_KEY].clearedAt, 'Vermerk, wann gelöscht wurde');
});

test('Gemeinsame Speicher funktionieren weiter: Archiv, Simulationen, Echtgeld lesen dieselbe Datenbank', async () => {
  const db = await filledDb();
  const archive = new ArchiveStore({ db });
  const sims = new SimulationStore({ db });
  const bank = new BankrollStore({ db });
  await Promise.all([archive.ready(), sims.ready ? sims.ready() : null, bank.ready ? bank.ready() : null]);
  assert.equal(archive.rounds.length, 1);
  const exp = await archive.exportData({});
  assert.ok(!('yumeko' in exp) && !('academy' in exp), 'Archiv-Sicherung ohne alte KI-Daten');
  for (const s of ['rounds', 'simulations', 'ledger', 'meta']) assert.ok(STORES.includes(s));
  for (const s of LEGACY_STORES) assert.ok(STORES.includes(s), `${s}: Bereich bleibt bestehen (Daten bis zur Sicherung erhalten)`);
});

// --- Entfernte Dateien, unveränderte Kernfunktionen ----------------------------------------
test('Alte YUMEKO-KI, Lernzentrum, Academy und Server sind entfernt', () => {
  for (const f of ['js/yumeko', 'js/academy', 'server', 'js/views/yumeko-view.js', 'js/views/knowledge-view.js', 'js/views/video-view.js', 'js/views/chat-view.js', 'js/views/academy-view.js']) {
    assert.ok(!existsSync(new URL(`../${f}`, import.meta.url)), `${f} entfernt`);
  }
  const app = read('js/app.js');
  for (const route of ['yumeko:', 'wissen:', 'video:', 'chat:', 'akademie:']) assert.ok(!app.includes(`  ${route}`), `Route ${route} entfernt`);
  assert.ok(!/yumeko\.confirmFor|academy\.|knowledge\./.test(app));
  const sw = read('sw.js');
  assert.ok(!/js\/yumeko\/|js\/academy\/|yumeko-view|academy-view|chat-view|video-view|knowledge-view/.test(sw));
  for (const m of sw.matchAll(/'\.\/([^']+\.(?:js|css|html|webmanifest))'/g)) assert.ok(existsSync(new URL(`../${m[1]}`, import.meta.url)), `${m[1]} vorhanden`);
  for (const f of ['js/views/settings-view.js', 'js/views/main-view.js', 'js/views/strategy-view.js', 'js/views/profile-view.js', 'js/views/lab-view.js', 'js/views/risk-view.js']) {
    assert.ok(!/data-nav="(yumeko|akademie|chat|video|wissen)"/.test(read(f)), `${f}: keine Links auf entfernte Bereiche`);
  }
  assert.match(read('js/views/settings-view.js'), /data-nav="labor"/, 'Strategie-Labor bleibt erreichbar');
  assert.match(read('js/views/settings-view.js'), /data-nav="risiko"/, 'Echtgeld & Risiko bleibt erreichbar');
});

test('Kamera, Kartenerkennung, Kalibrierung, Anlernen und Blackjack-Logik sind unverändert zu 0.8.0', () => {
  const hashes = {
    'js/camera/camera-service.js': '19efed890bfd82b0',
    'js/camera/camera-diagnostics.js': '98f621ae09d28cca',
    'js/views/camera-view.js': '93b07d9a90c00a42',
    'js/recognition/analyzer.js': '575c90fa0c915b93',
    'js/recognition/detection-overlay.js': 'ac880bac3c8b7513',
    'js/recognition/recognition-service.js': 'f5fd45e337ce70bc',
    'js/recognition/round-tracker.js': 'cbefb22ec632d292',
    'js/recognition/template-store.js': '719ce698eb7e77cb',
    'js/recognition/vision.js': '3aec0f701b17fb81',
    'js/game/card-tracker.js': 'da7e2694ff904154',
    'js/game/hand.js': 'fa7057b1eb553d98',
    'js/game/round-state.js': '68a228fa47c7939b',
    'js/game/settle.js': '7b078d775d5ff460',
    'js/calibration/calibration-editor.js': 'c6bff77a804dc825',
    'js/calibration/calibration-model.js': '91cc1a8eadefc0f8',
    'js/calibration/calibration-store.js': '6e2ad58d0b025b70',
    'js/calibration/geometry.js': 'b02b716a43d7953e',
    'js/views/learn-view.js': '30ba731122c96280',
    'js/views/test-view.js': '0b38e02bb2722d94',
    'js/test/test-tracker.js': '13db828788706371',
    'js/core/settings.js': '034c5494a3048021'
  };
  for (const [f, h] of Object.entries(hashes)) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url));
    assert.equal(createHash('sha256').update(src).digest('hex').slice(0, 16), h, `${f} unverändert`);
  }
});

test('Version 0.9.0 überall gleich', () => {
  assert.match(read('sw.js'), /bj-assistent-v0\.9\.0/);
  assert.match(read('js/core/version.js'), /APP_VERSION = '0\.9\.0/);
  assert.match(read('package.json'), /"version": "0\.9\.0"/);
});
