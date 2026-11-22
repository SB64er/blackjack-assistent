// KI-Strategie: Architektur für Recherche und Strategieentwicklung.
//
// Zwei Arten von "Anbietern" (Providern):
//  1. LocalModelProvider  – immer verfügbar, offline, auf dem Gerät.
//     Berechnet die Strategie MATHEMATISCH (ev.js). Keine Quellen, keine KI.
//  2. RemoteResearchProvider – echte Online-Recherche über einen EIGENEN Server
//     (z. B. ein kleiner Proxy, der eine KI-/Such-API aufruft). API-Schlüssel
//     liegen nur auf diesem Server, nie im Browsercode. Standard: NICHT verbunden.
//     Ohne Adresse und ohne ausdrückliche Zustimmung wird nichts gesendet.
//
// Grundsätze:
//  - Es wird nie eine Recherche vorgetäuscht. Ohne Verbindung steht das klar da.
//  - Mathematische Aussagen aus der Online-Recherche werden NICHT übernommen,
//    sondern mit dem Rechenmodell nachgeprüft und so gekennzeichnet.
//  - Gesendet werden nur die Tischregeln – keine Kamerabilder, keine Muster.
import { load, save, remove } from '../core/store.js';
import { computeStrategy, MODEL_ASSUMPTIONS } from './ev.js';
import { standardCode, normalizeRules, parseKey, CODES_BY_KIND, rulesText, cellKey, ROWS, UPCARDS } from './standard.js';
import { resolveCode } from './engine.js';
import { APP_VERSION } from '../core/version.js';

const CONFIG_KEY = 'research';
const TIMEOUT_MS = 45000;

export class ResearchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const RESEARCH_STATUS_TEXT = {
  'not-configured': 'Keine Online-Recherche verbunden',
  'no-consent': 'Online-Recherche nicht freigegeben',
  offline: 'Keine Internetverbindung',
  failed: 'Online-Recherche fehlgeschlagen',
  invalid: 'Antwort der Online-Recherche unbrauchbar',
  ok: 'Online-Recherche durchgeführt',
  skipped: 'Online-Recherche nicht verwendet'
};

// --- Konfiguration (lokal, ohne Schlüssel) -------------------------------

export function loadResearchConfig(storage = { load }) {
  const c = storage.load(CONFIG_KEY, null) || {};
  return {
    endpoint: typeof c.endpoint === 'string' ? c.endpoint : '',
    consentAt: typeof c.consentAt === 'string' ? c.consentAt : null
  };
}

export function validateEndpoint(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { throw new ResearchError('bad-url', 'Die Adresse ist ungültig.'); }
  if (u.protocol !== 'https:') throw new ResearchError('bad-url', 'Nur https://-Adressen sind erlaubt.');
  if (u.username || u.password || /[?&](key|api_?key|token)=/i.test(u.search)) {
    throw new ResearchError('bad-url', 'Die Adresse darf keine Zugangsdaten oder API-Schlüssel enthalten. Schlüssel gehören auf den Server.');
  }
  return u.href;
}

export function saveResearchConfig({ endpoint, consent }, storage = { save, remove }) {
  const ep = validateEndpoint((endpoint || '').trim());
  if (!ep) { storage.remove(CONFIG_KEY); return { endpoint: '', consentAt: null }; }
  const cfg = { endpoint: ep, consentAt: consent ? new Date().toISOString() : null };
  storage.save(CONFIG_KEY, cfg);
  return cfg;
}

// --- Anbieter ------------------------------------------------------------

export class LocalModelProvider {
  constructor() {
    this.id = 'local-model';
    this.name = 'Rechenmodell auf dem Gerät';
    this.kind = 'berechnet';
  }

  async status() { return { ok: true, code: 'ok' }; }

  run(rules) {
    const r = normalizeRules(rules);
    const calc = computeStrategy(r);
    return { rules: r, calc };
  }
}

function isHttpsUrl(s) {
  try { return new URL(s).protocol === 'https:'; } catch { return false; }
}

/** Antwort des eigenen Servers prüfen (nichts ungeprüft übernehmen). */
export function validateResearchResponse(body) {
  if (!body || typeof body !== 'object') throw new ResearchError('invalid', 'Leere oder ungültige Antwort.');
  const sources = Array.isArray(body.sources) ? body.sources : [];
  const clean = sources
    .filter((s) => s && typeof s.title === 'string' && isHttpsUrl(s.url) && typeof s.retrievedAt === 'string' && !Number.isNaN(Date.parse(s.retrievedAt)))
    .slice(0, 30)
    .map((s) => ({ title: s.title.slice(0, 200), url: s.url, retrievedAt: s.retrievedAt, excerpt: typeof s.excerpt === 'string' ? s.excerpt.slice(0, 600) : '' }));
  if (!clean.length) throw new ResearchError('invalid', 'Die Antwort enthält keine belegten Quellen (Titel, https-URL, Abrufdatum).');
  const approaches = (Array.isArray(body.approaches) ? body.approaches : [])
    .filter((a) => a && typeof a.name === 'string')
    .slice(0, 12)
    .map((a) => ({ name: a.name.slice(0, 120), summary: typeof a.summary === 'string' ? a.summary.slice(0, 1200) : '' }));
  const suggestions = (Array.isArray(body.suggestions) ? body.suggestions : [])
    .filter((s) => s && parseKey(s.key) && CODES_BY_KIND[parseKey(s.key).kind].includes(s.code))
    .slice(0, 300)
    .map((s) => ({ key: s.key, code: s.code, rationale: typeof s.rationale === 'string' ? s.rationale.slice(0, 600) : '' }));
  return {
    summary: typeof body.summary === 'string' ? body.summary.slice(0, 4000) : '',
    sources: clean,
    approaches,
    suggestions,
    model: typeof body.model === 'string' ? body.model.slice(0, 80) : null
  };
}

export class RemoteResearchProvider {
  constructor({ endpoint, consentAt, fetchImpl = (...a) => fetch(...a), online = () => navigator.onLine } = {}) {
    this.id = 'remote';
    this.name = 'Online-Recherche (eigener Server)';
    this.kind = 'ki-vorschlag';
    this.endpoint = endpoint || '';
    this.consentAt = consentAt || null;
    this.fetchImpl = fetchImpl;
    this.online = online;
  }

  async status() {
    if (!this.endpoint) return { ok: false, code: 'not-configured' };
    if (!this.consentAt) return { ok: false, code: 'no-consent' };
    if (!this.online()) return { ok: false, code: 'offline' };
    return { ok: true, code: 'ok' };
  }

  async run(rules) {
    const st = await this.status();
    if (!st.ok) throw new ResearchError(st.code, RESEARCH_STATUS_TEXT[st.code]);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Nur Regeln und gewünschtes Format – keine Bilder, keine persönlichen Daten.
        body: JSON.stringify({ task: 'blackjack-strategy-research', schema: 1, rules: normalizeRules(rules), rulesText: rulesText(rules), app: `BJ.AI ${APP_VERSION}` }),
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (err) {
      throw new ResearchError('failed', err && err.name === 'AbortError' ? 'Zeitüberschreitung bei der Online-Recherche.' : 'Der Recherche-Server ist nicht erreichbar.');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new ResearchError('failed', `Der Recherche-Server meldet Fehler ${res.status}.`);
    let body;
    try { body = await res.json(); } catch { throw new ResearchError('invalid', 'Die Antwort ist kein gültiges JSON.'); }
    return validateResearchResponse(body);
  }
}

// --- Strategie entwickeln -------------------------------------------------

const ALLOW_SETS = [
  { double: true, split: true, surrender: true, das: true },
  { double: false, split: false, surrender: false, das: false }
];

/** Code der Gesamtsumme eines Paars (so wird gespielt, wenn nicht geteilt wird). */
function pairTotalCode(key, rules) {
  const k = key ? parseKey(key) : null;
  if (!k || k.kind !== 'pair') return null;
  return k.value === 11 ? standardCode('soft', 12, k.up, rules) : standardCode('hard', 2 * k.value, k.up, rules);
}

/**
 * Zwei Codes führen unter diesen Regeln zur selben Entscheidung?
 * key (optional): Zelle; bei Paaren wird "nicht teilen" als Spiel der Summe gewertet
 * (z. B. Ph ohne DAS = Ziehen bei 2,2).
 */
export function codesEquivalent(a, b, rules, key = null) {
  if (a === b) return true;
  const r = normalizeRules(rules);
  const total = pairTotalCode(key, r);
  const res = (code, x) => {
    const out = resolveCode(code, x);
    return out === null && total ? resolveCode(total, x) : out;
  };
  return ALLOW_SETS.every((al) => {
    const x = { ...al, surrender: al.surrender && r.surrender === 'spaet', das: al.das && r.das };
    return res(a, x) === res(b, x);
  });
}

/**
 * KI-Strategie entwickeln.
 * 1. Mathematisch berechnen (immer, offline).
 * 2. Optional Online-Recherche (nur wenn verbunden und freigegeben).
 * 3. Vorschläge aus der Recherche mit dem Rechenmodell prüfen.
 * Liefert Daten für ein neues Profil (Typ "ai") – speichert selbst nichts.
 */
export async function developStrategy(rules, { remote = null, useOnline = false } = {}) {
  const r = normalizeRules(rules);
  const local = new LocalModelProvider().run(r);
  const overrides = {};
  for (const kind of Object.keys(ROWS)) {
    for (const v of ROWS[kind]) {
      if (kind !== 'pair' && v === 21) continue;
      for (const u of UPCARDS) {
        const key = cellKey(kind, v, u);
        const calcCode = local.calc.cells[key].code;
        if (!codesEquivalent(calcCode, standardCode(kind, v, u, r), r, key)) overrides[key] = calcCode;
      }
    }
  }

  let research = { status: useOnline ? 'not-configured' : 'skipped', provider: null, at: new Date().toISOString() };
  if (useOnline && remote) {
    try {
      const st = await remote.status();
      if (!st.ok) research = { ...research, status: st.code, message: RESEARCH_STATUS_TEXT[st.code] };
      else {
        const out = await remote.run(r);
        const checked = out.suggestions.map((s) => {
          const k = parseKey(s.key);
          const cell = local.calc.cells[s.key];
          const ours = cell.code;
          const agrees = codesEquivalent(ours, s.code, r, s.key);
          return { ...s, verdict: agrees ? 'bestätigt' : 'widerspricht dem Rechenmodell', modelCode: ours, kind: k.kind };
        });
        research = { status: 'ok', provider: remote.name, endpoint: remote.endpoint, model: out.model, at: new Date().toISOString(), summary: out.summary, sources: out.sources, approaches: out.approaches, suggestions: checked };
      }
    } catch (err) {
      research = { ...research, status: err.code === 'invalid' ? 'invalid' : (err.code || 'failed'), message: err.message };
    }
  }

  return {
    rules: r,
    overrides,
    data: {
      kind: 'ai',
      method: 'Rechenmodell (unendliches Deck): beste Aktion je Zelle nach exaktem Erwartungswert',
      createdWith: `BJ.AI ${APP_VERSION}`,
      computedAt: new Date().toISOString(),
      assumptions: MODEL_ASSUMPTIONS,
      limitations: [
        'Die Strategie ist im Rechenmodell bestmöglich – nicht zwingend für einen echten Schuh mit wenigen Decks.',
        'Kartenzählen und Zusammensetzung der Hand (z. B. 10,6 gegen 9,7) werden nicht berücksichtigt.',
        'Online-Vorschläge werden nur angezeigt und geprüft, nicht automatisch übernommen.'
      ],
      deviationsFromStandard: Object.keys(overrides).length,
      research
    }
  };
}
