// Logik-Tests ohne Browser: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { containRect, clampRect, moveRect, resizeRect, isValidRect, orientationOf, aspectMatches } from '../js/calibration/geometry.js';
import { handInfo, upcardLabel, valueClass } from '../js/game/hand.js';
import { RoundTracker, signatureOf } from '../js/recognition/round-tracker.js';
import { similarity, packBits, unpackBits, GLYPH_SIZE } from '../js/recognition/vision.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const c = (rank) => ({ rank, confident: true });

test('Version: sw.js, version.js und package.json passen zusammen', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const ver = readFileSync(join(ROOT, 'js/core/version.js'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const swV = sw.match(/const VERSION = 'bj-assistent-v([\d.]+)'/)[1];
  const appV = ver.match(/APP_VERSION = '([\d.]+)/)[1];
  assert.equal(swV, appV);
  assert.equal(pkg.version, appV);
});

test('Service Worker: alle App-Dateien sind offline gespeichert und existieren', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const list = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
  for (const f of list) assert.ok(existsSync(join(ROOT, f)), `fehlt: ${f}`);
  const walk = (d) => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const appFiles = [...walk(join(ROOT, 'js')), ...walk(join(ROOT, 'css')), ...walk(join(ROOT, 'icons'))]
    .map((p) => relative(ROOT, p).split('\\').join('/'));
  for (const f of appFiles) assert.ok(list.includes(f), `nicht im Service Worker (ASSETS): ${f}`);
});

test('Geometrie: Bild im Container (contain)', () => {
  const r = containRect(1000, 1000, 1920, 1080);
  assert.equal(Math.round(r.width), 1000);
  assert.equal(Math.round(r.height), 563);
  assert.equal(Math.round(r.top), 219);
  assert.equal(containRect(0, 10, 10, 10), null);
});

test('Geometrie: Rechtecke bleiben im Bild', () => {
  assert.deepEqual(clampRect({ x: 0.9, y: -0.2, w: 0.3, h: 0.5 }), { x: 0.7, y: 0, w: 0.3, h: 0.5 });
  const m = moveRect({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, 2, 2);
  assert.ok(isValidRect(m));
  const r = resizeRect({ x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, 'se', -1, -1);
  assert.ok(r.w >= 0.03 && r.h >= 0.03);
  assert.equal(orientationOf(1920, 1080), 'landscape');
  assert.ok(aspectMatches(1.777, 1.778));
});

test('Hand: Werte, Soft, Paar, Blackjack', () => {
  assert.equal(handInfo([c('A'), c('K')]).text, 'Blackjack');
  assert.equal(handInfo([c('A'), c('7'), c('2')]).text, 'Soft 20');
  assert.equal(handInfo([c('10'), c('6')]).text, 'Hart 16');
  assert.equal(handInfo([c('8'), c('8')]).text, 'Paar 8');
  assert.equal(handInfo([c('A'), c('A')]).text, 'Paar Asse');
  assert.equal(handInfo([c('K'), c('Q'), c('5')]).bust, true);
  assert.equal(handInfo([c('A'), c('A'), c('9')]).total, 21);
  assert.equal(handInfo([{ rank: '?', confident: false }, c('9')]).total, null);
  assert.equal(upcardLabel(c('A')), '1/11');
  assert.equal(valueClass('Q'), '10');
});

test('Runden: stabile Erkennung, neue Runde, gezogene Karte', () => {
  const t = new RoundTracker({ auto: true });
  const raw = (player) => ({ dealerUp: c('6'), dealerHole: null, player: player.map(c), split: [], unsure: false, cardFaceWithoutRank: false });
  let r = t.push(raw(['10', '6']), 0);
  assert.equal(r.state.stable, false);
  r = t.push(raw(['10', '6']), 250);
  assert.equal(r.state.stable, true);
  assert.deepEqual(r.events.map((e) => e.type), ['round-start']);
  t.push(raw(['10', '6', '3']), 500);
  r = t.push(raw(['10', '6', '3']), 750);
  assert.deepEqual(r.events.map((e) => e.type), ['card-added']);
  assert.equal(signatureOf(raw(['A'])), '6|A||');
});

test('Muster: Packen/Entpacken und Ähnlichkeit', () => {
  const bits = new Uint8Array(GLYPH_SIZE);
  for (let i = 0; i < GLYPH_SIZE; i += 3) bits[i] = 1;
  const back = unpackBits(packBits(bits));
  assert.deepEqual([...back], [...bits]);
  assert.equal(similarity(bits, bits), 1);
});
