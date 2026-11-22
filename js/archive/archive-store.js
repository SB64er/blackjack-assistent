// Spielarchiv: alle abgeschlossenen Runden lokal (IndexedDB) speichern,
// korrigieren, löschen, exportieren und importieren.
import { Emitter } from '../core/events.js';
import { validateRound, recomputeRound } from './round-record.js';
import { APP_VERSION } from '../core/version.js';

export const EXPORT_FORMAT = 'bjai-backup';
export const EXPORT_VERSION = 2; // 2 = ab 0.7.0 (Geldbeträge, Echtgeld-Protokoll, Simulationen); Version 1 bleibt importierbar

export class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class ArchiveStore extends Emitter {
  /** @param {{ db: Promise<Database> | Database }} opts */
  constructor({ db }) {
    super();
    this.rounds = [];          // neueste zuerst
    this.invalid = 0;
    this.error = null;
    this.kind = null;
    this._ready = Promise.resolve(db).then(async (d) => {
      this.db = d;
      this.kind = d.kind;
      await this._load();
    }).catch((err) => {
      this.error = `Archiv konnte nicht geöffnet werden: ${err.message}`;
      this.emit('change', { type: 'error' });
    });
  }

  ready() { return this._ready; }

  async _load() {
    const raw = await this.db.all('rounds');
    const list = [];
    let invalid = 0;
    for (const r of raw) {
      const v = validateRound(r);
      if (v && v.migratedFrom) recomputeRound(v); // Daten aus 0.6.0: Einheiten/Geld neu berechnen (gespeicherter Eintrag bleibt unverändert)
      if (v) list.push(v); else invalid += 1; // unlesbare Einträge bleiben unverändert in der Datenbank
    }
    this.invalid = invalid;
    this.rounds = list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    this.emit('change', { type: 'load' });
  }

  get(id) { return this.rounds.find((r) => r.id === id) || null; }

  async add(record) {
    await this._ready;
    const v = validateRound(record);
    if (!v) throw new ArchiveError('invalid', 'Die Runde konnte nicht gespeichert werden (ungültige Daten).');
    recomputeRound(v);
    await this.db.put('rounds', v);
    this.rounds = [v, ...this.rounds.filter((r) => r.id !== v.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    this.emit('change', { type: 'add', id: v.id });
    return v;
  }

  /**
   * Runde korrigieren. mutate(rec) verändert eine Kopie; Änderungen werden
   * protokolliert (corrections) und die Runde gilt danach als manuell bestätigt.
   */
  async update(id, mutate, note = 'Korrektur', changes = [], { keepConfirmation = false } = {}) {
    await this._ready;
    const cur = this.get(id);
    if (!cur) throw new ArchiveError('not-found', 'Runde nicht gefunden.');
    const copy = JSON.parse(JSON.stringify(cur));
    mutate(copy);
    if (!keepConfirmation) copy.confirmation = 'manual';
    copy.updatedAt = new Date().toISOString();
    // changes: [{ from: 'K', to: '7' }] – korrigierte Kartenwerte (YUMEKO lernt daraus)
    const ch = (Array.isArray(changes) ? changes : []).filter((c) => c && c.from && c.to).map((c) => ({ from: String(c.from), to: String(c.to) }));
    copy.corrections = [...(cur.corrections || []), { at: copy.updatedAt, note: String(note).slice(0, 200), ...(ch.length ? { changes: ch } : {}) }].slice(-50);
    const v = validateRound(copy);
    if (!v) throw new ArchiveError('invalid', 'Die Korrektur ist ungültig.');
    recomputeRound(v);
    await this.db.put('rounds', v);
    this.rounds = this.rounds.map((r) => (r.id === id ? v : r));
    this.emit('change', { type: 'update', id });
    return v;
  }

  /**
   * Geldbeträge einer Runde ergänzen (Einsatz, Zusatzeinsatz, Auszahlung je Hand;
   * Saldo vor/nach aus dem Echtgeld-Protokoll). Karten gelten dadurch NICHT als bestätigt.
   */
  async setMoney(id, { hands = [], money = undefined } = {}, note = 'Geldbeträge ergänzt') {
    return this.update(id, (r) => {
      hands.forEach((m, i) => {
        const h = r.hands[i];
        if (!h || !m) return;
        if ('bet' in m) h.bet = m.bet;
        if ('extraBet' in m) h.extraBet = m.extraBet;
        if ('payout' in m) { h.payout = m.payout; h.payoutSource = m.payout == null ? null : 'manual'; }
      });
      if (money !== undefined) r.money = money;
    }, note, [], { keepConfirmation: true });
  }

  async remove(id) {
    await this._ready;
    await this.db.delete('rounds', id);
    this.rounds = this.rounds.filter((r) => r.id !== id);
    this.emit('change', { type: 'remove', id });
  }

  /** Ganzes Archiv löschen – nur mit ausdrücklicher Bestätigung. */
  async clearAll({ confirmed = false } = {}) {
    if (!confirmed) throw new ArchiveError('confirm', 'Bitte das Löschen ausdrücklich bestätigen.');
    await this._ready;
    await this.db.clear('rounds');
    this.rounds = [];
    this.emit('change', { type: 'clear' });
  }

  /** Sicherung als JSON-Objekt (Archiv + optional YUMEKO-Daten). */
  async exportData(extra = {}) {
    await this._ready;
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      app: `BJ.AI ${APP_VERSION}`,
      exportedAt: new Date().toISOString(),
      rounds: this.rounds,
      ...extra
    };
  }

  /**
   * Sicherung einlesen. Vorhandene Runden (gleiche ID) werden NICHT überschrieben.
   * @returns {{ added, skipped, invalid }}
   */
  async importData(data) {
    await this._ready;
    if (!data || typeof data !== 'object' || data.format !== EXPORT_FORMAT) throw new ArchiveError('format', 'Keine BJ.AI-Sicherung (falsches Dateiformat).');
    if (typeof data.version !== 'number' || data.version > EXPORT_VERSION) throw new ArchiveError('version', 'Die Sicherung stammt aus einer neueren App-Version.');
    if (!Array.isArray(data.rounds)) throw new ArchiveError('format', 'Die Sicherung enthält keine Runden.');
    const have = new Set(this.rounds.map((r) => r.id));
    const add = [];
    let skipped = 0;
    let invalid = 0;
    for (const r of data.rounds) {
      const v = validateRound(r);
      if (!v) { invalid += 1; continue; }
      if (have.has(v.id)) { skipped += 1; continue; }
      have.add(v.id);
      recomputeRound(v);
      add.push(v);
    }
    if (add.length) await this.db.putMany('rounds', add);
    await this._load();
    this.emit('change', { type: 'import' });
    return { added: add.length, skipped, invalid };
  }
}
