// Früheres KI-Gedächtnis (YUMEKO AI und Yumeko Academy, App 0.6.0–0.8.0).
//
// Ab 0.9.0 sind die alte YUMEKO-KI, ihr Lernzentrum, die Lernalgorithmen und die
// Academy entfernt. Ihre gespeicherten Daten werden dabei NICHT automatisch gelöscht:
// Dieses Modul liest sie nur, erstellt eine vollständige Sicherung (JSON, Rohdaten
// unverändert) und löscht sie erst, wenn
//   1. eine Sicherung des aktuellen Stands heruntergeladen wurde und
//   2. das Löschen ausdrücklich bestätigt wird.
// Gemeinsam genutzte Daten (Spielarchiv "rounds", Simulationen, Echtgeld-Protokoll
// "ledger", Echtgeld-Einstellungen meta "bankroll", Profile, Einstellungen,
// Kalibrierung, angelernte Karten) werden nie angefasst.
// Reine Logik (ohne DOM) -> testbar.
import { Emitter } from './events.js';
import { load, save, remove } from './store.js';
import { APP_VERSION } from './version.js';

export const LEGACY_FORMAT = 'bjai-ki-gedaechtnis-sicherung';
export const LEGACY_VERSION = 1;
// IndexedDB-Bereiche, die ausschliesslich der alten KI gehörten.
export const LEGACY_STORES = ['knowledge', 'videos', 'versions', 'history', 'sources', 'claims', 'feedback'];
// Einträge im gemeinsamen Bereich "meta", die der alten KI gehörten (bankroll bleibt!).
export const LEGACY_META_IDS = ['yumeko'];
// localStorage-Schlüssel (ohne Präfix "bjassist.") der alten KI.
export const LEGACY_LOCAL_KEYS = ['yumekoChat', 'academy.server', 'legacy.yumekoProfile'];
// Hier wird vermerkt, welcher Stand zuletzt gesichert wurde (bleibt auch nach dem Löschen).
export const BACKUP_MARK_KEY = 'legacy.aiBackup';

export const STORE_LABEL = {
  knowledge: 'Wissenseinträge',
  videos: 'Video-Lernsequenzen',
  versions: 'Strategieversionen',
  history: 'Lernverlauf',
  sources: 'Academy-Videos',
  claims: 'Academy-Aussagen',
  feedback: 'Gemeldete Erkennungsfehler'
};

/** Kurzer, stabiler Fingerabdruck eines Datenstands (nur zum Vergleich, keine Sicherheit). */
export function fingerprint(snapshot) {
  const str = JSON.stringify([snapshot.indexedDB, snapshot.localStorage]);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${str.length.toString(36)}-${h.toString(36)}`;
}

export class LegacyAiMemory extends Emitter {
  /**
   * @param {{ db: Promise<Database>|Database, storage?: { load, save, remove } }} opts
   */
  constructor({ db, storage = { load, save, remove } }) {
    super();
    this.storage = storage;
    this.error = null;
    this.summary = null; // { counts: {store: n}, meta: n, local: n, total }
    this._ready = Promise.resolve(db).then((d) => { this.db = d; return this.refresh(); }).catch((err) => {
      this.error = `Altes KI-Gedächtnis nicht lesbar: ${err.message}`;
      this.emit('change');
    });
  }

  ready() { return this._ready; }

  /** Alle Daten der alten KI, unverändert (Rohdaten). */
  async snapshot() {
    const indexedDB = {};
    for (const s of LEGACY_STORES) {
      try { indexedDB[s] = await this.db.all(s); } catch { indexedDB[s] = []; }
    }
    const meta = [];
    for (const id of LEGACY_META_IDS) {
      try { const m = await this.db.get('meta', id); if (m) meta.push(m); } catch { /* fehlt */ }
    }
    indexedDB.meta = meta;
    const localStorage = {};
    for (const k of LEGACY_LOCAL_KEYS) {
      const v = this.storage.load(k, null);
      if (v != null) localStorage[k] = v;
    }
    return { indexedDB, localStorage };
  }

  async refresh() {
    const snap = await this.snapshot();
    const counts = {};
    for (const s of LEGACY_STORES) counts[s] = snap.indexedDB[s].length;
    const metaN = snap.indexedDB.meta.length;
    const localN = Object.keys(snap.localStorage).length;
    const total = Object.values(counts).reduce((a, b) => a + b, 0) + metaN + localN;
    this.summary = { counts, meta: metaN, local: localN, total, fingerprint: fingerprint(snap) };
    this.emit('change');
    return this.summary;
  }

  get empty() { return !this.summary || this.summary.total === 0; }

  /** Zuletzt gesicherter Stand: { at, fingerprint, total } oder null. */
  get lastBackup() {
    const m = this.storage.load(BACKUP_MARK_KEY, null);
    return m && typeof m === 'object' && typeof m.fingerprint === 'string' ? m : null;
  }

  /** Wurde genau der aktuelle Stand gesichert? Erst dann ist Löschen erlaubt. */
  get backedUp() {
    const b = this.lastBackup;
    return !!(b && this.summary && b.fingerprint === this.summary.fingerprint);
  }

  /** Vollständige Sicherung als JSON-Objekt. */
  async exportData({ now = new Date() } = {}) {
    await this._ready;
    const snap = await this.snapshot();
    return {
      format: LEGACY_FORMAT,
      version: LEGACY_VERSION,
      app: `BJ.AI ${APP_VERSION}`,
      exportedAt: now.toISOString(),
      note: 'Sicherung des früheren KI-Gedächtnisses (YUMEKO AI und Yumeko Academy, App 0.6.0–0.8.0). Rohdaten unverändert.',
      fingerprint: fingerprint(snap),
      ...snap
    };
  }

  /** Nach dem Herunterladen aufrufen: merkt sich den gesicherten Stand. */
  markExported(data) {
    if (!data || data.format !== LEGACY_FORMAT || typeof data.fingerprint !== 'string') throw new Error('Ungültige Sicherung.');
    const total = LEGACY_STORES.reduce((a, s) => a + (data.indexedDB[s] || []).length, 0) + (data.indexedDB.meta || []).length + Object.keys(data.localStorage || {}).length;
    if (!this.storage.save(BACKUP_MARK_KEY, { at: data.exportedAt, fingerprint: data.fingerprint, total })) {
      throw new Error('Der Sicherungsvermerk konnte nicht gespeichert werden (lokaler Speicher voll?).');
    }
    this.emit('change');
  }

  /**
   * Altes KI-Gedächtnis löschen. Nur möglich, wenn genau dieser Stand gesichert wurde
   * und confirmed = true. Gemeinsame Daten bleiben unberührt.
   */
  async clear({ confirmed = false } = {}) {
    await this._ready;
    if (!confirmed) throw new Error('Löschen muss ausdrücklich bestätigt werden.');
    await this.refresh();
    if (!this.backedUp) throw new Error('Bitte zuerst eine Sicherung des aktuellen Stands herunterladen.');
    for (const s of LEGACY_STORES) await this.db.clear(s);
    for (const id of LEGACY_META_IDS) await this.db.delete('meta', id);
    for (const k of LEGACY_LOCAL_KEYS) this.storage.remove(k);
    const b = this.lastBackup;
    this.storage.save(BACKUP_MARK_KEY, { ...b, clearedAt: new Date().toISOString() });
    return this.refresh();
  }
}
