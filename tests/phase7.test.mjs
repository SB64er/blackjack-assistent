// Tests für Phase 7 (Version 0.7.0): Simulations-Engine, Strategievergleich,
// Echtgeld & Risiko, Entscheidungssystem, Archiv mit Geldbeträgen, Chat,
// Wissensbibliothek, Video-Lernen, Erkennung, Migration. Aufruf: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Simulation, compareStrategies, expectedLongestRun } from '../js/strategy/simulate.js';
import { strategyEV } from '../js/strategy/ev.js';
import { DEFAULT_RULES, normalizeRules } from '../js/strategy/standard.js';
import { MemoryDatabase, STORES, DB_VERSION } from '../js/core/idb.js';
import { BankrollStore, bankrollStats, computedPayout, raisesLimits, validateEntry, defaultConfig } from '../js/risk/bankroll.js';
import { assessRisk, stakeCheck, outlook } from '../js/risk/risk.js';
import { strategyAdvice, activeStrategyEV } from '../js/strategy/decision.js';
import { ArchiveStore } from '../js/archive/archive-store.js';
import { validateRound, recomputeRound, summarizeRounds, RECORD_SCHEMA } from '../js/archive/round-record.js';
import { SimulationStore } from '../js/strategy/sim-store.js';
import { CardTracker } from '../js/game/card-tracker.js';
import { whiteMask } from '../js/recognition/vision.js';
import { migrateCalibrationV1, REGION_DEFS } from '../js/calibration/calibration-store.js';
import { ProfileStore, STANDARD_ID } from '../js/strategy/profiles.js';
import { Emitter } from '../js/core/events.js';

const R = DEFAULT_RULES;
const card = (rank) => ({ rank, confident: true });
class FakeSettings extends Emitter {
  constructor(rules = R) { super(); this.rules = { ...rules }; }
  get(path) { return path === 'rules' ? this.rules : undefined; }
}
function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    load: (k, fb) => (k in data ? JSON.parse(JSON.stringify(data[k])) : fb),
    save: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); return true; }
  };
}

// --- 3. Mathematisch korrekte Simulation, 8. Double/Split-Abrechnung ------------
test('Simulation: Verdoppeln wird mit doppeltem Einsatz abgerechnet', () => {
  // Spieler 5,6 = 11 gegen 6 -> Verdoppeln, zieht 10 = 21; Dealer 6,10 zieht 10 = 26 (überkauft)
  const s = new Simulation({ rules: R, stacked: ['5', '6', '6', '10', '10', '10'], record: true });
  const r = s.step(1);
  assert.equal(r.net, 2);
  assert.deepEqual(s.log[0].player[0], { cards: ['5', '6', '10'], bet: 2, net: 2, actions: ['DOUBLE'] });
  assert.equal(r.wagered, 2);
  assert.equal(r.doubles, 1);
});

test('Simulation: Split mit Verdoppeln nach Split, jede Hand einzeln abgerechnet', () => {
  // 8,8 gegen 6 -> Split; Hand 1: 8,3 -> Verdoppeln (+10 = 21); Hand 2: 8,10 = 18 Stehen; Dealer 6,10,9 = 25
  const s = new Simulation({ rules: R, stacked: ['8', '6', '8', '10', '3', '10', '10', '9'], record: true });
  const r = s.step(1);
  assert.equal(r.net, 3, '2 (verdoppelt) + 1');
  assert.equal(s.log[0].player.length, 2);
  assert.deepEqual(s.log[0].player.map((h) => h.bet), [2, 1]);
  assert.equal(r.splits, 1);
  assert.equal(r.wagered, 3);
});

test('Simulation: Blackjack-Auszahlung 3:2 und 6:5, Dealer-Blackjack, Push', () => {
  assert.equal(new Simulation({ rules: R, stacked: ['A', '9', 'K', '7'] }).step(1).net, 1.5);
  assert.equal(new Simulation({ rules: { ...R, payout: '6:5' }, stacked: ['A', '9', 'K', '7'] }).step(1).net, 1.2);
  assert.equal(new Simulation({ rules: R, stacked: ['10', 'A', '9', 'K'] }).step(1).net, -1, 'Dealer-Blackjack');
  assert.equal(new Simulation({ rules: R, stacked: ['A', 'A', 'K', 'K'] }).step(1).net, 0, 'beide Blackjack');
  // 10,8 = 18 gegen 10,8 = 18 -> Push
  const p = new Simulation({ rules: R, stacked: ['10', '10', '8', '8'] }).step(1);
  assert.equal(p.net, 0);
  assert.equal(p.pushes, 1);
});

test('Simulation: Statistik (Quoten, Drawdown, Verlustserien) und Nähe zum exakten Erwartungswert', () => {
  const r = new Simulation({ rules: R, seed: 7 }).step(200000);
  assert.ok(Math.abs(r.winRate + r.lossRate + r.pushRate - 1) < 1e-9);
  assert.ok(r.maxDrawdown > 0 && r.longestLossStreak > 3);
  assert.ok(r.avgWager > 1 && r.avgWager < 1.25, 'Einsatz inkl. Verdoppeln/Split');
  assert.ok(Math.abs(r.perInitialUnit - r.ev) < 1e-12);
  const exact = strategyEV(R).ev;
  assert.ok(exact < 0, 'Basic Strategy hat bei üblichen Regeln einen negativen Erwartungswert');
  assert.ok(Math.abs(r.ev - exact) < 4 * r.se + 0.003, `Simulation ${r.ev} vs. exakt ${exact}`);
  assert.ok(expectedLongestRun(1000, 0.48) > 5);
});

// --- 4. Strategievergleich -------------------------------------------------------
test('Strategievergleich: gleiche Bedingungen, reproduzierbar, schlechte Strategie erkannt', () => {
  const always = {}; // Schlechte Strategie: 12–16 immer stehen
  for (let v = 12; v <= 16; v++) for (let u = 2; u <= 11; u++) always[`hard:${v}:${u}`] = 'S';
  const run = () => compareStrategies({ rules: R, rounds: 20000, seed: 99, strategies: [
    { id: 'a', name: 'Standard' }, { id: 'b', name: 'Standard (Kopie)' }, { id: 'c', name: 'Immer stehen', overrides: always }
  ] });
  const [a, b, c] = run();
  assert.equal(a.ev, b.ev, 'gleiche Strategie + gleicher Startwert = identisches Ergebnis');
  assert.deepEqual(run().map((x) => x.ev), [a.ev, b.ev, c.ev]);
  assert.ok(c.ev < a.ev, 'schlechtere Strategie schneidet schlechter ab');
});

// --- 6. Echtgeldbudget und Saldo ---------------------------------------------------
test('Echtgeld: Aktivierung nur mit Bestätigung, Budget, Saldo, Protokoll, dauerhaft', async () => {
  const storage = memoryStorage();
  const b = new BankrollStore({ db: new MemoryDatabase({ persist: storage }) });
  await b.ready();
  await assert.rejects(b.enable({ acknowledged: false }), /Verlusten/);
  await b.enable({ acknowledged: true });
  await assert.rejects(b.addRound({ stake: 10, payout: 0 }), /Startsaldo/);
  await b.setup({ currency: 'CHF', budget: 200, startBalance: 200 });
  const r1 = await b.addRound({ stake: 10, payout: 0 });
  assert.equal(r1.balanceBefore, 200);
  assert.equal(r1.balanceAfter, 190);
  const r2 = await b.addRound({ stake: 10, extra: 10, payout: 40 });
  assert.equal(r2.entry.net, 20, 'Verdoppelt gewonnen: Auszahlung 40 – Einsatz 20');
  await b.addRound({ stake: 10, payout: 25, payoutSource: 'manual' });
  const s = b.stats();
  assert.equal(s.balance, 225);
  assert.equal(s.rounds, 3);
  assert.equal(s.won, 35);
  assert.equal(s.lost, 10);
  assert.equal(s.avgStake, 10);
  await b.addTransfer('withdrawal', 25, 'abgehoben');
  assert.equal(b.stats().balance, 200);
  assert.equal(b.stats().net, 25, 'Auszahlungen vom Spielkonto zählen nicht als Verlust');
  // Neustart: alles noch da
  const b2 = new BankrollStore({ db: new MemoryDatabase({ persist: storage }) });
  await b2.ready();
  assert.equal(b2.stats().balance, 200);
  assert.ok(b2.entries.length >= 6);
  assert.equal(validateEntry({ id: 'x', at: new Date().toISOString(), type: 'round', stake: -1, payout: 0 }), null, 'negative Beträge ungültig');
});

// --- 7. Verlustlimits ------------------------------------------------------------
test('Verlustlimits: Warnung, Stopp, keine Einsatzempfehlung, Limits nur senkbar in Sitzung', async () => {
  const b = new BankrollStore({ db: new MemoryDatabase() });
  await b.enable({ acknowledged: true });
  await b.setup({ budget: 100, startBalance: 100 });
  await b.setLimits({ maxBet: 10, sessionLoss: 30, dailyLoss: null });
  await b.startSession();
  await assert.rejects(b.setLimits({ maxBet: 20, sessionLoss: 30 }), /nur gesenkt/);
  await assert.rejects(b.setLimits({ maxBet: 10, sessionLoss: null }), /nur gesenkt/, 'Entfernen = Erhöhen');
  await b.setLimits({ maxBet: 5, sessionLoss: 30 }); // senken erlaubt
  await b.setLimits({ maxBet: 10, sessionLoss: 30 }).catch(() => {}); // erhöhen abgelehnt
  assert.equal(b.config.limits.maxBet, 5);
  assert.ok(raisesLimits({ maxBet: 5 }, { maxBet: 6 }));
  assert.ok(!raisesLimits({ maxBet: 5 }, { maxBet: 4 }));

  let risk = assessRisk({ config: b.config, stats: b.stats() });
  assert.equal(risk.level, 'ok');
  assert.equal(risk.maxStake, 5);
  for (let i = 0; i < 5; i++) await b.addRound({ stake: 5, payout: 0 });
  risk = assessRisk({ config: b.config, stats: b.stats() });
  assert.equal(risk.level, 'warn', '25 von 30 verloren -> Warnung');
  assert.ok(risk.messages.some((m) => m.code === 'session-limit-near'));
  await b.addRound({ stake: 5, payout: 0 });
  risk = assessRisk({ config: b.config, stats: b.stats(), proposedStake: 5 });
  assert.equal(risk.level, 'stop');
  assert.equal(risk.stop, true);
  assert.equal(risk.canSuggestStake, false, 'keine weiteren Einsatzempfehlungen');
  assert.equal(risk.maxStake, null);
  assert.ok(risk.messages.some((m) => m.tone === 'stop' && /Stopp/.test(m.text)));
  // Limits werden nie automatisch erhöht
  assert.equal(b.config.limits.sessionLoss, 30);
  // Neue Sitzung -> Sitzungsverlust zurückgesetzt, Tageslimit greift weiter falls gesetzt
  await b.endSession();
  await b.setLimits({ maxBet: 5, sessionLoss: 30, dailyLoss: 20 });
  await b.startSession();
  risk = assessRisk({ config: b.config, stats: b.stats() });
  assert.equal(risk.stop, true, 'Tagesverlust 30 >= Tageslimit 20');
  assert.ok(risk.messages.some((m) => m.code === 'daily-limit'));
});

test('Schutz: Einsatzerhöhung nach Verlust (Martingale-Muster) wird gewarnt, nie empfohlen', async () => {
  const b = new BankrollStore({ db: new MemoryDatabase() });
  await b.enable({ acknowledged: true });
  await b.setup({ budget: 500, startBalance: 500 });
  await b.setLimits({ maxBet: 100, sessionLoss: 300 });
  await b.addRound({ stake: 10, payout: 0 });
  const last = b.entries.filter((e) => e.type === 'round').pop();
  assert.equal(stakeCheck({ stake: 20, lastRound: last }).code, 'raise-after-loss');
  assert.equal(stakeCheck({ stake: 10, lastRound: last }), null);
  await b.addRound({ stake: 20, payout: 0 });
  await b.addRound({ stake: 40, payout: 0 });
  const risk = assessRisk({ config: b.config, stats: b.stats() });
  assert.ok(risk.messages.some((m) => m.code === 'chasing'));
  const all = JSON.stringify(risk.messages);
  assert.ok(!/erhöhe (deinen )?Einsatz|verdopple|zurückgewinnen kannst/i.test(all), 'keine Aufforderung zu höheren Einsätzen');
});

// --- 8. Double/Split-Abrechnung im Archiv -------------------------------------------
test('Archiv: Einsatz, Zusatzeinsatz, Auszahlung, Netto je Hand (Double, Split, Blackjack)', () => {
  assert.equal(computedPayout({ outcome: 'win', stake: 10, extra: 10 }), 40);
  assert.equal(computedPayout({ outcome: 'loss', stake: 10, extra: 10 }), 0);
  assert.equal(computedPayout({ outcome: 'push', stake: 10 }), 10);
  assert.equal(computedPayout({ outcome: 'win', stake: 10, blackjack: true }), 25);
  assert.equal(computedPayout({ outcome: 'win', stake: 10, blackjack: true, payoutRule: '6:5' }), 22);
  assert.equal(computedPayout({ outcome: 'win', stake: null }), null, 'ohne Einsatz nichts berechnen');
  const rec = validateRound({
    id: 'r_money', schema: 2, startedAt: '2026-11-22T10:00:00Z', rules: R,
    dealer: { cards: [{ rank: '6' }, { rank: '10' }, { rank: '10' }] },
    hands: [
      { split: true, cards: [{ rank: '8' }, { rank: '3' }, { rank: '10' }], actions: [{ action: 'SPLIT' }, { action: 'DOUBLE', cardsBefore: ['8', '3'] }], bet: 10 },
      { split: true, cards: [{ rank: '8' }, { rank: '10' }], actions: [], bet: 10 },
      { cards: [{ rank: '8' }, { rank: '9' }], actions: [] }
    ]
  });
  recomputeRound(rec);
  assert.equal(rec.hands[0].outcome, 'win');
  assert.equal(rec.hands[0].extraBet, 10, 'Verdoppeln: Zusatzeinsatz = Einsatz');
  assert.equal(rec.hands[0].payout, 40);
  assert.equal(rec.hands[0].payoutSource, 'computed');
  assert.equal(rec.hands[0].moneyNet, 20);
  assert.equal(rec.hands[0].net, 2, 'Einsatz-Einheiten getrennt vom Geld');
  assert.equal(rec.hands[1].moneyNet, 10);
  assert.equal(rec.hands[2].bet, null);
  assert.equal(rec.hands[2].payout, null, 'keine erfundenen Beträge');
  assert.equal(rec.hands[2].moneyNet, null);
  // tatsächlich abweichende Auszahlung bleibt (manuell)
  rec.hands[1].payout = 15; rec.hands[1].payoutSource = 'manual';
  recomputeRound(rec);
  assert.equal(rec.hands[1].payout, 15);
  assert.equal(rec.hands[1].moneyNet, 5);
  const s = summarizeRounds([rec]);
  assert.equal(s.moneyHands, 2);
  assert.equal(s.moneyNet, 25);
});

// --- 10. Archivierte Gewinne und Verluste --------------------------------------------
test('Archiv: Geldbeträge und Saldo ergänzen, ohne Karten als bestätigt zu markieren', async () => {
  const a = new ArchiveStore({ db: new MemoryDatabase() });
  await a.add({
    id: 'r_m1', startedAt: '2026-11-22T11:00:00Z', rules: R, source: 'live',
    dealer: { cards: [{ rank: '10' }, { rank: '7' }] },
    hands: [{ cards: [{ rank: '10' }, { rank: '9' }], actions: [{ action: 'STAND', cardsBefore: ['10', '9'], recommended: 'STAND' }] }]
  });
  assert.equal(a.get('r_m1').status, 'complete');
  await a.setMoney('r_m1', { hands: [{ bet: 20, payout: 40 }], money: { currency: 'CHF', balanceBefore: 100, balanceAfter: 120, ledgerId: 'e1' } });
  const r = a.get('r_m1');
  assert.equal(r.status, 'complete', 'Geld ergänzen ändert die Kartenbestätigung nicht');
  assert.equal(r.hands[0].moneyNet, 20);
  assert.equal(r.money.balanceAfter, 120);
  assert.equal(r.hands[0].actions[0].recommended, 'STAND');
  assert.equal(r.schema, RECORD_SCHEMA);
});

// --- 9. Negative Erwartungswerte und Warnmeldungen ----------------------------------
test('Negativer Erwartungswert wird angezeigt und vom Echtgeldspiel abgeraten', () => {
  const ev = activeStrategyEV({ rules: R });
  assert.ok(ev.ev < 0);
  const bad = activeStrategyEV({ rules: { ...R, payout: '6:5' } });
  assert.ok(bad.ev < ev.ev - 0.01, '6:5 deutlich schlechter');
  const cfg = { ...defaultConfig(), enabled: true, budget: 100, startBalance: 100, limits: { maxBet: 10, sessionLoss: 50, dailyLoss: null } };
  const risk = assessRisk({ config: cfg, stats: bankrollStats(cfg, []), strategy: ev });
  assert.equal(risk.negativeEv, true);
  const m = risk.messages.find((x) => x.code === 'negative-ev');
  assert.ok(m && /rät vom Spiel mit echtem Geld ab/.test(m.text));
  assert.equal(risk.level, 'warn');
  // Auch ohne aktiven Echtgeld-Modus wird der negative Erwartungswert gemeldet
  const off = assessRisk({ config: defaultConfig(), stats: bankrollStats(defaultConfig(), []), strategy: ev });
  assert.equal(off.level, 'off');
  assert.ok(off.messages.some((x) => x.code === 'negative-ev'));
  const o = outlook(-0.005, 10, 100);
  assert.ok(o.expected < 0 && o.low < o.expected && o.high > 0);
});

test('Entscheidungssystem: Strategie- und Risikointelligenz getrennt prüfbar', () => {
  const a = strategyAdvice({ cards: [card('10'), card('6')], up: card('10'), rules: R, profileName: 'Standardstrategie' });
  assert.equal(a.action, 'HIT');
  assert.ok(a.evs.HIT > a.evs.STAND);
  assert.match(a.explanation, /keine Empfehlung, Geld einzusetzen/);
  // Strategieintelligenz kennt kein Budget – gleiche Antwort unabhängig vom Risiko
  const b = strategyAdvice({ cards: [card('10'), card('6')], up: card('10'), rules: R });
  assert.equal(b.action, a.action);
  // Risikointelligenz kennt keine Karten
  const cfg = { ...defaultConfig(), enabled: true, budget: 100, startBalance: 0, limits: { maxBet: 10, sessionLoss: 50, dailyLoss: null } };
  const risk = assessRisk({ config: cfg, stats: bankrollStats(cfg, []) });
  assert.equal(risk.stop, true, 'Saldo 0 -> Stopp, egal welche Karten');
  // Abweichende Profiltabelle wird mit Verlust begründet
  const dev = strategyAdvice({ cards: [card('10'), card('6')], up: card('10'), rules: R, overrides: { 'hard:16:10': 'S' }, profileName: 'Test' });
  assert.equal(dev.action, 'STAND');
  assert.equal(dev.deviatesFromModel, true);
});

test('Simulationen werden getrennt von echten Runden gespeichert', async () => {
  const db = new MemoryDatabase();
  const sims = new SimulationStore({ db });
  const archive = new ArchiveStore({ db });
  await sims.ready();
  const res = compareStrategies({ rules: R, rounds: 2000, seed: 1, strategies: [{ id: 'p:standard', name: 'Standard' }] });
  await sims.add({ rules: R, rounds: 2000, seed: 1, results: res });
  assert.equal(sims.list.length, 1);
  assert.equal((await db.all('simulations')).length, 1);
  await archive.ready();
  assert.equal(archive.rounds.length, 0, 'keine Simulation im Spielarchiv');
  assert.equal((await db.all('rounds')).length, 0);
});

// --- 13. Gemeinsames Dealer-Feld / Erkennung --------------------------------------------
test('Erkennung: überlappende neue Karte gleichen Werts wird nicht als Bewegung gezählt', () => {
  const det = (rank, x, y = 0.2) => ({ rank, score: 0.95, confident: true, box: { x, y, w: 0.02, h: 0.04 } });
  const tr = new CardTracker();
  tr.update([det('10', 0.40)], 1); tr.update([det('10', 0.40)], 2);
  assert.equal(tr.confirmed().length, 1);
  // Alte 10 kurz verdeckt, neue 10 weit entfernt (ausserhalb Bewegungsradius) -> neue Karte
  const far = new CardTracker({ moveRadius: 0.2 });
  far.update([det('10', 0.10)], 1); far.update([det('10', 0.10)], 2);
  far.update([det('10', 0.70)], 3); far.update([det('10', 0.70)], 4);
  assert.equal(far.confirmed().length, 2, 'keine Doppelzählung, aber auch keine verschluckte Karte');
  // Verschiebung innerhalb des Radius bleibt dieselbe Karte
  const mv = new CardTracker();
  mv.update([det('9', 0.10)], 1); mv.update([det('9', 0.10)], 2);
  mv.update([det('9', 0.25)], 3); mv.update([det('9', 0.25)], 4);
  assert.equal(mv.confirmed().length, 1);
  assert.equal(REGION_DEFS.map((r) => r.id).filter((id) => id.startsWith('dealer')).length, 1, 'ein Dealer-Feld');
});

test('Erkennung: schwaches Licht – Kartenweiss wird trotzdem erkannt, normales Licht unverändert', () => {
  const n = 400;
  const gray = new Uint8Array(n);
  const sat = new Uint8Array(n);
  // dunkles Bild: Tisch 40, Karte 140 (bei normalem Licht wäre Karte > 200)
  for (let i = 0; i < n; i++) gray[i] = i < 300 ? 40 : 140;
  const dim = whiteMask(gray, sat);
  assert.ok(dim.ratio > 0.2, 'Karte bei schwachem Licht erkannt');
  const fixed = whiteMask(gray, sat, { adaptive: false });
  assert.ok(fixed.ratio > 0.2 || fixed.threshold >= 120);
  const bright = new Uint8Array(n);
  for (let i = 0; i < n; i++) bright[i] = i < 300 ? 60 : 230;
  assert.deepEqual(whiteMask(bright, sat).threshold, whiteMask(bright, sat, { adaptive: false }).threshold);
});

// --- 12. Bestehende Strategieprofile, 14. Migration aus 0.6.0 --------------------------------
test('Strategieprofile aus 0.6.0 bleiben erhalten (Standard + eigene)', () => {
  const storage = memoryStorage();
  const settings = new FakeSettings();
  const a = new ProfileStore({ settings, storage });
  const own = a.duplicate(STANDARD_ID, 'Mein Profil');
  a.activate(own.id);
  const b = new ProfileStore({ settings, storage });
  assert.equal(b.list()[0].id, STANDARD_ID);
  assert.equal(b.active.name, 'Mein Profil');
});

test('Migration aus 0.6.0: Datenbank v2 mit neuen Bereichen, Archiv-Einträge Schema 1 lesbar', async () => {
  assert.ok(DB_VERSION >= 2, 'ab 0.8.0 Version 3 – Bereiche aus Version 2 bleiben'); // 0.8.0: DB_VERSION 3
  for (const s of ['rounds', 'knowledge', 'videos', 'versions', 'meta']) assert.ok(STORES.includes(s), `alter Bereich ${s} bleibt`);
  for (const s of ['simulations', 'ledger', 'history']) assert.ok(STORES.includes(s), `neuer Bereich ${s}`);
  // Gespeicherte 0.6.0-Runde mit Einsatz (damals: net in Geld, payout = net)
  const old = {
    schema: 1, id: 'r_old', startedAt: '2026-11-20T10:00:00Z', rules: R, status: 'complete',
    dealer: { cards: [{ rank: '10' }, { rank: '7' }], total: 17, final: true },
    hands: [{ cards: [{ rank: '10' }, { rank: '9' }], actions: [], outcome: 'win', outcomeSource: 'auto', bet: 20, net: 20, payout: 20 }]
  };
  const storage = memoryStorage({ 'db.rounds': [old] });
  const a = new ArchiveStore({ db: new MemoryDatabase({ persist: storage }) });
  await a.ready();
  const r = a.get('r_old');
  assert.ok(r, 'alte Runde lesbar');
  assert.equal(r.migratedFrom, 1);
  assert.equal(r.hands[0].net, 1, 'jetzt in Einsatz-Einheiten');
  assert.equal(r.hands[0].bet, 20);
  assert.equal(r.hands[0].payout, 40, 'Auszahlung aus Einsatz + Ergebnis berechnet (gekennzeichnet)');
  assert.equal(r.hands[0].payoutSource, 'computed');
  assert.equal(r.hands[0].moneyNet, 20);
  assert.deepEqual(storage.data['db.rounds'][0], old, 'gespeicherter Eintrag bleibt beim Laden unverändert');
  // Kalibrierung aus 0.5.x wird weiterhin migriert
  const cal = migrateCalibrationV1({ version: 1, frame: { width: 1920, height: 1080, aspect: 1.778, orientation: 'landscape' }, regions: { dealerUp: { x: 0.3, y: 0.1, w: 0.1, h: 0.2 }, dealerHole: { x: 0.45, y: 0.1, w: 0.1, h: 0.2 }, player: { x: 0.3, y: 0.6, w: 0.3, h: 0.3 } } });
  assert.ok(cal.regions.dealer && !cal.regions.dealerUp);
});

// --- 15. Offline-Funktion und GitHub-Pages-Kompatibilität -----------------------------------
test('Offline/GitHub Pages: neue Dateien im Offline-Speicher, nur relative Pfade, Version (seit 0.11.0: 0.11.0)', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  for (const f of ['js/risk/bankroll.js', 'js/risk/risk.js', 'js/strategy/decision.js', 'js/strategy/sim-store.js', 'js/views/lab-view.js', 'js/views/risk-view.js']) {
    assert.ok(sw.includes(`'./${f}'`), `${f} im Offline-Speicher`);
  }
  assert.match(sw, /bj-assistent-v0\.11\.0/);
  const files = ['js/risk/bankroll.js', 'js/risk/risk.js', 'js/views/lab-view.js', 'js/views/risk-view.js'];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/from '\//.test(src) && !/fetch\(/.test(src), `${f}: keine absoluten Importe, keine Netzwerkzugriffe`);
  }
});

test('Simulierte Gewinnquote gilt nicht als Beweis – keine Gewinnversprechen in Texten', () => {
  for (const f of ['js/views/lab-view.js', 'js/views/risk-view.js', 'js/risk/risk.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(/Keine Gewinngarantie|keine Gewinngarantie|garantiert keinen Gewinn|keine Gewinnversprechen|Keine Gewinnversprechen|beweist keine profitable/.test(src), `${f} weist auf fehlende Gewinngarantie hin`);
    assert.ok(!/garantierter Gewinn|sicherer Gewinn|risikolos/i.test(src), `${f}: keine Gewinnversprechen`);
  }
  assert.ok(normalizeRules(R).decks === 6);
});
