// YUMEKOS Wissensspeicher (dauerhaft, lokal in IndexedDB).
// Getrennt werden: Beobachtungen (Spielerfahrungen, Videobeobachtungen),
// mathematisch geprüfte Erkenntnisse und unbestätigte Hypothesen.
// Jede Erkenntnis ist nachvollziehbar: Inhalt, Ursprung, Datum, Tischregeln,
// Vertrauensniveau, Prüfstatus und Verweise auf Archivrunden oder Videos.
import { Emitter } from '../core/events.js';
import { normalizeRules, parseKey, rowLabel, upLabel, standardCode, CODE_LABEL } from '../strategy/standard.js';

export const KNOWLEDGE_FORMAT = 'bjai-yumeko-knowledge';
export const HISTORY_MAX = 500;
// Lernstufen (0.7.0): beobachtet -> Hypothese -> mathematisch geprüft -> freigegebene Strategieänderung
export const STAGE = { observed: 'Beobachtete Daten', hypothesis: 'Unbestätigte Hypothese', verified: 'Mathematisch überprüft', released: 'Freigegebene Strategieänderung' };

/** Lernstufe eines Eintrags (für die Wissensbibliothek). */
export function stageOf(it) {
  if (it.category === 'version') return 'released';
  if (it.category === 'verified' || it.status === STATUS_VERIFIED) return 'verified';
  if (it.category === 'hypothesis' || it.category === 'rule' || it.status === 'unbestätigt' || it.status === 'widerspricht dem Rechenmodell') return 'hypothesis';
  return 'observed';
}
const STATUS_VERIFIED = 'mathematisch geprüft';

/** Spielsituation aus einem Tabellenschlüssel, z. B. "Hart 16 gegen 10". */
export function situationFromKey(key) {
  const k = parseKey(key);
  if (!k) return null;
  const up = k.up === 11 ? 'Ass' : upLabel(k.up);
  const row = k.kind === 'hard' ? `Hart ${k.value}` : (k.kind === 'soft' ? `Weich ${k.value} (${rowLabel(k.kind, k.value)})` : `Paar ${rowLabel(k.kind, k.value)}`);
  return `${row} gegen ${up}`;
}

/** Zwei Strategieversionen vergleichen (Zelle für Zelle). Reine Funktion. */
export function compareVersions(a, b) {
  const keys = new Set([...Object.keys(a.overrides || {}), ...Object.keys(b.overrides || {})]);
  const rows = [];
  for (const key of [...keys].sort()) {
    const k = parseKey(key);
    const std = k ? standardCode(k.kind, k.value, k.up, a.rules) : null;
    const ca = (a.overrides || {})[key] || std;
    const cb = (b.overrides || {})[key] || std;
    if (ca !== cb) rows.push({ key, situation: situationFromKey(key) || key, a: CODE_LABEL[ca] || ca, b: CODE_LABEL[cb] || cb });
  }
  const evA = a.verification ? a.verification.evVersion : null;
  const evB = b.verification ? b.verification.evVersion : null;
  return { rows, evA, evB, diff: evA != null && evB != null ? evB - evA : null };
}

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
    situation: typeof x.situation === 'string' && x.situation ? x.situation.slice(0, 120)
      : (x.data && x.data.cell && x.data.cell.key ? situationFromKey(x.data.cell.key) : null),
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
    this.history = [];
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
    try {
      this.history = (await this.db.all('history')).filter((h) => h && h.id && h.at).sort((a, b) => b.at.localeCompare(a.at));
    } catch { this.history = []; }
    this.emit('change', { type: 'load' });
  }

  /** Lernverlauf: nachvollziehbare Liste, was wann gelernt, geprüft, korrigiert oder gelöscht wurde. */
  async logHistory(type, text, ref = null) {
    if (!this.db) return null;
    const e = { id: `h_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: nowIso(), type: String(type).slice(0, 30), text: String(text).slice(0, 400), ref };
    try {
      await this.db.put('history', e);
      this.history = [e, ...this.history];
      for (const old of this.history.slice(HISTORY_MAX)) await this.db.delete('history', old.id);
      this.history = this.history.slice(0, HISTORY_MAX);
    } catch (err) { console.warn('[wissen] Verlauf nicht gespeichert', err); }
    return e;
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
    const v = await this.upsert(next);
    await this.logHistory('korrektur', `Korrigiert: ${v.content.slice(0, 160)}`, id);
    this.emit('change', { type: 'history' });
    return v;
  }

  /** Löschen. Automatisch erzeugte Einträge werden bei neuen Analysen nicht wieder angelegt. */
  async remove(id) {
    await this._ready;
    const cur = this.get(id);
    await this.db.delete('knowledge', id);
    this.items = this.items.filter((i) => i.id !== id);
    if (cur && cur.auto && !this.meta.dismissed.includes(id)) await this.saveMeta({ dismissed: [...this.meta.dismissed, id].slice(-2000) });
    if (cur) await this.logHistory('löschung', `Gelöscht: ${cur.content.slice(0, 160)}`, id);
    this.emit('change', { type: 'remove', id });
  }

  /**
   * Löschen ohne Sperre für neue Analysen (0.8.0, Yumeko Academy): wird genutzt, wenn die
   * Quelle selbst gelöscht wird – kommt das Video später wieder dazu, darf das Wissen neu entstehen.
   */
  async removeQuiet(id) {
    await this._ready;
    if (!this.get(id)) return;
    await this.db.delete('knowledge', id);
    this.items = this.items.filter((i) => i.id !== id);
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
    await this.logHistory('video', `Video-Lernsequenz übernommen: ${seq.source} (${(seq.scenes || []).length} Szenen)`, seq.id);
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
    const prev = this.versions.find((x) => x.id === v.id);
    await this.db.put('versions', v);
    if (!prev || prev.status !== v.status) await this.logHistory('version', `Strategieversion ${v.number}: ${v.status}`, v.id);
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
    return { format: KNOWLEDGE_FORMAT, knowledge: this.items, videos: this.videos, versions: this.versions, meta: this.meta, history: this.history };
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
    const haveH = new Set(this.history.map((h) => h.id));
    for (const h of Array.isArray(data && data.history) ? data.history : []) {
      if (h && typeof h.id === 'string' && typeof h.at === 'string' && !haveH.has(h.id)) await this.db.put('history', { id: h.id, at: h.at, type: String(h.type || '').slice(0, 30), text: String(h.text || '').slice(0, 400), ref: h.ref ?? null });
    }
    await this._load();
    if (added) await this.logHistory('import', `${added} Einträge importiert`);
    return added;
  }
}
