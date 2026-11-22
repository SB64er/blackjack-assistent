// YouTube-Links prüfen und die Video-ID ermitteln (Phase 8.2). Reine Logik -> testbar.
// Es werden nur echte YouTube-Adressen angenommen; aus dem Link wird nichts abgerufen.

const HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com'
]);
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export class LinkError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * YouTube-Link prüfen.
 * @returns {{ ok: true, videoId, url, start } | { ok: false, code, error }}
 */
export function parseYouTubeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, code: 'empty', error: 'Bitte einen YouTube-Link einfügen.' };
  if (raw.length > 2000) return { ok: false, code: 'too-long', error: 'Der Link ist zu lang.' };
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, code: 'invalid', error: 'Das ist kein gültiger Link.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, code: 'protocol', error: 'Nur http(s)-Links werden angenommen.' };
  const host = u.hostname.toLowerCase();
  if (!HOSTS.has(host)) return { ok: false, code: 'not-youtube', error: 'Das ist kein YouTube-Link.' };
  let id = null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (host.endsWith('youtu.be')) id = parts[0] || null;
  else if (u.pathname === '/watch') id = u.searchParams.get('v');
  else if (['shorts', 'embed', 'live', 'v', 'e'].includes(parts[0])) id = parts[1] || null;
  if (!id) {
    if (parts[0] === 'playlist' || u.searchParams.get('list')) return { ok: false, code: 'playlist', error: 'Playlists werden nicht unterstützt – bitte den Link eines einzelnen Videos einfügen.' };
    if (parts[0] === 'channel' || parts[0] === 'c' || parts[0] === 'user' || (parts[0] || '').startsWith('@')) return { ok: false, code: 'channel', error: 'Das ist ein Kanal-Link – bitte den Link eines einzelnen Videos einfügen.' };
    return { ok: false, code: 'no-id', error: 'Im Link wurde keine Video-ID gefunden.' };
  }
  if (!VIDEO_ID_RE.test(id)) return { ok: false, code: 'bad-id', error: 'Die Video-ID im Link ist ungültig.' };
  const t = u.searchParams.get('t') || u.searchParams.get('start');
  const start = t ? parseStart(t) : null;
  return { ok: true, videoId: id, url: `https://www.youtube.com/watch?v=${id}`, start };
}

function parseStart(t) {
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

/** Link zur Stelle im Video (zum Öffnen der Quelle). */
export function videoLink(videoId, seconds = null) {
  if (!VIDEO_ID_RE.test(videoId || '')) return null;
  const s = Number.isFinite(seconds) && seconds > 0 ? `&t=${Math.floor(seconds)}s` : '';
  return `https://www.youtube.com/watch?v=${videoId}${s}`;
}

/** Zeitstempel als m:ss oder h:mm:ss. */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
