// Lokale Datenbank für grössere Datenmengen (Spielarchiv, YUMEKO-Wissen).
// Bevorzugt IndexedDB. Ist IndexedDB nicht verfügbar (z. B. privates Fenster),
// wird auf localStorage ausgewichen – mit Hinweis, dass dort weniger Platz ist.
// Alle Daten bleiben auf dem Gerät.
import { load, save } from './store.js';

export const DB_NAME = 'bjassist';
// Version 2 (0.7.0): neue Bereiche für Simulationen (getrennt von echten Runden),
// Echtgeld-Protokoll und Lernverlauf. Vorhandene Bereiche bleiben unverändert.
// Version 3 (0.8.0, Yumeko Academy): neue Bereiche "sources" (Lernquellen, z. B. YouTube-Videos
// mit Analysestatus), "claims" (erkannte Strategie-Aussagen mit Prüfergebnis) und
// "feedback" (gemeldete Fehlerkennungen der Kamera). Vorhandene Bereiche bleiben unverändert.
export const DB_VERSION = 3;
export const STORES = ['rounds', 'knowledge', 'videos', 'versions', 'meta', 'simulations', 'ledger', 'history', 'sources', 'claims', 'feedback'];
// Datenbank-Versionen und was beim Wechsel passiert (für die Dokumentation und Tests).
export const MIGRATIONS = [
  { version: 1, stores: ['rounds', 'knowledge', 'videos', 'versions', 'meta'], note: '0.6.0: Spielarchiv und YUMEKO-Wissen' },
  { version: 2, stores: ['simulations', 'ledger', 'history'], note: '0.7.0: Simulationen, Echtgeld-Protokoll, Lernverlauf' },
  { version: 3, stores: ['sources', 'claims', 'feedback'], note: '0.8.0: Yumeko Academy (Lernquellen, Strategie-Aussagen, Erkennungsmeldungen)' }
];

/** Speicher voll? (IndexedDB: QuotaExceededError, localStorage-Ausweichlösung: eigene Meldung) */
export function isQuotaError(err) {
  if (!err) return false;
  const name = err.name || (err.inner && err.inner.name) || '';
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 'quota' || /Speicher voll|quota/i.test(err.message || '');
}

/** Freier Speicher laut Browser (nur Schätzung des Browsers; null, wenn nicht verfügbar). */
export async function storageEstimate(nav = globalThis.navigator) {
  try {
    if (nav && nav.storage && nav.storage.estimate) {
      const e = await nav.storage.estimate();
      if (Number.isFinite(e.usage) && Number.isFinite(e.quota)) return { usage: e.usage, quota: e.quota };
    }
  } catch { /* nicht verfügbar */ }
  return null;
}

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

class IdbDatabase {
  constructor(db) {
    this.db = db;
    this.kind = 'indexeddb';
  }

  _tx(store, mode = 'readonly') {
    return this.db.transaction(store, mode).objectStore(store);
  }

  all(store) { return reqP(this._tx(store).getAll()); }
  get(store, id) { return reqP(this._tx(store).get(id)).then((x) => x ?? null); }
  delete(store, id) { return reqP(this._tx(store, 'readwrite').delete(id)); }
  clear(store) { return reqP(this._tx(store, 'readwrite').clear()); }
  // 0.8.0: wartet auf das Ende der Transaktion, damit "Speicher voll" (QuotaExceededError,
  // tritt erst beim Abschluss auf) als Fehler ankommt statt still verloren zu gehen.
  put(store, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Speichern abgebrochen.'));
    });
  }

  putMany(store, values) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const v of values) os.put(v);
      tx.oncomplete = () => resolve(values.length);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Speichern abgebrochen.'));
    });
  }
}

/** Gleiche Schnittstelle im Arbeitsspeicher (Tests) bzw. mit localStorage (Ausweichlösung). */
export class MemoryDatabase {
  constructor({ persist = null } = {}) {
    this.kind = persist ? 'local' : 'memory';
    this.persist = persist; // { load(key), save(key, value) }
    this.data = new Map(STORES.map((s) => [s, new Map()]));
    if (persist) {
      for (const s of STORES) {
        const list = persist.load(`db.${s}`, []);
        if (Array.isArray(list)) for (const v of list) if (v && v.id) this.data.get(s).set(v.id, v);
      }
    }
  }

  _save(store) {
    if (!this.persist) return;
    if (!this.persist.save(`db.${store}`, [...this.data.get(store).values()])) {
      const err = new Error('Speicher voll: Daten konnten nicht gespeichert werden. Bitte das Archiv exportieren.');
      err.code = 'quota';
      throw err;
    }
  }

  async all(store) { return [...this.data.get(store).values()].map(clone); }
  async get(store, id) { const v = this.data.get(store).get(id); return v ? clone(v) : null; }
  async put(store, value) { this.data.get(store).set(value.id, clone(value)); this._save(store); return value; }
  async putMany(store, values) { for (const v of values) this.data.get(store).set(v.id, clone(v)); this._save(store); return values.length; }
  async delete(store, id) { this.data.get(store).delete(id); this._save(store); }
  async clear(store) { this.data.get(store).clear(); this._save(store); }
}

function clone(v) {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

/** Datenbank öffnen. Ohne IndexedDB: localStorage-Ausweichlösung. */
export async function openDatabase({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  if (!indexedDB) return new MemoryDatabase({ persist: { load, save } });
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        // Nur fehlende Bereiche anlegen – vorhandene Daten bleiben bei Updates erhalten.
        for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Datenbank ist in einem anderen Fenster geöffnet.'));
    });
    return new IdbDatabase(db);
  } catch (err) {
    console.warn('[db] IndexedDB nicht verfügbar – Ausweichlösung localStorage', err);
    return new MemoryDatabase({ persist: { load, save } });
  }
}

let shared = null;
/** Eine gemeinsame Datenbank für die ganze App. */
export function sharedDatabase() {
  if (!shared) shared = openDatabase();
  return shared;
}
