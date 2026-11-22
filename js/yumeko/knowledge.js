// YUMEKOS Wissensspeicher (dauerhaft, lokal in IndexedDB).
// Getrennt werden: Beobachtungen (Spielerfahrungen, Videobeobachtungen),
// mathematisch geprüfte Erkenntnisse und unbestätigte Hypothesen.
// Jede Erkenntnis ist nachvollziehbar: Inhalt, Ursprung, Datum, Tischregeln,
// Vertrauensniveau, Prüfstatus und Verweise auf Archivrunden oder Videos.
import { Emitter } from '../core/events.js';
import { normalizeRules } from '../strategy/standard.js';

export const CATEGORIES = {
  experience: 'Spielerfahrungen',
  video: 'Videobeobachtungen',
  rule: 'Strategieregeln',
  verified: 'Mathematisch geprüfte Erkenntnisse',
  hypothesis: 'Unbestätigte Hypothesen',
  source: 'Quellen und Lernmaterial',
  version: 'Strategieversionen'
};

export const STATUS = {
  observed: 'beobachtet',
  unconfirmed: 'unbestätigt',
  verified: 'mathematisch geprüft',
  contradicted: 'widerspricht dem Rechenmodell',
  userConfirmed: 'vom Benutzer bestätigt',
  rejected: 'verworfen'
};

export const CONFIDENCE = ['niedrig', 'mittel', 'hoch'];

const nowIso = () => new Date().toISOString();

/** Erkenntnis prüfen und bereinigen. */
export function validateItem(x) {
  if (!x || typeof x !== 'object') return null;
  if (typeof x.id !== 'string' || !x.id || x.id.length > 120) return null;
  if (!Object.prototype.hasOwnProperty.call(CATEGORIES, x.category)) return null;
  const content = String(x.content ?? '').trim().slice(0, 2000);
  if (!content) return null;
  const at = typeof x.createdAt === 'string' && !Number.isNaN(Date.parse(x.createdAt)) ? x.createdAt : nowIso();
  return {
    id: x.id,
    category: x.category,
    content,
    origin: {
      type: ['archive', 'video', 'analysis', 'math', 'user', 'source'].includes(x.origin && x.origin.type) ? x.origin.type : 'user',
      detail: String((x.origin && x.origin.detail) || '').slice(0, 300)
    },
    createdAt: at,
    updatedAt: typeof x.updatedAt === 'string' ? x.updatedAt : at,
    rules: x.rules ? normalizeRules(x.rules) : null,
    confidence: {
      level: CONFIDENCE.includes(x.confidence && x.confidence.level) ? x.confidence.level : 'niedrig',
      n: Number.isFinite(x.confidence && x.confidence.n) ? x.confidence.n : null,
      basis: String((x.confidence && x.confidence.basis) || '').slice(0, 300)
    },
    status: Object.values(STATUS).includes(x.status) ? x.status : STATUS.unconfirmed,
    refs: {
      rounds: Array.isArray(x.refs && x.refs.rounds) ? x.refs.rounds.filter((s) => typeof s === 'string').slice(0, 200) : [],
      videos: Array.isArray(x.refs && x.refs.videos) ? x.refs.videos.filter((s) => typeof s === 'string').slice(0, 50) : []
    },
    data: x.data && typeof x.data === 'object' ? x.data : {},
    auto: !!x.auto,          // von YUMEKO erzeugt (wird bei neuer Analyse aktualisiert)
    edited: !!x.edited       // vom Benutzer korrigiert (wird nicht mehr automatisch überschrieben)
  };
}

export class KnowledgeStore extends Emitter {
  constructor({ db }) {
    super();
    this.items = [];
    this.videos = [];
    this.versions = [];
    this.meta = {};
    this.error = null;
    this._ready = Promise.resolve(db).then(async (d) => {
      this.db = d;
      await this._load();
    }).catch((err) => {
      this.error = `Wissensspeicher konnte nicht geöffnet werden: ${err.message}`;
      this.emit('change', { type: 'error' });
    });
  }

  ready() { return this._ready; }

  async _load() {
    this.items = (await this.db.all('knowledge')).map(validateItem).filter(Boolean)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.videos = (await this.db.all('videos')).filter((v) => v && v.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    this.versions = (await this.db.all('versions')).filter((v) => v && v.id && Number.isInteger(v.number)).sort((a, b) => b.number - a.number);
    const meta = await this.db.get('meta', 'yumeko');
    this.meta = meta || { id: 'yumeko', dismissed: [] };
    if (!Array.isArray(this.meta.dismissed)) this.meta.dismissed = [];
    this.emit('change', { type: 'load' });
  }

  byCategory(cat) { return this.items.filter((i) => i.category === cat); }
  get(id) { return this.items.find((i) => i.id === id) || null; }

  async saveMeta(patch) {
    await this._ready;
    this.meta = { ...this.meta, ...patch, id: 'yumeko' };
    await this.db.put('meta', this.meta);
    this.emit('change', { type: 'meta' });
  }

  /** Erkenntnis anlegen oder ersetzen. Vom Benutzer korrigierte/gelöschte bleiben unangetastet. */
  async upsert(item, { fromAnalysis = false } = {}) {
    await this._ready;
    const v = validateItem({ ...item, updatedAt: nowIso() });
    if (!v) throw new Error('Ungültige Erkenntnis.');
    if (fromAnalysis) {
      if (this.meta.dismissed.includes(v.id)) return null;      // vom Benutzer gelöscht
      const cur = this.get(v.id);
      if (cur && cur.edited) return cur;                          // vom Benutzer korrigiert
      if (cur) v.createdAt = cur.createdAt;
    }
    await this.db.put('knowledge', v);
    this.items = [v, ...this.items.filter((i) => i.id !== v.id)];
    this.emit('change', { type: 'upsert', id: v.id });
    return v;
  }

  async upsertMany(items, opts) {
    const out = [];
    for (const it of items) out.push(await this.upsert(it, opts));
    return out.filter(Boolean);
  }

  /** Benutzerkorrektur (Inhalt, Status, Vertrauen). */
  async correct(id, patch) {
    const cur = this.get(id);
    if (!cur) throw new Error('Erkenntnis nicht gefunden.');
    const next = { ...cur, ...patch, confidence: { ...cur.confidence, ...(patch.confidence || {}) }, edited: true };
    return this.upsert(next);
  }

  /** Löschen. Automatisch erzeugte Einträge werden bei neuen Analysen nicht wieder angelegt. */
  async remove(id) {
    await this._ready;
    const cur = this.get(id);
    await this.db.delete('knowledge', id);
    this.items = this.items.filter((i) => i.id !== id);
    if (cur && cur.auto && !this.meta.dismissed.includes(id)) await this.saveMeta({ dismissed: [...this.meta.dismissed, id].slice(-2000) });
    this.emit('change', { type: 'remove', id });
  }

  /** Veraltete automatische Einträge entfernen (z. B. nach neuer Analyse). */
  async pruneAuto(prefix, keepIds) {
    const stale = this.items.filter((i) => i.auto && !i.edited && i.id.startsWith(prefix) && !keepIds.has(i.id));
    for (const s of stale) { await this.db.delete('knowledge', s.id); }
    if (stale.length) {
      const gone = new Set(stale.map((s) => s.id));
      this.items = this.items.filter((i) => !gone.has(i.id));
      this.emit('change', { type: 'prune' });
    }
    return stale.length;
  }

  // --- Video-Lernsequenzen ------------------------------------------------
  async addVideo(seq) {
    await this._ready;
    await this.db.put('videos', seq);
    this.videos = [seq, ...this.videos.filter((v) => v.id !== seq.id)];
    this.emit('change', { type: 'video', id: seq.id });
    return seq;
  }

  async removeVideo(id) {
    await this._ready;
    await this.db.delete('videos', id);
    this.videos = this.videos.filter((v) => v.id !== id);
    // Zugehörige Erkenntnisse ebenfalls entfernen (keine verwaisten Lerninformationen).
    for (const it of this.items.filter((i) => i.refs.videos.includes(id))) await this.remove(it.id);
    this.emit('change', { type: 'video-remove', id });
  }

  // --- Strategieversionen ---------------------------------------------------
  async putVersion(v) {
    await this._ready;
    await this.db.put('versions', v);
    this.versions = [v, ...this.versions.filter((x) => x.id !== v.id)].sort((a, b) => b.number - a.number);
    this.emit('change', { type: 'version', id: v.id });
    return v;
  }

  async removeVersion(id) {
    await this._ready;
    await this.db.delete('versions', id);
    this.versions = this.versions.filter((x) => x.id !== id);
    this.emit('change', { type: 'version-remove', id });
  }

  /** Alles für die Sicherung. */
  exportData() {
    return { knowledge: this.items, videos: this.videos, versions: this.versions, meta: this.meta };
  }

  /** Sicherung einlesen (vorhandene IDs bleiben unverändert). */
  async importData(data) {
    await this._ready;
    let added = 0;
    const haveK = new Set(this.items.map((i) => i.id));
    for (const it of Array.isArray(data && data.knowledge) ? data.knowledge : []) {
      const v = validateItem(it);
      if (v && !haveK.has(v.id)) { await this.db.put('knowledge', v); added += 1; }
    }
    const haveV = new Set(this.videos.map((i) => i.id));
    for (const s of Array.isArray(data && data.videos) ? data.videos : []) {
      if (s && typeof s.id === 'string' && !haveV.has(s.id) && Array.isArray(s.scenes)) { await this.db.put('videos', s); added += 1; }
    }
    const haveS = new Set(this.versions.map((i) => i.id));
    for (const s of Array.isArray(data && data.versions) ? data.versions : []) {
      if (s && typeof s.id === 'string' && Number.isInteger(s.number) && !haveS.has(s.id) && !this.versions.some((x) => x.number === s.number)) { await this.db.put('versions', s); added += 1; }
    }
    await this._load();
    return added;
  }
}
