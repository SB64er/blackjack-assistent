// Referenz-Server (server/yumeko-server.mjs) zusammen mit dem App-Client testen. Kein Netz nach aussen:
// ohne YT_API_KEY werden keine Metadaten geholt; das Transkript kommt aus einer lokalen Testdatei.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'yumeko-'));
await writeFile(join(dir, 'dQw4w9WgXcQ.txt'), '0:05 Always split aces and eights.\n0:20\nNever take insurance.\n');
process.env.TRANSCRIPT_DIR = dir;
process.env.ALLOWED_ORIGINS = 'https://example.github.io';
delete process.env.YT_API_KEY;
const { server, parseTranscriptText, isoDurationToSec } = await import('../server/yumeko-server.mjs');
const { fetchVideoData } = await import('../js/academy/server-client.js');

test('Server: Hilfsfunktionen', () => {
  assert.equal(isoDurationToSec('PT1H2M3S'), 3723);
  assert.deepEqual(parseTranscriptText('1:00 Hallo\nWelt'), [{ start: 60, text: 'Hallo' }, { start: 60, text: 'Welt' }]);
});

test('Server + Client: Transkript aus zulässiger Datei, keine erfundenen Metadaten oder Bildanalyse', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    // Der Client erlaubt nur https; für den lokalen Test wird fetch auf http umgeleitet.
    const fetchImpl = (url, opts) => fetch(url.replace('https://srv.test/', `http://127.0.0.1:${port}/`), opts);
    const r = await fetchVideoData('dQw4w9WgXcQ', { config: { endpoint: 'https://srv.test/' }, fetchImpl, online: true });
    assert.equal(r.transcript.available, true);
    assert.equal(r.transcript.segments.length, 2);
    assert.equal(r.transcript.segments[1].start, 20);
    assert.equal(r.meta.title, null);
    assert.equal(r.frames.available, false);
    const none = await fetchVideoData('aaaaaaaaaaa', { config: { endpoint: 'https://srv.test/' }, fetchImpl, online: true });
    assert.equal(none.transcript.available, false);
    // fremde Herkunft wird abgelehnt
    const bad = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 403);
    const badId = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: JSON.stringify({ task: 'youtube-video', videoId: '../etc' }) });
    assert.equal(badId.status, 400);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
