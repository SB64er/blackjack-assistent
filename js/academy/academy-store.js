// Yumeko Academy – lokale Wissensdatenbank und YouTube-Lernablauf (Phase 8.1/8.2).
//
// Gespeichert in IndexedDB (Bereiche "sources", "claims", "feedback"; ab DB-Version 3).
// Alles bleibt auf dem Gerät. Keine automatische Cloud-Synchronisierung.
//
// Lernkontrolle (verbindliche Benutzerentscheidung):
//  - Aussagen aus Videos werden erst nach der mathematischen Prüfung als Wissen geführt.
//  - Ungeprüfte, widerlegte oder nur teilweise bestätigte Aussagen verändern die
//    Strategie NIE. Bestätigte Einzelaussagen werden höchstens als "mathematisch geprüft"
//    in YUMEKOS Wissensspeicher gespiegelt und können dann nur über eine neue
//    Strategieversion (Entwurf → Prüfung → ausdrückliche Bestätigung) übernommen werden.
import { Emitter } from '../core/events.js';
import { isQuotaError } from '../core/idb.js';
import { APP_VERSION } from '../core/version.js';
import { rulesText, cellKey } from '../strategy/standard.js';
import { parseYouTubeUrl, VIDEO_ID_RE } from './youtube.js';
import { extractClaims, claimKey, claimText, TOPICS } from './extract.js';
import { verifyClaim, VERDICT } from './verify.js';
import { fetchVideoData, loadServerConfig, ServerError } from './server-client.js';

export const ACADEMY_FORMAT = 'bjai-academy';
export const ACADEMY_VERSION = 1;
export const MAX_SOURCES = 300;

// Analysestatus eines Videos (sichtbar in der Academy). Es gibt keine Prozentwerte –
// angezeigt wird, welcher Schritt tatsächlich erledigt ist.
export const VIDEO_STATUS = {
  waiting: 'Wartet',
  running: 'Analyse läuft',
  transcript: 'Transkript verfügbar',
  frames: 'Videobildanalyse verfügbar',
  strategies: 'Strategien erkannt',
  verifying: 'Mathematische Prüfung läuft',
  verified: 'Erfolgreich geprüft',
  partial: 'Teilweise geprüft',
  unverifiable: 'Nicht überprüfbar',
  error: 'Fehler'
};
export const STEP_ORDER = ['link', 'meta', 'transcript', 'frames', 'extract', 'verify', 'save'];
export const STEP_TEXT = {
  link: 'Link prüfen und Video-ID ermitteln',
  meta: 'Videoinformationen abrufen',
  transcript: 'Untertitel / Transkript verarbeiten',
  frames: 'Videobilder analysieren',
  extract: 'Regeln und Strategien erkennen',
  verify: 'Aussagen mathematisch prüfen',
  save: 'Ergebnisse lokal speichern'
};
export const CLAIM_STATUS = {
  unchecked: 'ungeprüft',
  confirmed: 'bestätigt',
  contradicted: 'widerlegt',
  partial: 'teilweise bestätigt',
  unverifiable: 'nicht überprüfbar'
};

export class AcademyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const nowIso = () => new Date().toISOString();
const ACTION_CODE = { HIT: 'H', STAND: 'S', DOUBLE: 'D', SPLIT: 'P' };

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
export const claimIdFor = (key) => `c_${hash(key)}_${key.length.toString(36)}`;

function emptySteps() {
  const s = {};
  for (const k of STEP_ORDER) s[k] = { state: 'wait', note: '', at: null };
  return s;
}

// --- Prüfen/Bereinigen (Laden, Import) -----------------------------------------

export function validateSource(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !/^[A-Za-z0-9_:-]{1,80}$/.test(x.id)) return null;
  if (x.kind !== 'youtube' || !VIDEO_ID_RE.test(x.videoId || '')) return null;
  const iso = (v, fb) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fb);
  const addedAt = iso(x.addedAt, nowIso());
  const steps = emptySteps();
  if (x.steps && typeof x.steps === 'object') {
    for (const k of STEP_ORDER) {
      const s = x.steps[k];
      if (s && ['wait', 'run', 'ok', 'fail', 'skip'].includes(s.state)) steps[k] = { state: s.state, note: String(s.note || '').slice(0, 300), at: iso(s.at, null) };
    }
  }
  const t = x.transcript && typeof x.transcript === 'object' ? x.transcript : {};
  const segments = Array.isArray(t.segments) ? t.segments.filter((s) => s && typeof s.text === 'string').slice(0, 20000).map((s) => ({ start: Number.isFinite(s.start) ? s.start : null, text: s.text.slice(0, 2000) })) : [];
  return {
    id: x.id,
    kind: 'youtube',
    videoId: x.videoId,
    url: `https://www.youtube.com/watch?v=${x.videoId}`,
    title: typeof x.title === 'string' ? x.title.slice(0, 300) : null,
    channel: typeof x.channel === 'string' ? x.channel.slice(0, 200) : null,
    durationSec: Number.isFinite(x.durationSec) ? x.durationSec : null,
    addedAt,
    updatedAt: iso(x.updatedAt, addedAt),
    status: Object.prototype.hasOwnProperty.call(VIDEO_STATUS, x.status) ? x.status : 'waiting',
    steps,
    transcript: segments.length
      ? { available: true, source: t.source === 'manual' ? 'manual' : 'server', language: typeof t.language === 'string' ? t.language.slice(0, 20) : null, chars: segments.reduce((a, s) => a + s.text.length, 0), segments }
      : { available: false, source: null, reason: typeof t.reason === 'string' ? t.reason.slice(0, 300) : null },
    frames: x.frames && x.frames.available === true ? { available: true, count: Number(x.frames.count) || 0 } : { available: false, reason: x.frames && typeof x.frames.reason === 'string' ? x.frames.reason.slice(0, 300) : null },
    topics: Array.isArray(x.topics) ? x.topics.filter((t2) => Object.prototype.hasOwnProperty.call(TOPICS, t2)) : [],
    claimIds: Array.isArray(x.claimIds) ? x.claimIds.filter((c) => typeof c === 'string').slice(0, 500) : [],
    counts: x.counts && typeof x.counts === 'object' ? x.counts : null,
    error: typeof x.error === 'string' ? x.error.slice(0, 300) : null,
    lastCheckedAt: iso(x.lastCheckedAt, null),
    runs: Number.isInteger(x.runs) ? x.runs : 0
  };
}

const CLAIM_TYPES = ['play', 'rule', 'insurance', 'probability', 'houseEdge'];

export function validateClaim(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || typeof x.key !== 'string' || !CLAIM_TYPES.includes(x.type)) return null;
  const d = x.data && typeof x.data === 'object' ? x.data : {};
  if (x.type === 'play') {
    if (!Array.isArray(d.cells) || !d.cells.length || !['HIT', 'STAND', 'DOUBLE', 'SPLIT', 'SURRENDER'].includes(d.action)) return null;
    if (!d.cells.every((c) => c && ['hard', 'soft', 'pair'].includes(c.kind) && Number.isInteger(c.value) && Number.isInteger(c.up))) return null;
  }
  const iso = (v, fb) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fb);
  const v = x.verification && typeof x.verification === 'object' && VERDICT[x.verification.verdict] ? x.verification : null;
  return {
    id: x.id,
    key: x.key.slice(0, 2000),
    type: x.type,
    data: d,
    text: typeof x.text === 'string' ? x.text.slice(0, 400) : claimText({ type: x.type, ...d }),
    sources: Array.isArray(x.sources) ? x.sources.filter((s) => s && typeof s.sourceId === 'string').slice(0, 100).map((s) => ({
      sourceId: s.sourceId, videoId: VIDEO_ID_RE.test(s.videoId || '') ? s.videoId : null, excerpt: String(s.excerpt || '').slice(0, 300), at: Number.isFinite(s.at) ? s.at : null
    })) : [],
    firstSeen: iso(x.firstSeen, nowIso()),
    updatedAt: iso(x.updatedAt, iso(x.firstSeen, nowIso())),
    verification: v,
    status: v ? statusFromVerdict(v.verdict) : 'unchecked',
    flagged: !!x.flagged || (v && v.verdict === 'contradicted'),
    userNote: typeof x.userNote === 'string' ? x.userNote.slice(0, 500) : ''
  };
}

export function statusFromVerdict(verdict) {
  return { confirmed: 'confirmed', contradicted: 'contradicted', partial: 'partial', unverifiable: 'unverifiable' }[verdict] || 'unchecked';
}

export function validateFeedback(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || typeof x.at !== 'string' || Number.isNaN(Date.parse(x.at))) return null;
  const cards = (list) => (Array.isArray(list) ? list : []).filter((c) => c && typeof c.rank === 'string').slice(0, 12).map((c) => ({ rank: c.rank.slice(0, 2), score: Number.isFinite(c.score) ? c.score : null }));
  return {
    id: x.id,
    at: x.at,
    kind: ['wrong-card', 'missed-card', 'other'].includes(x.kind) ? x.kind : 'other',
    roundId: typeof x.roundId === 'string' ? x.roundId.slice(0, 80) : null,
    dealer: cards(x.dealer),
    hands: (Array.isArray(x.hands) ? x.hands : []).slice(0, 4).map(cards),
    uncertain: !!x.uncertain,
    note: typeof x.note === 'string' ? x.note.slice(0, 300) : ''
  };
}

// --- Widersprüche ---------------------------------------------------------------

/**
 * Widersprüchliche Aussagen finden: gleiche Spielsituation, unvereinbare Aktionen
 * (z. B. "16 gegen 10 stehen" und "16 gegen 10 ziehen") oder gleiche Tischregel mit
 * verschiedenen Werten aus verschiedenen Quellen.
 * @returns {{ byClaim: Map<id, Set<id>>, list: Array<{ situation, claims: string[] }> }}
 */
export function findConflicts(claims) {
  const byCell = new Map();
  const byRule = new Map();
  for (const c of claims) {
    if (c.type === 'play') {
      for (const cell of c.data.cells) {
        const k = cellKey(cell.kind, cell.value, cell.up);
        if (!byCell.has(k)) byCell.set(k, []);
        byCell.get(k).push(c);
      }
    } else if (c.type === 'rule' && c.data.rule !== 'decks') {
      if (!byRule.has(c.data.rule)) byRule.set(c.data.rule, []);
      byRule.get(c.data.rule).push(c);
    }
  }
  const byClaim = new Map();
  const list = [];
  const mark = (a, b) => {
    if (!byClaim.has(a.id)) byClaim.set(a.id, new Set());
    if (!byClaim.has(b.id)) byClaim.set(b.id, new Set());
    byClaim.get(a.id).add(b.id);
    byClaim.get(b.id).add(a.id);
  };
  const seenPairs = new Set();
  for (const [k, cs] of byCell) {
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i].data; const b = cs[j].data;
        const clash = (!a.negated && !b.negated && a.action !== b.action) || (a.negated !== b.negated && a.action === b.action);
        if (!clash) continue;
        mark(cs[i], cs[j]);
        const pk = [cs[i].id, cs[j].id].sort().join('|');
        if (!seenPairs.has(pk)) { seenPairs.add(pk); list.push({ situation: k, claims: [cs[i].id, cs[j].id] }); }
      }
    }
  }
  for (const [rule, cs] of byRule) {
    const values = new Set(cs.map((c) => String(c.data.value)));
    if (values.size > 1) {
      for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) if (String(cs[i].data.value) !== String(cs[j].data.value)) mark(cs[i], cs[j]);
      list.push({ situation: `Regel ${rule}`, claims: cs.map((c) => c.id) });
    }
  }
  return { byClaim, list };
}

/** Gesamtstatus eines Videos aus den Prüfergebnissen seiner Aussagen. */
export function videoStatusFor(claims) {
  if (!claims.length) return 'unverifiable';
  const vs = claims.map((c) => (c.verification ? c.verification.verdict : null));
  if (vs.some((v) => v == null || v === 'partial')) return 'partial';
  // Tischregeln aus dem Video sind Informationen, keine prüfbaren Strategien.
  const checkable = vs.filter((v) => v !== 'unverifiable');
  if (!checkable.length) return 'unverifiable';
  const otherUnverifiable = claims.some((c) => c.verification && c.verification.verdict === 'unverifiable' && c.type !== 'rule');
  return otherUnverifiable ? 'partial' : 'verified';
}

/** Lernstatistik – ausschliesslich aus gespeicherten Daten berechnet. */
export function academyStats({ sources = [], claims = [], feedback = [] } = {}) {
  const s = {
    videos: sources.length,
    analyzed: sources.filter((x) => ['verified', 'partial', 'unverifiable'].includes(x.status) && x.runs > 0).length,
    failed: sources.filter((x) => x.status === 'error').length,
    noTranscript: sources.filter((x) => x.runs > 0 && !x.transcript.available).length,
    claims: claims.length,
    confirmed: claims.filter((c) => c.status === 'confirmed').length,
    contradicted: claims.filter((c) => c.status === 'contradicted').length,
    partial: claims.filter((c) => c.status === 'partial').length,
    unverifiable: claims.filter((c) => c.status === 'unverifiable').length,
    unchecked: claims.filter((c) => c.status === 'unchecked').length,
    conflicts: findConflicts(claims).list.length,
    feedback: feedback.length,
    topics: {}
  };
  for (const src of sources) for (const t of src.topics) s.topics[t] = (s.topics[t] || 0) + 1;
  return s;
}

// --- Speicher + Ablauf ---------------------------------------------------------

export class AcademyStore extends Emitter {
  /**
   * @param {{ db, knowledge?, settings?, fetchVideo?, serverConfig? }} opts
   *  fetchVideo(videoId) – Abruf beim eigenen Server (Standard: fetchVideoData mit gespeicherter Adresse)
   */
  constructor({ db, knowledge = null, settings = null, fetchVideo = null, serverConfig = null }) {
    super();
    this.knowledge = knowledge;
    this.settings = settings;
    this.sources = [];
    this.claims = [];
    this.feedback = [];
    this.invalid = 0;
    this.error = null;
    this.queue = [];
    this.active = null;
    this._serverConfig = serverConfig || (() => loadServerConfig());
    this._fetchVideo = fetchVideo || ((id) => fetchVideoData(id, { config: this._serverConfig() }));
    this._ready = Promise.resolve(db).then(async (d) => {
      this.db = d;
      this.kind = d.kind;
      await this._load();
    }).catch((err) => {
      this.error = `Academy-Daten konnten nicht geöffnet werden: ${err.message}`;
      this.emit('change', { type: 'error' });
    });
  }

  ready() { return this._ready; }

  get serverConfigured() { return !!this._serverConfig().endpoint; }

  async _load() {
    let invalid = 0;
    const vs = [];
    for (const r of await this.db.all('sources')) { const v = validateSource(r); if (v) vs.push(v); else invalid += 1; }
    const cs = [];
    for (const r of await this.db.all('claims')) { const v = validateClaim(r); if (v) cs.push(v); else invalid += 1; }
    const fs = [];
    for (const r of await this.db.all('feedback')) { const v = validateFeedback(r); if (v) fs.push(v); else invalid += 1; }
    this.invalid = invalid; // unlesbare Einträge bleiben unverändert in der Datenbank
    // Eine Analyse, die beim Schliessen der App lief, gilt als unterbrochen.
    for (const s of vs) if (['running', 'verifying', 'transcript', 'frames', 'strategies'].includes(s.status)) { s.status = 'error'; s.error = 'Analyse wurde unterbrochen (App geschlossen). Bitte wiederholen.'; }
    this.sources = vs.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    this.claims = cs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.feedback = fs.sort((a, b) => b.at.localeCompare(a.at));
    this.emit('change', { type: 'load' });
  }

  async _put(store, value) {
    try {
      await this.db.put(store, value);
    } catch (err) {
      if (isQuotaError(err)) throw new AcademyError('quota', 'Speicher voll: Die Daten konnten nicht gespeichert werden. Bitte die Wissensdatenbank exportieren und alte Videos löschen.');
      throw err;
    }
    return value;
  }

  getSource(id) { return this.sources.find((s) => s.id === id) || null; }
  getClaim(id) { return this.claims.find((c) => c.id === id) || null; }
  claimsOf(sourceId) { return this.claims.filter((c) => c.sources.some((s) => s.sourceId === sourceId)); }
  conflicts() { return findConflicts(this.claims); }
  stats() { return academyStats(this); }

  _rules() { return this.settings ? this.settings.get('rules') : {}; }

  async _saveSource(src) {
    src.updatedAt = nowIso();
    const v = validateSource(src);
    await this._put('sources', v);
    this.sources = [v, ...this.sources.filter((s) => s.id !== v.id)].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    this.emit('change', { type: 'source', id: v.id });
    return v;
  }

  /**
   * YouTube-Link annehmen. Startet die Analyse automatisch (ohne weitere Bestätigung).
   * Doppelte Links werden erkannt: das vorhandene Video wird zurückgegeben.
   * @returns {Promise<{ source, duplicate, done: Promise }>}
   */
  async addLink(url, { autoStart = true } = {}) {
    await this._ready;
    const p = parseYouTubeUrl(url);
    if (!p.ok) throw new AcademyError(p.code, p.error);
    const id = `yt_${p.videoId}`;
    const have = this.getSource(id);
    if (have) return { source: have, duplicate: true, done: Promise.resolve(have) };
    if (this.sources.length >= MAX_SOURCES) throw new AcademyError('limit', `Höchstens ${MAX_SOURCES} Videos. Bitte alte Videos löschen oder exportieren.`);
    const steps = emptySteps();
    steps.link = { state: 'ok', note: `Video-ID ${p.videoId}`, at: nowIso() };
    const src = await this._saveSource({ id, kind: 'youtube', videoId: p.videoId, addedAt: nowIso(), status: 'waiting', steps, runs: 0 });
    const done = autoStart ? this.analyze(id) : Promise.resolve(src);
    return { source: src, duplicate: false, done };
  }

  /** Analyse (erneut) einreihen. Läuft nacheinander, damit die App flüssig bleibt. */
  analyze(id) {
    return new Promise((resolve, reject) => {
      this.queue.push({ id, resolve, reject });
      this._pump();
    });
  }

  async _pump() {
    if (this.active || !this.queue.length) return;
    const job = this.queue.shift();
    this.active = job.id;
    try {
      job.resolve(await this._run(job.id));
    } catch (err) {
      job.reject(err);
    } finally {
      this.active = null;
      // Ansicht neu zeichnen: Knöpfe (Wiederholen, Transkript, Löschen) wieder freigeben
      this.emit('change', { type: 'idle', id: job.id });
      this._pump();
    }
  }

  async _run(id) {
    await this._ready;
    let src = this.getSource(id);
    if (!src) throw new AcademyError('not-found', 'Video nicht gefunden.');
    const step = (name, state, note = '') => { src.steps[name] = { state, note, at: nowIso() }; };
    const keepManual = src.transcript.available && src.transcript.source === 'manual' ? src.transcript : null;
    src = { ...src, steps: { ...emptySteps(), link: src.steps.link }, status: 'running', error: null, runs: (src.runs || 0) + 1, lastCheckedAt: nowIso() };
    step('link', 'ok', `Video-ID ${src.videoId}`);
    step('meta', 'run');
    src = await this._saveSource(src);

    try {
      // 3–6: Videoinformationen, Transkript, Videobilder (nur über den eigenen Server)
      let data = null;
      if (this.serverConfigured) {
        try {
          data = await this._fetchVideo(src.videoId);
        } catch (err) {
          const msg = err instanceof ServerError ? err.message : `Server: ${err.message}`;
          step('meta', 'fail', msg);
          if (!keepManual) {
            step('transcript', 'fail', 'Nicht abgerufen, weil der Server nicht antwortet.');
            step('frames', 'skip', 'Nicht abgerufen.');
            for (const k of ['extract', 'verify', 'save']) step(k, 'skip', 'Abgebrochen.');
            src.status = 'error';
            src.error = msg;
            return await this._saveSource(src);
          }
        }
      }
      if (data) {
        src.title = data.meta.title || src.title;
        src.channel = data.meta.channel || src.channel;
        src.durationSec = data.meta.durationSec ?? src.durationSec;
        step('meta', 'ok', [data.meta.title, data.meta.channel].filter(Boolean).join(' · ') || 'Server erreichbar (keine Titelangabe).');
      } else if (!this.serverConfigured) {
        step('meta', 'skip', 'Kein Yumeko-Server eingerichtet: Titel und Kanal können im Browser nicht abgerufen werden.');
      }

      if (data && data.transcript.available) {
        src.transcript = { available: true, source: 'server', language: data.transcript.language, segments: data.transcript.segments };
        step('transcript', 'ok', `${data.transcript.segments.length} Abschnitte vom Server${data.transcript.language ? ` (${data.transcript.language})` : ''}.`);
      } else if (keepManual) {
        src.transcript = keepManual;
        step('transcript', 'ok', 'Von dir eingefügtes Transkript.');
      } else {
        src.transcript = { available: false, source: null, reason: data ? data.transcript.reason : 'Ohne eigenen Server ist kein Transkript abrufbar.' };
        step('transcript', 'fail', `Kein Transkript verfügbar. ${src.transcript.reason}`);
      }
      if (src.transcript.available) { src.status = 'transcript'; src = await this._saveSource(src); }

      if (data && data.frames.available) {
        src.frames = { available: true, count: data.frames.observations.length };
        step('frames', 'ok', `${data.frames.observations.length} Bildbeobachtungen vom Server.`);
        src.status = 'frames';
      } else {
        src.frames = { available: false, reason: data ? data.frames.reason : 'Videobilder von YouTube können im Browser nicht ausgelesen werden.' };
        step('frames', 'skip', `Nicht verfügbar: ${src.frames.reason}`);
      }

      // 7: Regeln und Strategien erkennen
      const segments = [
        ...(src.transcript.available ? src.transcript.segments : []),
        ...(data && data.frames.available ? data.frames.observations.map((o) => ({ start: o.at, text: o.text })) : [])
      ];
      if (!segments.length) {
        step('extract', 'skip', 'Kein auswertbarer Inhalt.');
        step('verify', 'skip', 'Nichts zu prüfen.');
        step('save', 'ok', 'Video gespeichert (ohne Erkenntnisse).');
        src.status = 'unverifiable';
        src.counts = { claims: 0 };
        return await this._saveSource(src);
      }
      const ex = extractClaims(segments);
      src.topics = ex.topics;
      if (!ex.claims.length) {
        step('extract', 'fail', `Keine klar formulierten Blackjack-Aussagen erkannt (${ex.chars} Zeichen ausgewertet).`);
        step('verify', 'skip', 'Nichts zu prüfen.');
        step('save', 'ok', 'Video gespeichert (ohne Erkenntnisse).');
        src.status = 'unverifiable';
        src.counts = { claims: 0 };
        return await this._saveSource(src);
      }
      step('extract', 'ok', `${ex.claims.length} Aussagen erkannt.`);
      src.status = 'strategies';
      src = await this._saveSource(src);

      // 8: Mathematisch prüfen (bereits geprüftes Wissen mit gleichen Regeln wird wiederverwendet)
      src.status = 'verifying';
      step('verify', 'run', `0 von ${ex.claims.length} geprüft.`);
      src = await this._saveSource(src);
      const rules = this._rules();
      const rt = rulesText(rules);
      const touched = [];
      let reused = 0;
      for (let i = 0; i < ex.claims.length; i++) {
        const c = ex.claims[i];
        const key = claimKey(c);
        const cid = claimIdFor(key);
        const existing = this.getClaim(cid);
        const ref = { sourceId: src.id, videoId: src.videoId, excerpt: c.excerpt, at: c.at };
        const data2 = { ...c }; delete data2.excerpt; delete data2.at; delete data2.key;
        let verification = existing && existing.verification && existing.verification.rulesText === rt ? existing.verification : null;
        if (verification) reused += 1;
        else {
          const v = await verifyClaim(c, rules);
          verification = { verdict: v.verdict, at: v.at, details: v.details, method: v.method, rulesText: rt, counts: v.counts || null, cells: v.cells || null };
        }
        const rec = validateClaim({
          id: cid, key, type: c.type, data: data2, text: claimText(c),
          sources: [...(existing ? existing.sources.filter((s) => s.sourceId !== src.id) : []), ref],
          firstSeen: existing ? existing.firstSeen : nowIso(), updatedAt: nowIso(), verification,
          flagged: existing ? existing.flagged && verification.verdict === 'contradicted' : false,
          userNote: existing ? existing.userNote : ''
        });
        await this._put('claims', rec);
        this.claims = [rec, ...this.claims.filter((x) => x.id !== rec.id)];
        touched.push(rec);
        step('verify', 'run', `${i + 1} von ${ex.claims.length} geprüft.`);
        this.emit('change', { type: 'progress', id: src.id });
      }
      step('verify', 'ok', `${ex.claims.length} Aussagen geprüft${reused ? ` (${reused} aus gespeichertem Wissen wiederverwendet)` : ''}.`);

      // Verwaiste Zuordnungen aus einer früheren Analyse dieses Videos entfernen.
      const keep = new Set(touched.map((c) => c.id));
      for (const old of this.claimsOf(src.id).filter((c) => !keep.has(c.id))) await this._detachClaim(old, src.id);

      await this._mirrorToKnowledge(touched);
      src.claimIds = touched.map((c) => c.id);
      const counts = { claims: touched.length, confirmed: 0, contradicted: 0, partial: 0, unverifiable: 0 };
      for (const c of touched) counts[c.status] = (counts[c.status] || 0) + 1;
      src.counts = counts;
      src.status = videoStatusFor(touched);
      step('save', 'ok', 'Lokal gespeichert (IndexedDB).');
      if (this.knowledge && this.knowledge.logHistory) await this.knowledge.logHistory('academy', `Video analysiert: ${src.title || src.videoId} – ${counts.confirmed} bestätigt, ${counts.contradicted} widerlegt, ${counts.partial} teilweise, ${counts.unverifiable} nicht überprüfbar`, src.id);
      return await this._saveSource(src);
    } catch (err) {
      src.status = 'error';
      src.error = err.message;
      for (const k of STEP_ORDER) if (src.steps[k].state === 'run' || src.steps[k].state === 'wait') src.steps[k] = { state: 'fail', note: err.message, at: nowIso() };
      try { await this._saveSource(src); } catch { /* Speicher voll: Status bleibt im Arbeitsspeicher */ this.sources = [src, ...this.sources.filter((s) => s.id !== src.id)]; this.emit('change', { type: 'source' }); }
      if (err instanceof AcademyError) throw err;
      return src;
    }
  }

  /** Bestätigte Aussagen in YUMEKOS Wissensspeicher spiegeln (nur geprüfte!). */
  async _mirrorToKnowledge(claims) {
    if (!this.knowledge || !this.knowledge.upsert) return;
    for (const c of claims) {
      if (c.type !== 'play' && c.type !== 'insurance') continue;
      const v = c.verification;
      if (!v) continue;
      const single = c.type === 'play' && c.data.cells.length === 1 && !c.data.negated && ACTION_CODE[c.data.action];
      const cell = single ? { key: cellKey(c.data.cells[0].kind, c.data.cells[0].value, c.data.cells[0].up), code: ACTION_CODE[c.data.action] } : null;
      let category; let status;
      if (v.verdict === 'confirmed') { category = 'verified'; status = 'mathematisch geprüft'; } else if (v.verdict === 'contradicted') { category = 'hypothesis'; status = 'widerspricht dem Rechenmodell'; } else { category = 'hypothesis'; status = 'unbestätigt'; }
      try {
        await this.knowledge.upsert({
          id: `academy:${c.id}`,
          category,
          content: `${c.text} (aus ${c.sources.length} ${c.sources.length === 1 ? 'Video' : 'Videos'}) – ${VERDICT[v.verdict]}.`,
          origin: { type: 'video', detail: `Yumeko Academy · ${c.sources.map((s) => s.videoId).filter(Boolean).slice(0, 3).join(', ')}` },
          rules: this._rules(),
          confidence: { level: v.verdict === 'confirmed' ? 'hoch' : 'niedrig', basis: v.method },
          status,
          refs: { rounds: [], videos: c.sources.map((s) => s.sourceId) },
          // Nur bestätigte Einzelaussagen tragen eine Tabellenzelle – und auch die wirkt erst über
          // eine neue, geprüfte und bestätigte YUMEKO-Strategieversion.
          data: v.verdict === 'confirmed' && cell ? { cell, academyClaim: c.id } : { academyClaim: c.id },
          auto: true
        }, { fromAnalysis: true });
      } catch (err) { console.warn('[academy] Wissen nicht gespiegelt', err); }
    }
  }

  async _detachClaim(claim, sourceId) {
    const rest = claim.sources.filter((s) => s.sourceId !== sourceId);
    if (!rest.length) {
      await this.db.delete('claims', claim.id);
      this.claims = this.claims.filter((c) => c.id !== claim.id);
      if (this.knowledge && this.knowledge.removeQuiet) await this.knowledge.removeQuiet(`academy:${claim.id}`);
    } else {
      const v = { ...claim, sources: rest, updatedAt: nowIso() };
      await this._put('claims', v);
      this.claims = this.claims.map((c) => (c.id === v.id ? v : c));
    }
  }

  /** Transkript von Hand einfügen (z. B. aus YouTube „Transkript anzeigen“ kopiert) und neu analysieren. */
  async setManualTranscript(id, text) {
    await this._ready;
    const src = this.getSource(id);
    if (!src) throw new AcademyError('not-found', 'Video nicht gefunden.');
    const clean = String(text || '').trim();
    if (clean.length < 20) throw new AcademyError('short', 'Das Transkript ist zu kurz.');
    // Zeitstempel "1:23" am Zeilenanfang übernehmen, wenn vorhanden.
    const segments = [];
    let cur = null;
    for (const line of clean.split(/\r?\n/).slice(0, 20000)) {
      const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/.exec(line) || /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s+(.+)$/.exec(line);
      if (m) {
        cur = (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
        if (m[4]) segments.push({ start: cur, text: m[4].slice(0, 2000) });
      } else if (line.trim()) segments.push({ start: cur, text: line.trim().slice(0, 2000) });
    }
    await this._saveSource({ ...src, transcript: { available: true, source: 'manual', language: null, segments } });
    return this.analyze(id);
  }

  /** Alle Aussagen mit den aktuellen Tischregeln erneut prüfen. */
  async recheckClaims(ids = null) {
    await this._ready;
    const rules = this._rules();
    const rt = rulesText(rules);
    const list = ids ? this.claims.filter((c) => ids.includes(c.id)) : this.claims.slice();
    const out = [];
    for (const c of list) {
      const v = await verifyClaim({ type: c.type, ...c.data }, rules);
      const rec = validateClaim({ ...c, updatedAt: nowIso(), verification: { verdict: v.verdict, at: v.at, details: v.details, method: v.method, rulesText: rt, counts: v.counts || null, cells: v.cells || null } });
      await this._put('claims', rec);
      this.claims = this.claims.map((x) => (x.id === rec.id ? rec : x));
      out.push(rec);
      this.emit('change', { type: 'recheck', id: rec.id });
    }
    await this._mirrorToKnowledge(out);
    for (const src of this.sources) {
      const mine = this.claimsOf(src.id);
      if (mine.length && src.status !== 'error') await this._saveSource({ ...src, status: videoStatusFor(mine), lastCheckedAt: nowIso() });
    }
    return out;
  }

  /** Aussage vom Benutzer als fehlerhaft markieren (oder Markierung entfernen). */
  async flagClaim(id, flagged = true, note = '') {
    const c = this.getClaim(id);
    if (!c) throw new AcademyError('not-found', 'Eintrag nicht gefunden.');
    const v = { ...c, flagged: !!flagged, userNote: String(note || c.userNote || '').slice(0, 500), updatedAt: nowIso() };
    await this._put('claims', v);
    this.claims = this.claims.map((x) => (x.id === id ? v : x));
    this.emit('change', { type: 'flag', id });
    return v;
  }

  async removeClaim(id) {
    await this._ready;
    const c = this.getClaim(id);
    if (!c) return;
    await this.db.delete('claims', id);
    this.claims = this.claims.filter((x) => x.id !== id);
    for (const s of this.sources.filter((x) => x.claimIds.includes(id))) await this._saveSource({ ...s, claimIds: s.claimIds.filter((x) => x !== id) });
    if (this.knowledge && this.knowledge.get && this.knowledge.get(`academy:${id}`)) await this.knowledge.remove(`academy:${id}`);
    this.emit('change', { type: 'claim-remove', id });
  }

  /** Video löschen. Aussagen, die nur aus diesem Video stammen, werden mitgelöscht. */
  async removeSource(id) {
    await this._ready;
    const src = this.getSource(id);
    if (!src) return;
    for (const c of this.claimsOf(id)) await this._detachClaim(c, id);
    await this.db.delete('sources', id);
    this.sources = this.sources.filter((s) => s.id !== id);
    if (this.knowledge && this.knowledge.logHistory) await this.knowledge.logHistory('löschung', `Academy-Video gelöscht: ${src.title || src.videoId}`, id);
    this.emit('change', { type: 'source-remove', id });
  }

  // --- Erkennungsmeldungen (Kamera-Lernmodus) ---------------------------------
  async addFeedback(report) {
    await this._ready;
    const v = validateFeedback({ id: `fb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: nowIso(), ...report });
    if (!v) throw new AcademyError('invalid', 'Meldung ungültig.');
    await this._put('feedback', v);
    this.feedback = [v, ...this.feedback];
    this.emit('change', { type: 'feedback', id: v.id });
    return v;
  }

  async removeFeedback(id) {
    await this._ready;
    await this.db.delete('feedback', id);
    this.feedback = this.feedback.filter((f) => f.id !== id);
    this.emit('change', { type: 'feedback-remove', id });
  }

  // --- Sicherung ---------------------------------------------------------------
  exportData() {
    return {
      format: ACADEMY_FORMAT,
      version: ACADEMY_VERSION,
      app: `BJ.AI ${APP_VERSION}`,
      exportedAt: nowIso(),
      sources: this.sources,
      claims: this.claims,
      feedback: this.feedback
    };
  }

  /** Sicherung einlesen. Vorhandene Einträge (gleiche ID) werden nicht überschrieben; Quellen doppelter Aussagen werden zusammengeführt. */
  async importData(data) {
    await this._ready;
    if (!data || typeof data !== 'object' || data.format !== ACADEMY_FORMAT) throw new AcademyError('format', 'Keine Yumeko-Academy-Sicherung (falsches Dateiformat).');
    if (typeof data.version !== 'number' || data.version > ACADEMY_VERSION) throw new AcademyError('version', 'Die Sicherung stammt aus einer neueren App-Version.');
    const res = { added: 0, merged: 0, skipped: 0, invalid: 0 };
    const haveS = new Set(this.sources.map((s) => s.id));
    for (const raw of Array.isArray(data.sources) ? data.sources : []) {
      const v = validateSource(raw);
      if (!v) { res.invalid += 1; continue; }
      if (haveS.has(v.id)) { res.skipped += 1; continue; }
      if (['running', 'verifying', 'transcript', 'frames', 'strategies'].includes(v.status)) v.status = 'waiting';
      await this._put('sources', v); haveS.add(v.id); res.added += 1;
    }
    for (const raw of Array.isArray(data.claims) ? data.claims : []) {
      const v = validateClaim(raw);
      if (!v) { res.invalid += 1; continue; }
      const cur = this.getClaim(v.id);
      if (cur) {
        const extra = v.sources.filter((s) => !cur.sources.some((x) => x.sourceId === s.sourceId));
        if (extra.length) { const m = { ...cur, sources: [...cur.sources, ...extra] }; await this._put('claims', m); this.claims = this.claims.map((x) => (x.id === m.id ? m : x)); res.merged += 1; } else res.skipped += 1;
        continue;
      }
      await this._put('claims', v); this.claims.push(v); res.added += 1;
    }
    const haveF = new Set(this.feedback.map((f) => f.id));
    for (const raw of Array.isArray(data.feedback) ? data.feedback : []) {
      const v = validateFeedback(raw);
      if (!v) { res.invalid += 1; continue; }
      if (haveF.has(v.id)) { res.skipped += 1; continue; }
      await this._put('feedback', v); res.added += 1;
    }
    await this._load();
    return res;
  }

  /** Gesamte Academy-Wissensdatenbank zurücksetzen – nur mit ausdrücklicher Bestätigung. */
  async resetAll({ confirmed = false } = {}) {
    if (!confirmed) throw new AcademyError('confirm', 'Bitte das Zurücksetzen ausdrücklich bestätigen.');
    await this._ready;
    await this.db.clear('sources');
    await this.db.clear('claims');
    await this.db.clear('feedback');
    if (this.knowledge && this.knowledge.items) {
      for (const it of this.knowledge.items.filter((i) => i.id.startsWith('academy:'))) await this.knowledge.removeQuiet(it.id);
    }
    this.sources = []; this.claims = []; this.feedback = [];
    this.emit('change', { type: 'reset' });
  }
}
