// Schnittstelle zum EIGENEN Yumeko-Server (Phase 8.2) – vorbereitet, nicht eingerichtet.
//
// Warum ein Server? Ein Browser darf YouTube-Untertitel und -Videobilder nicht direkt lesen
// (fremde Herkunft, keine öffentliche Schnittstelle für Transkripte). Ein eigener Server kann
// zulässige Quellen nutzen (z. B. YouTube Data API für Titel/Kanal; Transkripte nur dort, wo das
// erlaubt ist). API-Schlüssel liegen NUR auf diesem Server – nie im Browsercode und nie im
// Speicher der App. Referenz-Server und Einrichtung: server/README.md.
//
// Was gesendet wird: nur die Video-ID und die App-Version. Keine Spielrunden, keine Kamerabilder,
// keine persönlichen Daten. Der Server soll nichts dauerhaft speichern.
// Ohne eingetragene Adresse wird nichts gesendet; die App sagt dann offen „nicht verfügbar“.
import { load, save, remove } from '../core/store.js';
import { APP_VERSION } from '../core/version.js';
import { VIDEO_ID_RE } from './youtube.js';

const CONFIG_KEY = 'academy.server';
export const SERVER_TIMEOUT_MS = 60000;
export const SERVER_SCHEMA = 1;
export const MAX_TRANSCRIPT_CHARS = 200000;

export class ServerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function loadServerConfig(storage = { load }) {
  const c = storage.load(CONFIG_KEY, null) || {};
  return {
    endpoint: typeof c.endpoint === 'string' ? c.endpoint : '',
    enabledAt: typeof c.enabledAt === 'string' ? c.enabledAt : null
  };
}

export function validateServerEndpoint(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { throw new ServerError('bad-url', 'Die Adresse ist ungültig.'); }
  if (u.protocol !== 'https:') throw new ServerError('bad-url', 'Nur https://-Adressen sind erlaubt.');
  if (u.username || u.password || /[?&](key|api_?key|token|secret)=/i.test(u.search)) {
    throw new ServerError('bad-url', 'Die Adresse darf keine Zugangsdaten oder API-Schlüssel enthalten. Schlüssel gehören auf den Server.');
  }
  return u.href;
}

/**
 * Adresse speichern. Mit dem Eintragen stimmt der Benutzer zu, dass für neue Links die
 * Video-ID an diesen Server geht (einmalige Zustimmung, danach automatisch).
 */
export function saveServerConfig({ endpoint }, storage = { save, remove }) {
  const ep = validateServerEndpoint((endpoint || '').trim());
  if (!ep) { storage.remove(CONFIG_KEY); return { endpoint: '', enabledAt: null }; }
  const cfg = { endpoint: ep, enabledAt: new Date().toISOString() };
  storage.save(CONFIG_KEY, cfg);
  return cfg;
}

/** Antwort des Servers streng prüfen. Fehlende Teile gelten als "nicht verfügbar". */
export function validateServerResponse(x, videoId) {
  if (!x || typeof x !== 'object') throw new ServerError('invalid', 'Antwort des Servers unbrauchbar.');
  if (x.videoId && x.videoId !== videoId) throw new ServerError('invalid', 'Der Server hat ein anderes Video geliefert.');
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  const meta = {
    title: str(x.title, 300),
    channel: str(x.channel, 200),
    durationSec: Number.isFinite(x.durationSec) && x.durationSec >= 0 ? x.durationSec : null,
    publishedAt: str(x.publishedAt, 40),
    language: str(x.language, 20)
  };
  const t = x.transcript && typeof x.transcript === 'object' ? x.transcript : {};
  let segments = [];
  let chars = 0;
  if (t.available === true && Array.isArray(t.segments)) {
    for (const s of t.segments) {
      if (!s || typeof s.text !== 'string') continue;
      const text = s.text.slice(0, 2000);
      chars += text.length;
      if (chars > MAX_TRANSCRIPT_CHARS) break;
      segments.push({ start: Number.isFinite(s.start) && s.start >= 0 ? s.start : null, text });
    }
  }
  if (!segments.length) segments = [];
  const transcript = segments.length
    ? { available: true, source: 'server', language: str(t.language, 20) || meta.language, kind: str(t.kind, 30), segments }
    : { available: false, reason: str(t.reason, 300) || 'Der Server hat kein Transkript geliefert.' };
  const f = x.frames && typeof x.frames === 'object' ? x.frames : {};
  const frames = f.available === true && Array.isArray(f.observations)
    ? { available: true, observations: f.observations.filter((o) => o && typeof o.text === 'string').slice(0, 200).map((o) => ({ at: Number.isFinite(o.at) ? o.at : null, text: o.text.slice(0, 500) })) }
    : { available: false, reason: str(f.reason, 300) || 'Keine Videobildanalyse vom Server.' };
  return { meta, transcript, frames, provider: str(x.provider, 120) };
}

/**
 * Video beim eigenen Server anfragen.
 * @returns {Promise<{ meta, transcript, frames, provider }>}
 */
export async function fetchVideoData(videoId, { config = loadServerConfig(), fetchImpl = globalThis.fetch, online = globalThis.navigator ? globalThis.navigator.onLine !== false : true, timeoutMs = SERVER_TIMEOUT_MS } = {}) {
  if (!VIDEO_ID_RE.test(videoId || '')) throw new ServerError('bad-id', 'Ungültige Video-ID.');
  if (!config.endpoint) throw new ServerError('not-configured', 'Kein Yumeko-Server eingerichtet.');
  if (!online) throw new ServerError('offline', 'Keine Internetverbindung.');
  if (typeof fetchImpl !== 'function') throw new ServerError('failed', 'Netzwerk nicht verfügbar.');
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'youtube-video', schema: SERVER_SCHEMA, videoId, want: ['metadata', 'transcript', 'frames'], app: `BJ.AI ${APP_VERSION}` }),
      credentials: 'omit',
      cache: 'no-store',
      ...(ctrl ? { signal: ctrl.signal } : {})
    });
  } catch (err) {
    throw new ServerError(err && err.name === 'AbortError' ? 'timeout' : 'failed', err && err.name === 'AbortError' ? 'Der Server antwortet nicht (Zeitlimit).' : 'Der Server ist nicht erreichbar.');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) throw new ServerError('failed', `Der Server meldet einen Fehler (HTTP ${res.status}).`);
  let data;
  try { data = await res.json(); } catch { throw new ServerError('invalid', 'Antwort des Servers ist kein gültiges JSON.'); }
  return validateServerResponse(data, videoId);
}
