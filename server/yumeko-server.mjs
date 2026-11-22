// Referenz-Server für die Yumeko Academy (Phase 8.2). Node.js 18+, keine Abhängigkeiten.
//
// Aufgabe: zu einer YouTube-Video-ID Metadaten und – nur aus zulässiger Quelle – ein Transkript liefern.
// - Metadaten: YouTube Data API v3 (videos.list), nur wenn YT_API_KEY gesetzt ist. Der Schlüssel bleibt
//   auf dem Server (Umgebungsvariable) und wird nie an die App zurückgegeben.
// - Transkript: nur aus Dateien in TRANSCRIPT_DIR (<videoId>.json oder <videoId>.txt), die der Betreiber
//   rechtmässig beschafft hat (z. B. eigene Videos, vom Rechteinhaber bereitgestellte Untertitel).
//   Dieser Server liest KEINE Untertitel von youtube.com aus (kein Scraping, keine inoffiziellen Schnittstellen).
// - Videobildanalyse: nicht vorhanden. Der Server antwortet ehrlich mit available:false.
// Gespeichert wird nichts: keine Datenbank, keine Logdatei mit Video-IDs, nur ein Zähler im Arbeitsspeicher
// für die Ratenbegrenzung.
//
// Start:  ALLOWED_ORIGINS=https://sb64er.github.io YT_API_KEY=... TRANSCRIPT_DIR=./transcripts node server/yumeko-server.mjs
// Details: server/README.md
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 8787);
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const YT_API_KEY = process.env.YT_API_KEY || '';
const TRANSCRIPT_DIR = process.env.TRANSCRIPT_DIR || '';
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 20);
const MAX_BODY = 4096;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const hits = new Map(); // ip -> { count, resetAt } (nur Arbeitsspeicher)
function rateLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.resetAt < now) { hits.set(ip, { count: 1, resetAt: now + 60000 }); return false; }
  h.count += 1;
  return h.count > RATE_PER_MIN;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k); }, 60000).unref();

export function isoDurationToSec(s) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || '');
  if (!m) return null;
  return ((+m[1] || 0) * 86400) + ((+m[2] || 0) * 3600) + ((+m[3] || 0) * 60) + (+m[4] || 0);
}

/** Textdatei: Zeilen "m:ss Text" oder nur Text. */
export function parseTranscriptText(txt) {
  const segments = [];
  let start = null;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,]\d+)?\s*(.*)$/.exec(line);
    if (m) {
      start = (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]);
      if (m[4]) segments.push({ start, text: m[4] });
    } else {
      segments.push({ start, text: line });
    }
  }
  return segments;
}

async function metadata(videoId) {
  if (!YT_API_KEY) return { note: 'Keine Metadaten: YT_API_KEY ist auf dem Server nicht gesetzt.' };
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${encodeURIComponent(YT_API_KEY)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`YouTube Data API: HTTP ${res.status}`);
  const data = await res.json();
  const item = data.items && data.items[0];
  if (!item) return { note: 'Video nicht gefunden oder nicht öffentlich.' };
  return {
    title: item.snippet.title,
    channel: item.snippet.channelTitle,
    publishedAt: item.snippet.publishedAt,
    language: item.snippet.defaultAudioLanguage || item.snippet.defaultLanguage || null,
    durationSec: isoDurationToSec(item.contentDetails.duration)
  };
}

async function transcript(videoId) {
  if (!TRANSCRIPT_DIR) return { available: false, reason: 'Kein Transkript: Auf dem Server ist keine zulässige Transkriptquelle eingerichtet.' };
  try {
    const j = JSON.parse(await readFile(join(TRANSCRIPT_DIR, `${videoId}.json`), 'utf8'));
    if (Array.isArray(j.segments) && j.segments.length) return { available: true, language: j.language || null, kind: j.kind || 'bereitgestellt', segments: j.segments };
  } catch { /* keine JSON-Datei */ }
  try {
    const segments = parseTranscriptText(await readFile(join(TRANSCRIPT_DIR, `${videoId}.txt`), 'utf8'));
    if (segments.length) return { available: true, language: null, kind: 'bereitgestellt', segments };
  } catch { /* keine Textdatei */ }
  return { available: false, reason: 'Für dieses Video liegt auf dem Server kein zulässiges Transkript vor.' };
}

function send(res, status, body, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (origin) { headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin'; }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

export const server = createServer(async (req, res) => {
  const origin = req.headers.origin && ORIGINS.includes(req.headers.origin) ? req.headers.origin : null;
  if (req.method === 'OPTIONS') {
    if (!origin) { res.writeHead(403); res.end(); return; }
    res.writeHead(204, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
    res.end();
    return;
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Nur POST.' }, origin);
  if (req.headers.origin && !origin) return send(res, 403, { error: 'Herkunft nicht erlaubt.' }, null);
  const ip = req.socket.remoteAddress || '?';
  if (rateLimited(ip)) return send(res, 429, { error: 'Zu viele Anfragen.' }, origin);
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > MAX_BODY) return send(res, 413, { error: 'Anfrage zu gross.' }, origin); }
  let q;
  try { q = JSON.parse(body); } catch { return send(res, 400, { error: 'Ungültiges JSON.' }, origin); }
  if (!q || q.task !== 'youtube-video' || !VIDEO_ID_RE.test(q.videoId || '')) return send(res, 400, { error: 'Ungültige Anfrage.' }, origin);
  try {
    const [meta, tr] = await Promise.all([metadata(q.videoId), transcript(q.videoId)]);
    send(res, 200, {
      videoId: q.videoId,
      title: meta.title ?? null,
      channel: meta.channel ?? null,
      durationSec: meta.durationSec ?? null,
      publishedAt: meta.publishedAt ?? null,
      language: meta.language ?? null,
      transcript: tr,
      frames: { available: false, reason: 'Dieser Server analysiert keine Videobilder.' },
      provider: `Yumeko-Referenzserver${YT_API_KEY ? ' + YouTube Data API' : ''}`
    }, origin);
  } catch (err) {
    send(res, 502, { error: String(err && err.message || err).slice(0, 200) }, origin);
  }
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  server.listen(PORT, () => console.log(`Yumeko-Server auf Port ${PORT} (Herkünfte: ${ORIGINS.join(', ') || 'keine – Browser-Anfragen werden abgelehnt'})`));
}
