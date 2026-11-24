// Tests für Phase 8 (Version 0.8.0): Deckanzahl, exakte Engine, Archiv-Auswertung (Academy-Teile seit 0.9.0 entfernt).
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
import { ArchiveStore } from '../js/archive/archive-store.js';
import { validateRound } from '../js/archive/round-record.js';
import { roundInsight, learningProgress, recurringMistakes, resultStats, uncertainCards } from '../js/archive/insights.js';
import { bankrollStats, defaultConfig } from '../js/risk/bankroll.js';
import { assessRisk } from '../js/risk/risk.js';

const R6 = { decks: 6, soft17: 'steht', das: true, payout: '3:2' };

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

test('3 Speicher voll wird erkannt und verständlich gemeldet', async () => {
  assert.ok(isQuotaError({ name: 'QuotaExceededError' }));
  assert.ok(isQuotaError({ code: 'quota', message: '' }));
  assert.ok(!isQuotaError(new Error('anderer Fehler')));
  const full = new MemoryDatabase({ persist: { load: () => [], save: () => false } });
  await assert.rejects(() => full.put('rounds', { id: 'r_voll' }), (err) => err.code === 'quota' && /Speicher voll/.test(err.message));
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
  assert.match(sw, /bj-assistent-v0\.10\.0/);
  const files = ['js/archive/insights.js', 'js/strategy/exact.js', 'js/strategy/table-rules.js'];
  for (const f of files) {
    assert.ok(sw.includes(`'./${f}'`), `${f} im Offline-Speicher`);
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/from '\//.test(src), `${f}: nur relative Importe`);
    assert.ok(!/fetch\(/.test(src), `${f}: kein Netzwerkzugriff`);
    assert.ok(!/(api[_-]?key|secret)\s*[:=]\s*['"][A-Za-z0-9]/i.test(src), `${f}: kein Schlüssel im Code`);
  }
  for (const v of ['APP_VERSION = \'0.10.0', '"version": "0.10.0"']) {
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
