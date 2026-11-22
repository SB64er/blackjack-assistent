// Tests für Phase 8 (Version 0.8.0): Intelligence & Academy.
// Nummern beziehen sich auf den Auftrag (Abschnitt 12). Aufruf: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { normalizeRules, rulesText, rulesEqual, standardTable, UNKNOWN_DECK_PROFILE, DEFAULT_RULES } from '../js/strategy/standard.js';
import { deckChoice, deckChoicePatch, DECK_CHOICES, ruleKnowledge, ruleVariants, UNKNOWN_RULES_MODE_DEFAULT, UNKNOWN_RULES_MODES, compareAcrossVariants } from '../js/strategy/table-rules.js';
import { analyzeHand, insuranceEV, dealerBustChance, normalizeExactRules } from '../js/strategy/exact.js';
import { modelFor } from '../js/strategy/ev.js';
import { decide } from '../js/strategy/engine.js';
import { Simulation } from '../js/strategy/simulate.js';
import { MemoryDatabase, STORES, DB_VERSION, MIGRATIONS, openDatabase, isQuotaError } from '../js/core/idb.js';
import { parseYouTubeUrl, videoLink } from '../js/academy/youtube.js';
import { extractClaims, claimText, parseUps } from '../js/academy/extract.js';
import { verifyClaim, verifyCell } from '../js/academy/verify.js';
import { AcademyStore, findConflicts, validateSource, academyStats, ACADEMY_FORMAT } from '../js/academy/academy-store.js';
import { validateServerEndpoint, validateServerResponse, fetchVideoData, ServerError } from '../js/academy/server-client.js';
import { KnowledgeStore } from '../js/yumeko/knowledge.js';
import { buildDraft } from '../js/yumeko/yumeko.js';
import { ArchiveStore } from '../js/archive/archive-store.js';
import { validateRound } from '../js/archive/round-record.js';
import { roundInsight, learningProgress, recurringMistakes, resultStats, uncertainCards } from '../js/archive/insights.js';
import { bankrollStats, defaultConfig } from '../js/risk/bankroll.js';
import { assessRisk } from '../js/risk/risk.js';

const R6 = { decks: 6, soft17: 'steht', das: true, payout: '3:2' };
const settingsWith = (rules) => ({ get: (p) => (p === 'rules' ? rules : undefined) });
const TRANSCRIPT = [
  { start: 3, text: 'Always split aces and eights.' },
  { start: 9, text: 'Hit 16 against a 10.' },
  { start: 15, text: 'Never take insurance.' },
  { start: 21, text: 'The dealer stands on soft 17.' }
];
function academy({ rules = R6, server = true, fetchVideo = null, db = new MemoryDatabase(), knowledge = null } = {}) {
  const k = knowledge || new KnowledgeStore({ db });
  const a = new AcademyStore({
    db, knowledge: k, settings: settingsWith(rules),
    serverConfig: () => ({ endpoint: server ? 'https://example.org/yumeko' : '' }),
    fetchVideo: fetchVideo || (async () => ({ meta: { title: 'Basic Strategy', channel: 'Kanal' }, transcript: { available: true, language: 'en', segments: TRANSCRIPT }, frames: { available: false, reason: 'keine' } }))
  });
  return { a, k, db };
}

// --- 1. Unbekannte Deckanzahl -------------------------------------------------
test('1 Unbekannte Deckanzahl: Standardprofil als gekennzeichnete Annahme, nie als erkannt', () => {
  const r = normalizeRules({ decks: 1, decksUnknown: true });
  assert.equal(r.decks, UNKNOWN_DECK_PROFILE);
  assert.equal(r.decksUnknown, true);
  assert.match(rulesText(r), /Decks unbekannt \(Annahme 6\)/);
  assert.ok(!('decksUnknown' in normalizeRules(R6)), 'alte Daten ohne Feld bleiben unverändert');
  const k = ruleKnowledge({ ...R6, decksUnknown: true });
  assert.deepEqual(k.unknown, ['decks']);
  assert.match(k.assumptions[0], /Annahme, keine Erkennung/);
  assert.ok(!rulesEqual({ ...R6, decksUnknown: true }, R6), 'unbekannt ≠ 6 Decks bekannt');
  assert.ok(!rulesEqual(R6, { ...R6, decksUnknown: true }), 'auch in umgekehrter Reihenfolge');
  // Exakte Engine: Vergleich aller Deckanzahlen und sichtbare Unsicherheit
  const a = analyzeHand({ player: ['10', '2'], up: '4', rules: { ...R6, decksUnknown: true } });
  assert.equal(a.deckComparison.rows.length, 5);
  assert.equal(a.deckComparison.agree, false, '10,2 gegen 4 kippt zwischen 6 und 8 Decks');
  assert.ok(a.uncertainty.some((x) => /hängt von der Deckanzahl ab/.test(x)));
  assert.ok(a.uncertainty.some((x) => /Annahme, nicht erkannt/.test(x)));
  const b = analyzeHand({ player: ['10', '10'], up: '6', rules: { ...R6, decksUnknown: true } });
  assert.equal(b.deckComparison.agree, true);
  assert.equal(b.best, 'STAND');
});

test('1 Weitere unbekannte Regeln: nur vorbereitet, keine Variante als Standard aktiviert', () => {
  assert.equal(UNKNOWN_RULES_MODE_DEFAULT, null);
  assert.deepEqual(Object.keys(UNKNOWN_RULES_MODES), ['uncertainty', 'compare']);
  const vars = ruleVariants(R6, ['soft17', 'das']);
  assert.equal(vars.length, 4);
  const cmp = compareAcrossVariants(vars, (r) => ({ best: analyzeHand({ player: ['5', '6'], up: 'A', rules: r }).best }));
  assert.equal(cmp.rows.length, 4);
  assert.equal(typeof cmp.agree, 'boolean');
});

// --- 2. Speicherung der letzten Deckauswahl ------------------------------------
test('2 Letzte Deckauswahl wird gespeichert und nach Neustart wieder geladen (auch „Unbekannt“)', async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  try {
    const { settings } = await import('../js/core/settings.js?start=1');
    assert.equal(deckChoice(settings.get('rules')), 6, 'Standard bleibt 6 Decks');
    const patch = deckChoicePatch('unbekannt');
    settings.set('rules.decksUnknown', patch.decksUnknown);
    settings.set('rules.decks', patch.decks);
    const stored = JSON.parse(mem.get('bjassist.settings'));
    assert.equal(stored.rules.decksUnknown, true);
    const { settings: again } = await import('../js/core/settings.js?neustart=2');
    assert.equal(deckChoice(again.get('rules')), 'unbekannt', 'nach Neustart weiterhin „Unbekannt“');
    const p2 = deckChoicePatch(2);
    again.set('rules.decksUnknown', p2.decksUnknown);
    again.set('rules.decks', p2.decks);
    const { settings: third } = await import('../js/core/settings.js?neustart=3');
    assert.equal(deckChoice(third.get('rules')), 2);
    assert.deepEqual(DECK_CHOICES, ['unbekannt', 1, 2, 4, 6, 8]);
    assert.throws(() => deckChoicePatch(3));
  } finally {
    delete globalThis.localStorage;
  }
});

test('2 Einstellungen aus 0.7.0 (ohne neues Feld) bleiben unverändert lesbar', async () => {
  const mem = new Map([['bjassist.settings', JSON.stringify({ roundMode: 'automatisch', demo: false, rules: { decks: 8, soft17: 'zieht', das: false, payout: '6:5' } })]]);
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  try {
    const { settings } = await import('../js/core/settings.js?alt=1');
    assert.deepEqual(settings.get('rules'), { decks: 8, decksUnknown: false, soft17: 'zieht', das: false, payout: '6:5' });
    assert.equal(settings.get('roundMode'), 'automatisch');
    assert.equal(deckChoice(settings.get('rules')), 8);
  } finally {
    delete globalThis.localStorage;
  }
});

// --- 3. Datenbankmigrationen ------------------------------------------------------
function fakeIndexedDB(existing) {
  const created = [];
  const names = new Set(existing);
  return {
    created,
    open(name, version) {
      const req = {};
      const db = {
        version,
        objectStoreNames: { contains: (s) => names.has(s) },
        createObjectStore: (s) => { created.push(s); names.add(s); },
        deleteObjectStore: () => { throw new Error('darf nie gelöscht werden'); }
      };
      setTimeout(() => {
        req.result = db;
        req.onupgradeneeded && req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    }
  };
}

test('3 Datenbankmigration v2 → v3: nur neue Bereiche, nichts gelöscht', async () => {
  assert.equal(DB_VERSION, 3);
  const v2 = ['rounds', 'knowledge', 'videos', 'versions', 'meta', 'simulations', 'ledger', 'history'];
  const idb = fakeIndexedDB(v2);
  const db = await openDatabase({ indexedDB: idb });
  assert.equal(db.kind, 'indexeddb');
  assert.deepEqual(idb.created.sort(), ['claims', 'feedback', 'sources']);
  assert.deepEqual(MIGRATIONS.map((m) => m.version), [1, 2, 3]);
  for (const s of v2) assert.ok(STORES.includes(s), `Bereich ${s} bleibt`);
  // Frische Installation: alle Bereiche
  const fresh = fakeIndexedDB([]);
  await openDatabase({ indexedDB: fresh });
  assert.equal(fresh.created.length, STORES.length);
});

test('3 Bestehende Daten aus 0.7.0 bleiben erhalten; unlesbare Academy-Einträge werden nicht gelöscht', async () => {
  const db = new MemoryDatabase();
  await db.put('knowledge', { id: 'k1', category: 'hypothesis', content: 'Alte Erkenntnis', createdAt: '2026-11-01T10:00:00Z' });
  await db.put('videos', { id: 'seq1', source: 'Datei', scenes: [] });
  await db.put('sources', { id: 'kaputt', kind: 'youtube', videoId: 'zu-kurz' });
  const { a, k } = academy({ db });
  await a.ready(); await k.ready();
  assert.equal(a.invalid, 1);
  assert.ok(await db.get('sources', 'kaputt'), 'unlesbarer Eintrag bleibt in der Datenbank');
  assert.equal(k.items.length, 1);
  assert.equal(k.videos.length, 1);
});

test('3 Unterbrochene Analyse (App geschlossen) wird als Fehler mit Hinweis geladen', async () => {
  const db = new MemoryDatabase();
  await db.put('sources', { id: 'yt_dQw4w9WgXcQ', kind: 'youtube', videoId: 'dQw4w9WgXcQ', status: 'verifying', addedAt: '2026-11-22T10:00:00Z' });
  const { a } = academy({ db });
  await a.ready();
  assert.equal(a.sources[0].status, 'error');
  assert.match(a.sources[0].error, /unterbrochen/);
});

test('3 Speicher voll wird erkannt und verständlich gemeldet', async () => {
  assert.ok(isQuotaError({ name: 'QuotaExceededError' }));
  assert.ok(isQuotaError({ code: 'quota', message: '' }));
  assert.ok(!isQuotaError(new Error('anderer Fehler')));
  const full = new MemoryDatabase({ persist: { load: () => [], save: () => false } });
  const { a } = academy({ db: full });
  await a.ready();
  await assert.rejects(() => a.addLink('https://youtu.be/dQw4w9WgXcQ', { autoStart: false }), (err) => err.code === 'quota' && /Speicher voll/.test(err.message));
});

// --- 4. Export und Import ---------------------------------------------------------
test('4 Export und Import der Wissensdatenbank (ohne Überschreiben, doppelte erkannt)', async () => {
  const { a } = academy();
  await (await a.addLink('https://youtu.be/dQw4w9WgXcQ')).done;
  const data = JSON.parse(JSON.stringify(a.exportData()));
  assert.equal(data.format, ACADEMY_FORMAT);
  assert.equal(data.sources.length, 1);
  assert.ok(data.claims.length >= 4);
  const { a: b } = academy();
  const r1 = await b.importData(data);
  assert.equal(r1.added, data.sources.length + data.claims.length);
  assert.equal(b.claims.length, a.claims.length);
  const r2 = await b.importData(data);
  assert.equal(r2.added, 0);
  assert.equal(r2.skipped, data.sources.length + data.claims.length);
  await assert.rejects(() => b.importData({ format: 'falsch' }), /falsches Dateiformat/);
  await assert.rejects(() => b.importData({ ...data, version: 99 }), /neueren App-Version/);
});

test('4 Einzelne Einträge löschen und gesamte Academy zurücksetzen (nur mit Bestätigung)', async () => {
  const { a, k } = academy();
  await (await a.addLink('https://youtu.be/dQw4w9WgXcQ')).done;
  const n = a.claims.length;
  await a.removeClaim(a.claims[0].id);
  assert.equal(a.claims.length, n - 1);
  await assert.rejects(() => a.resetAll(), /ausdrücklich bestätigen/);
  await a.resetAll({ confirmed: true });
  assert.equal(a.sources.length + a.claims.length + a.feedback.length, 0);
  assert.equal(k.items.filter((i) => i.id.startsWith('academy:')).length, 0);
});

// --- 5. YouTube-Link-Validierung -----------------------------------------------------
test('5 YouTube-Links: gültige Formen werden erkannt, alles andere abgelehnt', () => {
  const ok = {
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ': 'dQw4w9WgXcQ',
    'youtube.com/watch?v=dQw4w9WgXcQ&list=PL1': 'dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=42': 'dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ': 'dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ': 'dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ': 'dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ': 'dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ': 'dQw4w9WgXcQ',
    '  https://youtu.be/A-b_c1234567  ': null
  };
  for (const [url, id] of Object.entries(ok)) {
    const r = parseYouTubeUrl(url);
    if (id) { assert.ok(r.ok, url); assert.equal(r.videoId, id); assert.equal(r.url, `https://www.youtube.com/watch?v=${id}`); }
  }
  assert.equal(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=1m5s').start, 65);
  const bad = {
    '': 'empty', 'kein link': 'invalid', 'example.org/watch?v=dQw4w9WgXcQ': 'not-youtube', 'https://vimeo.com/123': 'not-youtube', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ': 'not-youtube',
    'https://www.youtube.com/watch?v=kurz': 'bad-id', 'https://www.youtube.com/playlist?list=PL123': 'playlist', 'https://www.youtube.com/@kanal': 'channel',
    'javascript:alert(1)': 'invalid', 'ftp://youtube.com/watch?v=dQw4w9WgXcQ': 'protocol'
  };
  for (const [url, code] of Object.entries(bad)) {
    const r = parseYouTubeUrl(url);
    assert.equal(r.ok, false, url);
    assert.equal(r.code, code, `${url}: ${r.code}`);
  }
  assert.equal(videoLink('dQw4w9WgXcQ', 75.4), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=75s');
  assert.equal(videoLink('<script>'), null);
});

test('5 Doppelter Link wird erkannt (kein zweiter Eintrag)', async () => {
  const { a } = academy();
  await (await a.addLink('https://youtu.be/dQw4w9WgXcQ')).done;
  const again = await a.addLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10');
  assert.equal(again.duplicate, true);
  assert.equal(a.sources.length, 1);
});

// --- 6. Nicht verfügbare Transkripte -------------------------------------------------
test('6 Ohne Server: kein Transkript, ehrlicher Status, keine erfundenen Ergebnisse, kein Netzwerk', async () => {
  let called = 0;
  const { a } = academy({ server: false, fetchVideo: async () => { called += 1; throw new Error('darf nicht aufgerufen werden'); } });
  const s = await (await a.addLink('https://youtu.be/dQw4w9WgXcQ')).done;
  assert.equal(called, 0, 'ohne Server wird nichts gesendet');
  assert.equal(s.status, 'unverifiable');
  assert.equal(s.steps.meta.state, 'skip');
  assert.equal(s.steps.transcript.state, 'fail');
  assert.match(s.steps.transcript.note, /Kein Transkript verfügbar/);
  assert.equal(s.steps.frames.state, 'skip');
  assert.equal(a.claims.length, 0, 'keine erfundenen Erkenntnisse');
  assert.equal(s.title, null, 'kein erfundener Titel');
});

test('6 Server liefert kein Transkript: Status „Nicht überprüfbar“, Grund wird angezeigt', async () => {
  const { a } = academy({ fetchVideo: async () => ({ meta: { title: 'T', channel: null }, transcript: { available: false, reason: 'Für dieses Video gibt es keine Untertitel.' }, frames: { available: false, reason: 'nein' } }) });
  const s = await (await a.addLink('https://youtu.be/dQw4w9WgXcQ')).done;
  assert.equal(s.status, 'unverifiable');
  assert.match(s.steps.transcript.note, /keine Untertitel/);
  assert.equal(a.stats().noTranscript, 1);
});

test('6 Eingefügtes Transkript wird analysiert (manuelle Quelle gekennzeichnet)', async () => {
  const { a } = academy({ server: false });
  const s = await (await a.addLink('https://youtu.be/dQw4w9WgXcQ')).done;
  const s2 = await a.setManualTranscript(s.id, '0:05\nAlways split aces and eights.\n1:10 Never take insurance.');
  assert.equal(s2.transcript.source, 'manual');
  assert.equal(s2.status, 'verified');
  assert.equal(s2.counts.claims, 3);
  const ins = a.claims.find((c) => c.type === 'insurance');
  assert.equal(ins.sources[0].at, 70, 'Zeitstempel übernommen');
});

// --- 7. Fehlgeschlagene Videoanalysen ------------------------------------------------
test('7 Fehlgeschlagene Analyse: Status Fehler mit Meldung, Wiederholen klappt danach', async () => {
  let fail = true;
  const { a } = academy({ fetchVideo: async () => { if (fail) throw new ServerError('failed', 'Der Server ist nicht erreichbar.'); return { meta: { title: 'X' }, transcript: { available: true, segments: TRANSCRIPT }, frames: { available: false } }; } });
  const s = await (await a.addLink('https://youtu.be/dQw4w9WgXcQ')).done;
  assert.equal(s.status, 'error');
  assert.match(s.error, /nicht erreichbar/);
  assert.equal(s.steps.meta.state, 'fail');
  assert.equal(a.stats().failed, 1);
  fail = false;
  const s2 = await a.analyze(s.id);
  assert.equal(s2.status, 'verified');
  assert.equal(s2.runs, 2);
});

test('7 Server-Schnittstelle: nur https ohne Schlüssel, Antworten streng geprüft', async () => {
  assert.throws(() => validateServerEndpoint('http://x.example'), /https/);
  assert.throws(() => validateServerEndpoint('https://x.example/?key=geheim'), /Schlüssel/);
  assert.throws(() => validateServerEndpoint('https://user:pw@x.example'), /Zugangsdaten/);
  assert.equal(validateServerEndpoint('https://x.example/yumeko'), 'https://x.example/yumeko');
  assert.throws(() => validateServerResponse({ videoId: 'aaaaaaaaaaa' }, 'dQw4w9WgXcQ'), /anderes Video/);
  const v = validateServerResponse({ transcript: { available: true, segments: [] } }, 'dQw4w9WgXcQ');
  assert.equal(v.transcript.available, false, 'leeres Transkript gilt als nicht verfügbar');
  await assert.rejects(() => fetchVideoData('dQw4w9WgXcQ', { config: { endpoint: '' } }), (e) => e.code === 'not-configured');
  await assert.rejects(() => fetchVideoData('dQw4w9WgXcQ', { config: { endpoint: 'https://x' }, online: false }), (e) => e.code === 'offline');
  let body = null;
  await assert.rejects(() => fetchVideoData('dQw4w9WgXcQ', { config: { endpoint: 'https://x' }, online: true, fetchImpl: async (u, o) => { body = JSON.parse(o.body); return { ok: false, status: 500 }; } }), /HTTP 500/);
  assert.deepEqual(Object.keys(body).sort(), ['app', 'schema', 'task', 'videoId', 'want'], 'nur Video-ID und App-Version werden gesendet');
  const ok = await fetchVideoData('dQw4w9WgXcQ', { config: { endpoint: 'https://x' }, online: true, fetchImpl: async () => ({ ok: true, json: async () => ({ videoId: 'dQw4w9WgXcQ', title: 'T', transcript: { available: true, segments: [{ start: 1, text: 'hit 16 against 10' }] } }) }) });
  assert.equal(ok.transcript.segments.length, 1);
});

// --- 8. Mathematische Strategieentscheidungen ----------------------------------------
test('8 Exakte Engine: Referenzfälle der Basisstrategie (kartenabhängig)', () => {
  const best = (p, u, r = {}) => analyzeHand({ player: p, up: u, rules: { ...R6, ...r } }).best;
  assert.equal(best(['10', '6'], '10'), 'HIT', '10,6 gegen 10 (6 Decks): Ziehen');
  assert.equal(best(['4', '4', '4', '4'], '10'), 'STAND', '4,4,4,4 gegen 10: Stehen (bekannte Ausnahme)');
  assert.equal(best(['5', '6'], 'A'), 'HIT', '11 gegen Ass, 6 Decks S17: Ziehen');
  assert.equal(best(['5', '6'], 'A', { decks: 1 }), 'DOUBLE', '11 gegen Ass, 1 Deck: Verdoppeln');
  assert.equal(best(['5', '4'], '2'), 'HIT', '9 gegen 2, 6 Decks: Ziehen');
  assert.equal(best(['5', '4'], '2', { decks: 1 }), 'DOUBLE', '9 gegen 2, 1 Deck: Verdoppeln');
  assert.equal(best(['8', '8'], '10'), 'SPLIT');
  assert.equal(best(['A', 'A'], '6'), 'SPLIT');
  assert.equal(best(['9', '9'], '7'), 'STAND');
  assert.equal(best(['10', '10'], '6'), 'STAND');
  assert.equal(best(['A', '7'], '9'), 'HIT');
  assert.equal(best(['10', '2'], '2'), 'HIT');
  const bj = analyzeHand({ player: ['A', 'K'], up: '6', rules: R6 });
  assert.equal(bj.best, null);
  assert.ok(Math.abs(bj.blackjackEV - 1.5) < 1e-9, 'gegen 6 kein Dealer-Blackjack möglich: 3:2');
  assert.equal(analyzeHand({ player: ['10', '6', '9'], up: '6' }).ok, false, 'überkauft');
  assert.equal(analyzeHand({ player: ['10'], up: '6' }).ok, false);
});

test('8 Exakte Engine konvergiert gegen das Rechenmodell (sehr viele Decks)', () => {
  const cases = [[['10', '6'], 10, 'hard', 16], [['10', '2'], 4, 'hard', 12], [['5', '6'], 11, 'hard', 11], [['A', '7'], 9, 'soft', 18], [['8', '8'], 10, 'pair', 8]];
  for (const [cards, up, kind, value] of cases) {
    const ex = analyzeHand({ player: cards, up, rules: { ...R6, decks: 1000 } });
    const inf = modelFor(up, R6).cellEVs(kind, value);
    for (const a of Object.keys(inf)) {
      assert.ok(Math.abs(ex.evs[a] - inf[a]) < 0.004, `${cards} gegen ${up} ${a}: ${ex.evs[a].toFixed(4)} vs ${inf[a].toFixed(4)}`);
    }
  }
});

test('8 Wahrscheinlichkeiten: Dealer überkauft mit 6 ≈ 42,3 %, Versicherung ist negativ', () => {
  const b = dealerBustChance('6', R6);
  assert.ok(Math.abs(b.bust - 0.4232) < 0.003, b.bust);
  assert.ok(dealerBustChance('A', R6).bust < 0.2);
  assert.ok(insuranceEV({ player: ['10', '7'], decks: 6 }).ev < 0);
  // Begründung ist nachvollziehbar
  const a = analyzeHand({ player: ['10', '6'], up: '10', rules: R6 });
  assert.match(a.explanation[0], /Ziehen hat den höchsten Erwartungswert/);
  assert.ok(a.margin > 0 && a.second === 'STAND');
});

// --- 9. Unterschiedliche Tischregeln -----------------------------------------------
test('9 Tischregeln: Aufgeben, H17, Peek, DAS, Verdoppel-Einschränkung', () => {
  const best = (p, u, r = {}) => analyzeHand({ player: p, up: u, rules: { ...R6, ...r } }).best;
  assert.equal(best(['10', '6'], '10', { surrender: 'spaet' }), 'SURRENDER');
  assert.equal(best(['10', '6'], '9', { surrender: 'spaet' }), 'SURRENDER');
  assert.equal(best(['10', '5'], '10', { surrender: 'spaet' }), 'SURRENDER');
  assert.equal(best(['10', '5'], 'A', { surrender: 'spaet' }), 'HIT', '15 gegen Ass S17: nicht aufgeben');
  assert.equal(best(['10', '5'], 'A', { surrender: 'spaet', soft17: 'zieht' }), 'SURRENDER', '15 gegen Ass H17: aufgeben');
  assert.equal(best(['5', '6'], '10'), 'DOUBLE');
  assert.equal(best(['5', '6'], '10', { peek: false }), 'HIT', 'ohne Peek (europäisch): 11 gegen 10 ziehen');
  assert.equal(best(['4', '4'], '5', { das: true }), 'SPLIT');
  assert.equal(best(['4', '4'], '5', { das: false }), 'HIT');
  assert.ok(!('DOUBLE' in analyzeHand({ player: ['5', '4'], up: '3', rules: { ...R6, doubleOn: '10-11' } }).evs));
  assert.ok(!('DOUBLE' in analyzeHand({ player: ['A', '7'], up: '3', rules: { ...R6, doubleOn: '9-11' } }).evs));
  assert.ok(!('SURRENDER' in analyzeHand({ player: ['10', '6'], up: '10', rules: R6 }).evs), 'Standard: kein Aufgeben');
  assert.equal(normalizeExactRules({}).surrender, 'keine');
  // Live-Engine bleibt ohne Aufgeben und unverändert bei unbekannter Deckanzahl
  assert.deepEqual(standardTable({ ...R6, decksUnknown: true }), standardTable(R6));
});

test('9 Simulator: Verteilung und Blöcke aus echten simulierten Runden', () => {
  const sim = new Simulation({ rules: R6, seed: 7 });
  const r = sim.step(3000);
  const total = r.distribution.reduce((s, d) => s + d.count, 0);
  assert.equal(total, 3000);
  assert.equal(r.sessions.n, 30);
  assert.ok(r.sessions.p05 <= r.sessions.p50 && r.sessions.p50 <= r.sessions.p95);
  const again = new Simulation({ rules: R6, seed: 7 }).step(3000);
  assert.deepEqual(again.distribution, r.distribution, 'reproduzierbar');
});

// --- 10. Speicherung von Spielrunden -----------------------------------------------
const ROUND = (id, at, actions, outcome = 'loss', extra = {}) => ({
  schema: 2, id, startedAt: at, source: 'auto', status: 'complete', rules: { ...R6, decksUnknown: true },
  dealer: { cards: [{ rank: '7', score: 0.95 }, { rank: '10', score: 0.9 }] },
  hands: [{ cards: [{ rank: '10', score: 0.95 }, { rank: '6', score: 0.6 }], actions, outcome, outcomeSource: 'auto' }],
  recognition: { frames: 10, unsureFrames: 1, minScore: 0.6, avgScore: 0.85, reported: true },
  ...extra
});

test('10 Spielrunde speichern: Quelle, unbekannte Deckanzahl, Meldung, Abweichungen bleiben erhalten', async () => {
  const archive = new ArchiveStore({ db: new MemoryDatabase() });
  const saved = await archive.add(ROUND('r1', '2026-11-22T10:00:00Z', [{ action: 'STAND', cardsBefore: ['10', '6'], recommended: 'HIT' }]));
  assert.equal(saved.rules.decksUnknown, true);
  assert.equal(saved.recognition.reported, true);
  assert.equal(saved.source, 'auto');
  const ins = roundInsight(saved);
  assert.equal(ins.deviations, 1);
  assert.equal(ins.mathMistakes, 1);
  assert.equal(ins.reported, true);
  assert.equal(ins.uncertain, 1);
  assert.match(ins.decks, /unbekannt/);
  assert.equal(uncertainCards(saved)[0].rank, '6');
  // Alte Runden ohne neue Felder bleiben gültig
  const old = validateRound({ id: 'alt', startedAt: '2026-11-01T10:00:00Z', hands: [{ cards: [{ rank: '9' }, { rank: '9' }] }], rules: R6 });
  assert.ok(old && !old.rules.decksUnknown);
});

// --- 11. Nachträgliche Spielanalyse --------------------------------------------------
test('11 Nachträgliche Analyse: wiederkehrende Fehler, Lernfortschritt, Statistik', () => {
  const rounds = [];
  for (let i = 0; i < 30; i++) {
    const wrong = i < 15 && i % 2 === 0; // anfangs Fehler, später nicht
    rounds.push(validateRound(ROUND(`r${i}`, `2026-11-${String(10 + Math.floor(i / 3)).padStart(2, '0')}T10:0${i % 3}:00Z`, [{ action: wrong ? 'STAND' : 'HIT', cardsBefore: ['10', '6'], recommended: 'HIT' }], i % 3 ? 'loss' : 'win')));
  }
  const rec = recurringMistakes(rounds);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].count, 8);
  assert.match(rec[0].text, /Hart 16 gegen 7: Stehen statt Ziehen/);
  const prog = learningProgress(rounds, { blockSize: 10 });
  assert.equal(prog.decisions, 30);
  assert.equal(prog.blocks.length, 3);
  assert.ok(prog.trend < 0, 'Fehlerquote sinkt');
  const st = resultStats(rounds);
  assert.equal(st.total.rounds, 30);
  assert.equal(st.deviations, 8);
  assert.equal(st.reported, 30);
});

test('11 Risikokontrolle: laufende Verlustserie erkannt, ohne Aufforderung zum Zurückgewinnen', () => {
  const cfg = { ...defaultConfig(), enabled: true, startBalance: 100, budget: 100, limits: { maxBet: 10, sessionLoss: 50, dailyLoss: null } };
  const entries = [{ id: 's', type: 'start', at: '2026-11-22T10:00:00Z', amount: 100 }];
  for (let i = 0; i < 5; i++) entries.push({ id: `e${i}`, type: 'round', at: `2026-11-22T10:0${i + 1}:00Z`, stake: 5, extra: 0, payout: 0, net: -5 });
  const stats = bankrollStats(cfg, entries.map((e) => ({ sessionId: null, ...e })));
  assert.equal(stats.currentLossStreak, 5);
  const risk = assessRisk({ config: cfg, stats, strategy: { ev: -0.005 } });
  const msg = risk.messages.find((m) => m.code === 'loss-streak');
  assert.ok(msg);
  assert.match(msg.text, /nicht erhöhen/);
  assert.ok(!/zurückgewinnen|fällig ist\./i.test(msg.text.replace('kein Zeichen, dass ein Gewinn „fällig“ ist', '')));
});

// --- 12. Offline-Verhalten -----------------------------------------------------------
test('12 Offline: neue Dateien im Offline-Speicher; Rechnen und Prüfen ohne Netzwerk', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /bj-assistent-v0\.8\.0/);
  const files = ['js/views/academy-view.js', 'js/academy/youtube.js', 'js/academy/extract.js', 'js/academy/verify.js', 'js/academy/server-client.js', 'js/academy/academy-store.js', 'js/archive/insights.js', 'js/strategy/exact.js', 'js/strategy/table-rules.js'];
  for (const f of files) {
    assert.ok(sw.includes(`'./${f}'`), `${f} im Offline-Speicher`);
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/from '\//.test(src), `${f}: nur relative Importe`);
    if (f !== 'js/academy/server-client.js') assert.ok(!/fetch\(/.test(src), `${f}: kein Netzwerkzugriff`);
    assert.ok(!/(api[_-]?key|secret)\s*[:=]\s*['"][A-Za-z0-9]/i.test(src), `${f}: kein Schlüssel im Code`);
  }
  for (const v of ['APP_VERSION = \'0.8.0', '"version": "0.8.0"']) {
    const src = readFileSync(new URL(v.startsWith('APP') ? '../js/core/version.js' : '../package.json', import.meta.url), 'utf8');
    assert.ok(src.includes(v), v);
  }
});

// --- 13. Bestehende Funktionen aus 0.7.0 ---------------------------------------------
test('13 Bestehende Empfehlungen bleiben gleich (auch mit „Unbekannt“ = Standardprofil)', () => {
  for (const [p, u] of [[['10', '6'], '10'], [['8', '8'], '6'], [['A', '7'], '3'], [['5', '6'], 'A'], [['2', '2'], '7']]) {
    const cards = p.map((rank) => ({ rank }));
    const a = decide(cards, { rank: u }, { rules: R6 });
    const b = decide(cards, { rank: u }, { rules: { ...R6, decksUnknown: true } });
    assert.equal(a.action, b.action, `${p} gegen ${u}`);
  }
  assert.deepEqual(normalizeRules(DEFAULT_RULES), { decks: 6, soft17: 'steht', das: true, payout: '3:2' });
});

test('13/15 Kamera: Kameracode ist unverändert zu 0.7.0 (keine Änderung an Berechtigungen oder Stream)', () => {
  const hashes = {
    'js/camera/camera-service.js': '19efed890bfd82b0',
    'js/camera/camera-diagnostics.js': '98f621ae09d28cca',
    'js/views/camera-view.js': '93b07d9a90c00a42'
  };
  for (const [f, h] of Object.entries(hashes)) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url));
    assert.equal(createHash('sha256').update(src).digest('hex').slice(0, 16), h, `${f} unverändert`);
  }
});

// --- 14. Schutz vor ungeprüften Strategien --------------------------------------------
test('14 Aussagen aus Videos: nur geprüfte werden Wissen, widerlegte ändern die Strategie nie', async () => {
  const { a, k } = academy({ fetchVideo: async () => ({ meta: {}, transcript: { available: true, segments: [{ start: 1, text: 'Always stand on 12 against a 2. Hit 16 against a 10. Stand on 16 against a 10.' }] }, frames: { available: false } }) });
  await (await a.addLink('https://youtu.be/dQw4w9WgXcQ')).done;
  const stand12 = a.claims.find((c) => c.text.startsWith('Hart 12 gegen Dealer 2'));
  assert.equal(stand12.status, 'contradicted');
  assert.equal(stand12.flagged, true, 'widerlegte Aussage als fehlerhaft markiert');
  const mirrored = k.get(`academy:${stand12.id}`);
  assert.equal(mirrored.category, 'hypothesis');
  assert.ok(!mirrored.data.cell, 'widerlegte Aussage trägt keine Tabellenzelle');
  // Widerspruch zwischen Quellen erkannt
  const conf = a.conflicts();
  assert.ok(conf.list.some((c) => c.situation === 'hard:16:10'));
  // Strategieentwurf: widerlegte/ungeprüfte Aussagen werden nicht übernommen
  const draft = buildDraft({ rules: R6, items: k.items, number: 1 });
  assert.ok(!draft.overrides['hard:12:2'], '12 gegen 2 bleibt Ziehen');
  assert.ok(!draft.basis.adopted.some((x) => x.key === 'hard:12:2'));
  assert.equal(draft.status, 'entwurf', 'auch geprüfte Aussagen wirken nur über Entwurf → Prüfung → Bestätigung');
  // Eine ungeprüfte Aussage (z. B. manuell konstruiert) wird nicht gespiegelt
  const before = k.items.length;
  await a._mirrorToKnowledge([{ id: 'x', type: 'play', data: { cells: [{ kind: 'hard', value: 12, up: 2 }], action: 'STAND' }, text: 'x', sources: [], verification: null }]);
  assert.equal(k.items.length, before);
});

test('14 Prüfung: Ergebnisarten bestätigt / widerlegt / teilweise / nicht überprüfbar', async () => {
  const { claims } = extractClaims('Always split aces and eights. Stand on 12 against a 2. Double 11 against anything. The dealer stands on soft 17.');
  const byText = Object.fromEntries(await Promise.all(claims.map(async (c) => [claimText(c), (await verifyClaim(c, R6)).verdict])));
  assert.equal(byText['Paar A,A gegen jede Dealerkarte: Splitten'], 'confirmed');
  assert.equal(byText['Hart 12 gegen Dealer 2: Stehen'], 'contradicted');
  assert.equal(byText['Hart 11 gegen jede Dealerkarte: Verdoppeln'], 'partial', '11 gegen Ass hängt von Decks/Regeln ab');
  assert.equal(byText['Tischregel: Dealer steht bei Soft 17'], 'unverifiable');
  const cell = verifyCell({ kind: 'hard', value: 16, up: 10 }, 'STAND', false, R6);
  assert.equal(cell.verdict, 'contradicted');
});

test('Texterkennung: Deutsch und Englisch, Negation, Bereiche, Zahlwörter', () => {
  const t = (s) => extractClaims(s).claims.map(claimText);
  assert.deepEqual(t('Asse und Achten immer splitten. Bei 16 gegen 10 solltest du ziehen.').sort(), ['Hart 16 gegen Dealer 10: Ziehen', 'Paar 8,8 gegen jede Dealerkarte: Splitten', 'Paar A,A gegen jede Dealerkarte: Splitten']);
  assert.deepEqual(t('never split tens'), ['Paar 10,10 gegen jede Dealerkarte: nicht Splitten']);
  assert.deepEqual(t('sixteen against ten you hit'), ['Hart 16 gegen Dealer 10: Ziehen']);
  assert.deepEqual(t('A,7 against 2 through 8 stand'), ['Weich 18 (A,7) gegen Dealer 2 bis 8: Stehen']);
  assert.deepEqual(parseUps('7 or higher'), [7, 8, 9, 10, 11]);
  assert.deepEqual(parseUps('9, 10 and ace'), [9, 10, 11]);
  assert.deepEqual(t('Das Wetter ist schön und wir spielen Karten.'), [], 'kein Blackjack-Inhalt → keine Aussage');
  const r = extractClaims([{ start: 12, text: 'Der Dealer überkauft sich mit einer 6 in etwa 42 Prozent der Fälle' }]);
  assert.equal(r.claims[0].type, 'probability');
  assert.equal(r.claims[0].at, 12);
  assert.ok(r.topics.includes('probability'));
});

test('Lernstatistik: alle Zahlen aus gespeicherten Daten', async () => {
  const empty = academyStats({});
  assert.equal(empty.videos + empty.confirmed + empty.failed + empty.claims, 0);
  const { a } = academy();
  await (await a.addLink('https://youtu.be/dQw4w9WgXcQ')).done;
  const s = a.stats();
  assert.equal(s.videos, 1);
  assert.equal(s.analyzed, 1);
  assert.equal(s.claims, a.claims.length);
  assert.equal(s.confirmed, a.claims.filter((c) => c.status === 'confirmed').length);
  assert.ok(validateSource(a.sources[0]));
  assert.equal(findConflicts(a.claims).list.length, 0);
});

test('Kamera-Lernmodus: Fehlerkennung melden speichert nur Kartenwerte', async () => {
  const { a } = academy();
  const f = await a.addFeedback({ kind: 'wrong-card', roundId: 'r1', dealer: [{ rank: 'K', score: 0.7, image: 'data:...' }], hands: [[{ rank: '5', score: 0.9 }]], uncertain: true });
  assert.deepEqual(Object.keys(f.dealer[0]).sort(), ['rank', 'score'], 'keine Bilder');
  assert.equal(a.stats().feedback, 1);
  await a.removeFeedback(f.id);
  assert.equal(a.feedback.length, 0);
});
