// Strategieprofile: lokal gespeichert (localStorage "bjassist.strategyProfiles").
//
// Format (Version 2, ab App 0.6.0; Version 1 = App 0.5.0 wird automatisch übernommen):
// {
//   version: 2, rev: <Zähler gegen ungewolltes Überschreiben>,
//   activeId: '<id>',
//   profiles: [{ id, name, description, type: 'standard'|'custom'|'ai'|'yumeko',
//                rules: {decks, soft17, das, payout},
//                settings: { followTableRules: bool },
//                overrides: { 'hard:16:10': 'S', … },   // Abweichungen zur Standardtabelle
//                data: { … gespeicherte Strategie-/Analyse-/Recherchedaten … },
//                createdAt, updatedAt }],
//   invalid: [ … unlesbare Einträge, unverändert aufbewahrt … ]
// }
//
// Regeln:
// - Immer genau ein aktives Profil; die aktive ID wird dauerhaft gespeichert.
// - Das Profil "Standardstrategie" ist eingebaut, unveränderlich und nicht löschbar
//   (sicherer Rückfall). Duplizieren ist möglich.
// - Das Profil "YUMEKO AI" ist ebenfalls eingebaut und nicht löschbar. Seine Tabelle
//   ändert sich nur über geprüfte und vom Benutzer bestätigte Strategieversionen.
// - Das aktive Profil kann erst gelöscht werden, wenn ein anderes aktiv ist.
// - Migration 1 -> 2: Aufgeben-Codes (Rh/Rs/Rp) werden in die Aktion ohne Aufgeben
//   übersetzt; die alten Werte bleiben in data.legacySurrender nachvollziehbar.
// - Ungültige gespeicherte Einträge werden nie gelöscht, sondern beiseitegelegt.
// - Vor jedem Speichern wird geprüft, ob ein anderes Fenster inzwischen gespeichert hat.
import { Emitter } from '../core/events.js';
import { load, save } from '../core/store.js';
import { normalizeRules, parseKey, CODES_BY_KIND, rulesEqual, modernCode } from './standard.js';

export const PROFILES_KEY = 'strategyProfiles';
export const PROFILES_VERSION = 2;
export const STANDARD_ID = 'standard';
export const YUMEKO_ID = 'yumeko';
export const PROFILE_TYPES = ['standard', 'custom', 'ai', 'yumeko'];
export const TYPE_LABEL = { standard: 'Standard', custom: 'Benutzerdefiniert', ai: 'KI-Strategie', yumeko: 'YUMEKO AI' };
const BUILTIN = new Set([STANDARD_ID, YUMEKO_ID]);
const MAX_NAME = 60;
const MAX_DESC = 500;

export class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function newId() {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

export function standardProfile(tableRules, at = nowIso()) {
  return {
    id: STANDARD_ID,
    name: 'Standardstrategie',
    description: 'Bewährte Basisstrategie (4–8 Decks), passt sich automatisch den Tischregeln an. Eingebaut und nicht veränderbar.',
    type: 'standard',
    rules: normalizeRules(tableRules),
    settings: { followTableRules: true },
    overrides: {},
    data: {},
    createdAt: at,
    updatedAt: at
  };
}

export function yumekoProfile(tableRules, at = nowIso(), stored = null) {
  const data = stored && stored.data && typeof stored.data === 'object' ? stored.data : {};
  return {
    id: YUMEKO_ID,
    name: 'YUMEKO AI',
    description: 'Adaptive Blackjack Intelligence.',
    type: 'yumeko',
    rules: normalizeRules(tableRules),
    settings: { followTableRules: true },
    // Tabelle der aktivierten Strategieversion (anfangs leer = Standardstrategie).
    overrides: stored ? { ...stored.overrides } : {},
    data: { strategyVersion: 0, versionId: null, ...data },
    createdAt: at,
    updatedAt: stored && stored.updatedAt ? stored.updatedAt : at
  };
}

function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function isIso(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

/** Gespeichertes Profil prüfen. Liefert bereinigtes Profil oder null. */
export function validateProfile(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p.id)) return null;
  if (!PROFILE_TYPES.includes(p.type)) return null;
  const name = cleanText(p.name, MAX_NAME);
  if (!name) return null;
  const overrides = {};
  const legacy = {};
  if (p.overrides && typeof p.overrides === 'object') {
    for (const [k, v] of Object.entries(p.overrides)) {
      const key = parseKey(k);
      if (!key) continue;
      const code = modernCode(v);
      if (code !== v) legacy[k] = v; // Aufgeben aus 0.5.0 -> nachvollziehbar aufbewahren
      if (CODES_BY_KIND[key.kind].includes(code)) overrides[k] = code;
    }
  }
  const at = isIso(p.createdAt) ? p.createdAt : nowIso();
  const data = p.data && typeof p.data === 'object' && !Array.isArray(p.data) ? { ...p.data } : {};
  if (Object.keys(legacy).length) data.legacySurrender = { ...(data.legacySurrender || {}), ...legacy };
  return {
    id: p.id,
    name,
    description: cleanText(p.description, MAX_DESC),
    type: p.type,
    rules: normalizeRules(p.rules),
    settings: { followTableRules: !!(p.settings && p.settings.followTableRules) },
    overrides,
    data,
    createdAt: at,
    updatedAt: isIso(p.updatedAt) ? p.updatedAt : at
  };
}

/**
 * Gespeicherte Daten lesen und migrieren.
 * - Kein Eintrag (Version 0.4.0 und älter): Standardprofil anlegen, aktiv.
 * - Unbekannte/ungültige Einträge bleiben in "invalid" erhalten.
 */
export function migrate(raw, tableRules) {
  const out = { version: PROFILES_VERSION, rev: 0, activeId: STANDARD_ID, profiles: [], invalid: [], migratedFrom: null };
  if (!raw || typeof raw !== 'object') {
    out.migratedFrom = raw == null ? '0.4.0' : 'unlesbar';
    if (raw != null) out.invalid.push(raw);
  } else {
    if (typeof raw.version === 'number' && raw.version > PROFILES_VERSION) {
      // Neueres Format (z. B. nach Rückkehr zu einer älteren App-Version): nichts verändern.
      throw new ProfileError('newer-format', 'Die Strategieprofile stammen aus einer neueren App-Version.');
    }
    out.rev = Number.isInteger(raw.rev) ? raw.rev : 0;
    if (raw.version !== PROFILES_VERSION) out.migratedFrom = raw.version === 1 ? '0.5.0' : 'unbekannt';
    if (Array.isArray(raw.invalid)) out.invalid.push(...raw.invalid);
    const seen = new Set();
    for (const p of Array.isArray(raw.profiles) ? raw.profiles : []) {
      const v = validateProfile(p);
      if (!v || seen.has(v.id)) { out.invalid.push(p); continue; }
      seen.add(v.id);
      out.profiles.push(v);
    }
    out.activeId = typeof raw.activeId === 'string' ? raw.activeId : STANDARD_ID;
  }
  // Standardprofil immer vorhanden und unverändert (Regeln folgen dem Tisch).
  const idx = out.profiles.findIndex((p) => p.id === STANDARD_ID);
  const std = standardProfile(tableRules, idx >= 0 ? out.profiles[idx].createdAt : undefined);
  if (idx >= 0) out.profiles[idx] = std;
  else out.profiles.unshift(std);
  // YUMEKO AI immer vorhanden (direkt nach Standard); gelernte Tabelle bleibt erhalten.
  const yi = out.profiles.findIndex((p) => p.id === YUMEKO_ID);
  const yStored = yi >= 0 && out.profiles[yi].type === 'yumeko' ? out.profiles[yi] : null;
  if (yi >= 0 && !yStored) {
    // Fremdes Profil mit derselben ID (sehr unwahrscheinlich): unter neuer ID behalten.
    out.profiles[yi] = { ...out.profiles[yi], id: newId() };
  }
  const yum = yumekoProfile(tableRules, yStored ? yStored.createdAt : undefined, yStored);
  if (yStored) out.profiles[yi] = yum;
  else { out.profiles.splice(1, 0, yum); if (!out.migratedFrom) out.migratedFrom = 'ohne-yumeko'; }
  if (!out.profiles.some((p) => p.id === out.activeId)) out.activeId = STANDARD_ID;
  return out;
}

function uniqueName(name, profiles, exceptId = null) {
  const base = cleanText(name, MAX_NAME) || 'Neues Profil';
  const taken = new Set(profiles.filter((p) => p.id !== exceptId).map((p) => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const n = `${base.slice(0, MAX_NAME - 5)} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
  return `${base.slice(0, 40)} ${newId()}`;
}

export class ProfileStore extends Emitter {
  /**
   * @param {{ settings, storage? }} opts – settings: App-Einstellungen (Tischregeln)
   *   storage: { load(key, fallback), save(key, value) } (für Tests austauschbar)
   */
  constructor({ settings, storage = { load, save } }) {
    super();
    this.settings = settings;
    this.storage = storage;
    this.error = null;
    this._reload({ persistMigration: true });
    settings.on('change', ({ path }) => {
      if (path.startsWith('rules')) {
        this.get(STANDARD_ID).rules = normalizeRules(settings.get('rules'));
        this.get(YUMEKO_ID).rules = normalizeRules(settings.get('rules'));
        this.emit('change', { type: 'rules' });
      }
    });
    if (typeof window !== 'undefined') {
      // Änderungen aus einem anderen Fenster/Tab übernehmen.
      window.addEventListener('storage', (e) => {
        if (e.key && e.key.endsWith(PROFILES_KEY)) { this._reload(); this.emit('change', { type: 'external' }); }
      });
    }
  }

  _tableRules() {
    return normalizeRules(this.settings.get('rules'));
  }

  _reload({ persistMigration = false } = {}) {
    const raw = this.storage.load(PROFILES_KEY, null);
    try {
      this.state = migrate(raw, this._tableRules());
      this.readOnly = false;
    } catch (err) {
      // Neueres Format: nur lesen, nie überschreiben.
      this.state = migrate(null, this._tableRules());
      this.readOnly = true;
      this.error = err.message;
    }
    if (persistMigration && !this.readOnly && (this.state.migratedFrom || raw == null)) this._write(true);
  }

  // Schreiben mit Prüfung gegen gleichzeitige Änderungen.
  _write(force = false) {
    if (this.readOnly) throw new ProfileError('read-only', this.error || 'Profile sind schreibgeschützt.');
    const current = this.storage.load(PROFILES_KEY, null);
    const curRev = current && Number.isInteger(current.rev) ? current.rev : 0;
    if (!force && current && curRev !== this.state.rev) {
      this._reload();
      this.emit('change', { type: 'external' });
      throw new ProfileError('conflict', 'Die Profile wurden inzwischen an anderer Stelle geändert. Bitte noch einmal versuchen.');
    }
    const next = {
      version: PROFILES_VERSION,
      rev: curRev + 1,
      activeId: this.state.activeId,
      profiles: this.state.profiles,
      invalid: this.state.invalid
    };
    if (!this.storage.save(PROFILES_KEY, next)) throw new ProfileError('storage', 'Speichern fehlgeschlagen (lokaler Speicher nicht verfügbar).');
    this.state.rev = next.rev;
    delete this.state.migratedFrom;
  }

  _commit(type, mutate) {
    const backup = JSON.stringify(this.state);
    try {
      const result = mutate();
      this._write();
      this.emit('change', { type });
      return result;
    } catch (err) {
      if (err.code !== 'conflict') this.state = JSON.parse(backup);
      throw err;
    }
  }

  // --- Lesen -------------------------------------------------------------

  list() { return this.state.profiles; }
  get(id) { return this.state.profiles.find((p) => p.id === id) || null; }
  get activeId() { return this.state.activeId; }
  get active() { return this.get(this.state.activeId) || this.get(STANDARD_ID); }
  get invalidCount() { return this.state.invalid.length; }

  /** Für die Engine: Overrides + Regeln, für die die Tabelle gilt. */
  strategyFor(profile = this.active) {
    const table = this._tableRules();
    return {
      profile,
      overrides: profile.overrides,
      strategyRules: profile.settings.followTableRules ? table : profile.rules,
      rulesMismatch: !profile.settings.followTableRules && !rulesEqual(profile.rules, table)
    };
  }

  // --- Ändern ------------------------------------------------------------

  _editable(id) {
    const p = this.get(id);
    if (!p) throw new ProfileError('not-found', 'Profil nicht gefunden.');
    if (p.type === 'standard') throw new ProfileError('locked', 'Die eingebaute Standardstrategie kann nicht verändert werden. Dupliziere sie, um eine eigene Version zu erstellen.');
    if (p.type === 'yumeko') throw new ProfileError('locked', 'YUMEKO AI wird nur über geprüfte Strategieversionen im Lernzentrum verändert. Dupliziere das Profil, um es frei zu bearbeiten.');
    return p;
  }

  /**
   * Geprüfte und vom Benutzer bestätigte Strategieversion für YUMEKO übernehmen.
   * version: { id, number, overrides, verification } – wird vom Lernzentrum erzeugt.
   */
  applyYumekoVersion(version) {
    if (!version || !version.id || !Number.isInteger(version.number)) throw new ProfileError('invalid-version', 'Ungültige Strategieversion.');
    if (!version.verification || !version.verification.ok) throw new ProfileError('unverified', 'Die Strategieversion ist nicht mathematisch geprüft.');
    if (!version.confirmedAt) throw new ProfileError('unconfirmed', 'Die Strategieversion wurde nicht bestätigt.');
    return this._commit('update', () => {
      const p = this.get(YUMEKO_ID);
      const overrides = {};
      for (const [k, v] of Object.entries(version.overrides || {})) {
        const key = parseKey(k);
        const code = modernCode(v);
        if (key && CODES_BY_KIND[key.kind].includes(code)) overrides[k] = code;
      }
      p.overrides = overrides;
      p.data = { ...p.data, strategyVersion: version.number, versionId: version.id, appliedAt: nowIso() };
      p.updatedAt = nowIso();
      return p;
    });
  }

  create({ name, description = '', type = 'custom', rules = null, overrides = {}, data = {}, followTableRules = false, activate = false } = {}) {
    if (type === 'standard' || type === 'yumeko') throw new ProfileError('locked', 'Dieses Profil ist eingebaut und existiert nur einmal.');
    return this._commit('create', () => {
      const at = nowIso();
      const p = validateProfile({
        id: newId(),
        name: uniqueName(name, this.state.profiles),
        description,
        type,
        rules: rules || this._tableRules(),
        settings: { followTableRules },
        overrides,
        data,
        createdAt: at,
        updatedAt: at
      });
      this.state.profiles.push(p);
      if (activate) this.state.activeId = p.id;
      return p;
    });
  }

  update(id, patch) {
    return this._commit('update', () => {
      const p = this._editable(id);
      if ('name' in patch) p.name = uniqueName(patch.name, this.state.profiles, id);
      if ('description' in patch) p.description = cleanText(patch.description, MAX_DESC);
      if ('rules' in patch) p.rules = normalizeRules(patch.rules);
      if ('followTableRules' in patch) p.settings.followTableRules = !!patch.followTableRules;
      if ('data' in patch) p.data = { ...p.data, ...patch.data };
      p.updatedAt = nowIso();
      return p;
    });
  }

  rename(id, name) {
    return this.update(id, { name });
  }

  /** Eine Tabellenzelle setzen (code = null -> zurück zur Standardstrategie). */
  setCell(id, key, code) {
    return this._commit('update', () => {
      const p = this._editable(id);
      const k = parseKey(key);
      if (!k) throw new ProfileError('invalid-cell', 'Unbekannte Tabellenzelle.');
      if (code == null) delete p.overrides[key];
      else {
        if (!CODES_BY_KIND[k.kind].includes(code)) throw new ProfileError('invalid-code', 'Diese Aktion ist für diese Hand nicht möglich.');
        p.overrides[key] = code;
      }
      p.updatedAt = nowIso();
      return p;
    });
  }

  resetCells(id) {
    return this._commit('update', () => {
      const p = this._editable(id);
      p.overrides = {};
      p.updatedAt = nowIso();
      return p;
    });
  }

  duplicate(id, name = null) {
    const src = this.get(id);
    if (!src) throw new ProfileError('not-found', 'Profil nicht gefunden.');
    return this.create({
      name: name || `${src.name} (Kopie)`,
      description: src.description,
      type: BUILTIN.has(src.id) ? 'custom' : src.type,
      rules: src.settings.followTableRules ? this._tableRules() : src.rules,
      followTableRules: BUILTIN.has(src.id) ? true : src.settings.followTableRules,
      overrides: { ...src.overrides },
      data: JSON.parse(JSON.stringify(src.data || {}))
    });
  }

  activate(id) {
    if (!this.get(id)) throw new ProfileError('not-found', 'Profil nicht gefunden.');
    if (id === this.state.activeId) return this.get(id);
    return this._commit('activate', () => {
      this.state.activeId = id;
      return this.get(id);
    });
  }

  remove(id) {
    const p = this.get(id);
    if (!p) throw new ProfileError('not-found', 'Profil nicht gefunden.');
    if (p.type === 'standard') throw new ProfileError('locked', 'Die eingebaute Standardstrategie kann nicht gelöscht werden.');
    if (p.type === 'yumeko') throw new ProfileError('locked', 'YUMEKO AI ist eingebaut und kann nicht gelöscht werden. Gelerntes Wissen lässt sich im Lernzentrum korrigieren oder löschen.');
    if (id === this.state.activeId) throw new ProfileError('active', 'Das aktive Profil kann nicht gelöscht werden. Aktiviere zuerst ein anderes Profil.');
    return this._commit('remove', () => {
      this.state.profiles = this.state.profiles.filter((x) => x.id !== id);
      return true;
    });
  }
}
