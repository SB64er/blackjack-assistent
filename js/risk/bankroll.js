// Echtgeld & Risiko – Budget, Saldo und Protokoll (lokal, nachvollziehbar).
//
// Grundsätze:
//  - Es werden NUR Beträge gespeichert, die der Benutzer selbst eingibt. Nichts wird erfunden.
//  - Das Protokoll ist fortlaufend: Korrekturen sind neue Einträge, nichts wird still überschrieben.
//  - Limits werden nie automatisch erhöht. Während einer laufenden Sitzung können sie nur
//    gesenkt werden (Schutz vor dem Versuch, Verluste zurückzugewinnen).
//  - BJ.AI platziert keine Wetten und hat keinen Zugriff auf Casino-Konten.
// Reine Logik + kleiner Speicher (IndexedDB über die gemeinsame Datenbank).
import { Emitter } from '../core/events.js';

export const BANKROLL_VERSION = 1;
export const ENTRY_TYPES = ['start', 'round', 'deposit', 'withdrawal', 'correction', 'limits', 'session-start', 'session-end', 'enable', 'disable'];
export const ENTRY_TEXT = {
  start: 'Startsaldo', round: 'Runde', deposit: 'Einzahlung', withdrawal: 'Auszahlung vom Spielkonto',
  correction: 'Korrektur', limits: 'Limits geändert', 'session-start': 'Sitzung gestartet', 'session-end': 'Sitzung beendet',
  enable: 'Echtgeld-Modus aktiviert', disable: 'Echtgeld-Modus deaktiviert'
};
export const DEFAULT_WARN_AT = 0.8; // Warnung ab 80 % eines Limits

const nowIso = () => new Date().toISOString();
const money = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const nonNeg = (x) => { const v = money(x); return v != null && v >= 0 ? v : null; };
const pos = (x) => { const v = money(x); return v != null && v > 0 ? v : null; };

export class BankrollError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function defaultConfig() {
  return {
    id: 'bankroll',
    version: BANKROLL_VERSION,
    enabled: false,
    acknowledgedAt: null,
    currency: 'CHF',
    budget: null,
    startBalance: null,
    startedAt: null,
    limits: { maxBet: null, sessionLoss: null, dailyLoss: null },
    warnAt: DEFAULT_WARN_AT,
    session: null
  };
}

export function validateConfig(x) {
  const d = defaultConfig();
  if (!x || typeof x !== 'object') return d;
  const l = x.limits && typeof x.limits === 'object' ? x.limits : {};
  const s = x.session && typeof x.session === 'object' && typeof x.session.id === 'string' ? x.session : null;
  return {
    ...d,
    enabled: !!x.enabled,
    acknowledgedAt: typeof x.acknowledgedAt === 'string' ? x.acknowledgedAt : null,
    currency: typeof x.currency === 'string' && /^[A-Za-z€$£]{1,4}$/.test(x.currency) ? x.currency : 'CHF',
    budget: pos(x.budget),
    startBalance: nonNeg(x.startBalance),
    startedAt: typeof x.startedAt === 'string' ? x.startedAt : null,
    limits: { maxBet: pos(l.maxBet), sessionLoss: pos(l.sessionLoss), dailyLoss: pos(l.dailyLoss) },
    warnAt: typeof x.warnAt === 'number' && x.warnAt >= 0.5 && x.warnAt < 1 ? x.warnAt : DEFAULT_WARN_AT,
    session: s ? { id: s.id, startedAt: String(s.startedAt || nowIso()), startBalance: money(s.startBalance) ?? 0 } : null
  };
}

export function validateEntry(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !ENTRY_TYPES.includes(x.type)) return null;
  if (typeof x.at !== 'string' || Number.isNaN(Date.parse(x.at))) return null;
  const e = {
    id: x.id.slice(0, 80),
    at: x.at,
    type: x.type,
    note: typeof x.note === 'string' ? x.note.slice(0, 300) : '',
    sessionId: typeof x.sessionId === 'string' ? x.sessionId : null,
    roundId: typeof x.roundId === 'string' ? x.roundId : null
  };
  if (x.type === 'round') {
    e.stake = nonNeg(x.stake);
    e.extra = nonNeg(x.extra) ?? 0;
    e.payout = nonNeg(x.payout);
    if (e.stake == null || e.payout == null) return null;
    e.net = money(e.payout - e.stake - e.extra);
    e.payoutSource = x.payoutSource === 'computed' ? 'computed' : 'manual';
  } else if (['start', 'deposit', 'withdrawal'].includes(x.type)) {
    e.amount = nonNeg(x.amount);
    if (e.amount == null) return null;
  } else if (x.type === 'correction') {
    e.amount = money(x.amount);
    if (e.amount == null) return null;
  } else if (x.type === 'limits') {
    e.before = x.before && typeof x.before === 'object' ? x.before : null;
    e.after = x.after && typeof x.after === 'object' ? x.after : null;
  }
  return e;
}

/** Saldo-Änderung eines Eintrags. 'start' setzt den Saldo. */
function applyEntry(balance, e) {
  switch (e.type) {
    case 'start': return e.amount;
    case 'round': return balance + e.net;
    case 'deposit': return balance + e.amount;
    case 'withdrawal': return balance - e.amount;
    case 'correction': return balance + e.amount;
    default: return balance;
  }
}

const dayKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Kennzahlen aus dem Protokoll (nur echte, eingegebene Beträge).
 * @returns {{ balance, peak, drawdown, rounds, won, lost, net, avgStake, avgWagered,
 *   longestLossStreak, worstLossRun, utilization, session, today, raisesAfterLoss }}
 */
export function bankrollStats(config, entries, now = new Date()) {
  const list = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  let balance = config.startBalance ?? 0;
  // Rückgang ohne Ein-/Auszahlungen: nur Spielergebnisse und Korrekturen zählen.
  let perf = balance;
  let peak = perf;
  let rounds = 0, won = 0, lost = 0, stakeSum = 0, wageredSum = 0;
  let streak = 0, longest = 0, run = 0, worstRun = 0;
  let raisesAfterLoss = 0;
  let prevRound = null;
  const sessionId = config.session ? config.session.id : null;
  const today = dayKey(now.toISOString());
  const session = { rounds: 0, net: 0, loss: 0 };
  const day = { rounds: 0, net: 0, loss: 0 };
  for (const e of list) {
    balance = applyEntry(balance, e);
    if (e.type === 'start') { perf = balance; peak = perf; }
    if (e.type === 'round') perf += e.net;
    if (e.type === 'correction') perf += e.amount;
    if (e.type === 'round') {
      rounds += 1;
      stakeSum += e.stake;
      wageredSum += e.stake + e.extra;
      if (e.net > 0) won += e.net;
      if (e.net < 0) lost += -e.net;
      if (e.net < 0) { streak += 1; run += -e.net; } else if (e.net > 0) { streak = 0; run = 0; }
      longest = Math.max(longest, streak);
      worstRun = Math.max(worstRun, run);
      if (prevRound && prevRound.net < 0 && e.stake > prevRound.stake) raisesAfterLoss += 1;
      prevRound = e;
      if (sessionId && e.sessionId === sessionId) { session.rounds += 1; session.net += e.net; }
      if (dayKey(e.at) === today) { day.rounds += 1; day.net += e.net; }
    }
    peak = Math.max(peak, perf);
  }
  session.net = money(session.net);
  day.net = money(day.net);
  session.loss = Math.max(0, -session.net);
  day.loss = Math.max(0, -day.net);
  const start = config.startBalance ?? 0;
  const lossFromStart = Math.max(0, start - perf);
  return {
    balance: money(balance),
    peak: money(peak),
    drawdown: money(Math.max(0, peak - perf)),
    rounds,
    won: money(won),
    lost: money(lost),
    net: money(won - lost),
    avgStake: rounds ? money(stakeSum / rounds) : null,
    avgWagered: rounds ? money(wageredSum / rounds) : null,
    longestLossStreak: longest,
    // 0.8.0: laufende Verlustserie (aufeinanderfolgende verlorene Runden bis jetzt)
    currentLossStreak: streak,
    currentLossRun: money(run),
    worstLossRun: money(worstRun),
    utilization: config.budget ? lossFromStart / config.budget : null,
    session,
    today: day,
    raisesAfterLoss
  };
}

/**
 * Auszahlung aus Ergebnis BERECHNEN (Vorschlag zum Prüfen, nie stillschweigend gespeichert).
 * payout = alles, was zurückkommt (inkl. Einsatz). Loss = 0, Push = Einsatz zurück.
 */
export function computedPayout({ outcome, stake, extra = 0, blackjack = false, payoutRule = '3:2' }) {
  const s = nonNeg(stake);
  if (s == null || !outcome) return null;
  const total = s + (nonNeg(extra) || 0);
  if (outcome === 'loss') return 0;
  if (outcome === 'push') return money(total);
  if (outcome === 'win') return money(blackjack ? s + s * (payoutRule === '6:5' ? 1.2 : 1.5) : total * 2);
  return null;
}

/** Würde die Änderung ein Limit erhöhen oder entfernen? */
export function raisesLimits(before, after) {
  for (const k of ['maxBet', 'sessionLoss', 'dailyLoss']) {
    const b = before[k];
    const a = after[k];
    if (b != null && (a == null || a > b)) return true;
  }
  return false;
}

let seq = 0;
const newEntryId = () => `e_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export class BankrollStore extends Emitter {
  constructor({ db }) {
    super();
    this.config = defaultConfig();
    this.entries = [];
    this.error = null;
    this._ready = Promise.resolve(db).then(async (d) => {
      this.db = d;
      this.config = validateConfig(await d.get('meta', 'bankroll'));
      this.entries = (await d.all('ledger')).map(validateEntry).filter(Boolean).sort((a, b) => a.at.localeCompare(b.at));
      this.emit('change', { type: 'load' });
    }).catch((err) => {
      this.error = `Echtgeld-Daten konnten nicht geladen werden: ${err.message}`;
      this.emit('change', { type: 'error' });
    });
  }

  ready() { return this._ready; }

  stats(now = new Date()) { return bankrollStats(this.config, this.entries, now); }

  async _saveConfig(patch) {
    this.config = validateConfig({ ...this.config, ...patch });
    await this.db.put('meta', this.config);
  }

  async _log(entry) {
    const e = validateEntry({ id: newEntryId(), at: nowIso(), sessionId: this.config.session ? this.config.session.id : null, ...entry });
    if (!e) throw new BankrollError('invalid', 'Ungültiger Eintrag – bitte Beträge prüfen.');
    await this.db.put('ledger', e);
    this.entries = [...this.entries, e].sort((a, b) => a.at.localeCompare(b.at));
    return e;
  }

  /** Aktivieren nur mit ausdrücklicher Bestätigung des Risikohinweises. */
  async enable({ acknowledged }) {
    await this._ready;
    if (!acknowledged) throw new BankrollError('ack', 'Bitte zuerst bestätigen, dass Blackjack zu finanziellen Verlusten führen kann.');
    await this._saveConfig({ enabled: true, acknowledgedAt: nowIso() });
    await this._log({ type: 'enable' });
    this.emit('change', { type: 'enable' });
  }

  async disable() {
    await this._ready;
    if (this.config.session) await this.endSession();
    await this._saveConfig({ enabled: false });
    await this._log({ type: 'disable' });
    this.emit('change', { type: 'disable' });
  }

  /** Budget und Startsaldo festlegen (der Startsaldo wird als Eintrag protokolliert). */
  async setup({ currency, budget, startBalance }) {
    await this._ready;
    const b = pos(budget);
    const s = nonNeg(startBalance);
    if (b == null) throw new BankrollError('budget', 'Bitte ein Gesamtbudget grösser als 0 eingeben.');
    if (s == null) throw new BankrollError('start', 'Bitte einen Startsaldo eingeben (0 oder mehr).');
    if (this.config.session) throw new BankrollError('session', 'Budget und Startsaldo können nur ausserhalb einer Sitzung geändert werden.');
    await this._saveConfig({ currency: currency || this.config.currency, budget: b, startBalance: s, startedAt: nowIso() });
    await this._log({ type: 'start', amount: s, note: `Gesamtbudget ${b}` });
    this.emit('change', { type: 'setup' });
  }

  /** Limits setzen. Nie automatisch; während einer Sitzung nur senken. */
  async setLimits(next) {
    await this._ready;
    const before = { ...this.config.limits };
    const after = { maxBet: pos(next.maxBet), sessionLoss: pos(next.sessionLoss), dailyLoss: pos(next.dailyLoss) };
    if (this.config.session && raisesLimits(before, after)) {
      throw new BankrollError('raise-in-session', 'Während einer laufenden Sitzung können Limits nur gesenkt werden. Beende zuerst die Sitzung.');
    }
    await this._saveConfig({ limits: after });
    await this._log({ type: 'limits', before, after });
    this.emit('change', { type: 'limits' });
  }

  async startSession() {
    await this._ready;
    if (!this.config.enabled) throw new BankrollError('off', 'Der Echtgeld-Modus ist nicht aktiviert.');
    if (this.config.startBalance == null) throw new BankrollError('setup', 'Bitte zuerst Budget und Startsaldo festlegen.');
    if (this.config.session) return this.config.session;
    const s = { id: `s_${Date.now().toString(36)}`, startedAt: nowIso(), startBalance: this.stats().balance };
    await this._saveConfig({ session: s });
    await this._log({ type: 'session-start', sessionId: s.id });
    this.emit('change', { type: 'session' });
    return s;
  }

  async endSession() {
    await this._ready;
    const s = this.config.session;
    if (!s) return null;
    const st = this.stats();
    await this._log({ type: 'session-end', sessionId: s.id, note: `Sitzung: ${st.session.rounds} Runden, netto ${st.session.net}` });
    await this._saveConfig({ session: null });
    this.emit('change', { type: 'session-end' });
    return s;
  }

  /**
   * Echte Runde protokollieren: Einsatz, Zusatzeinsatz (Verdoppeln/Split), tatsächliche Auszahlung.
   * @returns {{ entry, balanceBefore, balanceAfter }}
   */
  async addRound({ stake, extra = 0, payout, roundId = null, note = '', payoutSource = 'manual' }) {
    await this._ready;
    if (!this.config.enabled) throw new BankrollError('off', 'Der Echtgeld-Modus ist nicht aktiviert.');
    if (this.config.startBalance == null) throw new BankrollError('setup', 'Bitte zuerst Budget und Startsaldo festlegen.');
    if (nonNeg(stake) == null) throw new BankrollError('stake', 'Bitte den tatsächlichen Einsatz eingeben.');
    if (nonNeg(payout) == null) throw new BankrollError('payout', 'Bitte die tatsächliche Auszahlung eingeben (0 bei Verlust).');
    if (!this.config.session) await this.startSession();
    const balanceBefore = this.stats().balance;
    const entry = await this._log({ type: 'round', stake, extra, payout, roundId, note, payoutSource });
    const balanceAfter = this.stats().balance;
    this.emit('change', { type: 'round', id: entry.id });
    return { entry, balanceBefore, balanceAfter };
  }

  async addTransfer(type, amount, note = '') {
    await this._ready;
    if (!['deposit', 'withdrawal', 'correction'].includes(type)) throw new BankrollError('type', 'Unbekannte Buchung.');
    const e = await this._log({ type, amount, note });
    this.emit('change', { type });
    return e;
  }

  exportData() { return { config: this.config, ledger: this.entries }; }

  /** Import: vorhandene Einträge bleiben, neue werden ergänzt. Konfiguration nur, wenn noch keine existiert. */
  async importData(data) {
    await this._ready;
    if (!data || typeof data !== 'object') return 0;
    const have = new Set(this.entries.map((e) => e.id));
    let added = 0;
    for (const raw of Array.isArray(data.ledger) ? data.ledger : []) {
      const e = validateEntry(raw);
      if (e && !have.has(e.id)) { await this.db.put('ledger', e); added += 1; }
    }
    if (data.config && this.config.startBalance == null) {
      const c = validateConfig({ ...data.config, session: null });
      this.config = c;
      await this.db.put('meta', c);
    }
    this.entries = (await this.db.all('ledger')).map(validateEntry).filter(Boolean).sort((a, b) => a.at.localeCompare(b.at));
    this.emit('change', { type: 'import' });
    return added;
  }

  /** Alles löschen – nur nach ausdrücklicher Bestätigung. */
  async clearAll({ confirmed = false } = {}) {
    await this._ready;
    if (!confirmed) throw new BankrollError('confirm', 'Löschen nur nach ausdrücklicher Bestätigung.');
    await this.db.clear('ledger');
    this.config = defaultConfig();
    await this.db.put('meta', this.config);
    this.entries = [];
    this.emit('change', { type: 'clear' });
  }
}
