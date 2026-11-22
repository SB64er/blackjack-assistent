// Browser-Test (Chromium über Playwright) in iPad- und iPhone-Grössen.
// Aufruf: npm run test:browser   (benötigt Playwright: npm i -D playwright)
// Prüft: Start ohne Fehler, Kamera (Testkamera), hängender Kamerastart,
// blockierte Wiedergabe, Erhalt gespeicherter Daten, Offline-Start, Layout ohne Überlauf.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

let swSuffix = ''; // simuliert eine neue Version von sw.js
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try {
    const file = path || 'index.html';
    let body = await readFile(join(ROOT, file));
    if (file === 'sw.js' && swSuffix) body = Buffer.concat([body, Buffer.from(swSuffix)]);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('nicht gefunden');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}/`;

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(`${ok ? '✓' : '✗'} ${name}${info ? ` – ${info}` : ''}`); };

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const SIZES = { 'iPad hoch': [820, 1180], 'iPad quer': [1180, 820], 'iPad Pro quer': [1366, 1024], iPhone: [390, 844], 'iPhone quer': [844, 390] };

async function newPage(size, init) {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, hasTouch: true, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (init) await page.addInitScript(init);
  return { ctx, page, errors };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

try {
  // 1) Layout in allen Grössen, Kamera starten
  for (const [name, size] of Object.entries(SIZES)) {
    const { ctx, page, errors } = await newPage(size);
    await page.goto(BASE);
    await page.waitForSelector('.screen-main');
    check(`${name}: Hauptansicht ohne seitlichen Überlauf`, !(await overflow(page)));
    await page.click('[data-nav="kamera"]');
    await page.click('[data-camera="start"]');
    await page.waitForFunction(() => window.__bj.camera.state === 'active', null, { timeout: 8000 });
    check(`${name}: Kamera startet`, true);
    check(`${name}: Kamera-Ansicht ohne Überlauf`, !(await overflow(page)));
    await page.click('[data-nav="haupt"]');
    await page.click('[data-nav="einstellungen"]');
    check(`${name}: Version 0.4.0 angezeigt`, (await page.textContent('.footnote')).includes('0.4.0'));
    check(`${name}: keine JavaScript-Fehler`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // 2) Hängender Kamerastart (iPad-Home-Bildschirm-App) -> erneut versuchen + Fehlermeldung
  {
    const { ctx, page } = await newPage(SIZES['iPad hoch'], () => {
      navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
    });
    await page.goto(BASE);
    await page.click('[data-nav="kamera"]');
    await page.click('[data-camera="start"]');
    await page.waitForSelector('[data-camera="retry"]', { timeout: 6000 });
    check('Hängender Start: "erneut versuchen" erscheint', true);
    await page.waitForFunction(() => window.__bj.camera.state === 'error', null, { timeout: 12000 });
    check('Hängender Start: Fehlermeldung statt endlos "startet"', (await page.textContent('.cam-panel')).includes('Kamera antwortet nicht'));
    await ctx.close();
  }

  // 3) Blockierte Wiedergabe (schwarzes Bild ohne Fehler) -> Tipp-Knopf
  {
    const { ctx, page } = await newPage(SIZES['iPad quer'], () => {
      const orig = HTMLMediaElement.prototype.play;
      let blocked = true;
      HTMLMediaElement.prototype.play = function () {
        if (blocked) return Promise.reject(new DOMException('blockiert', 'NotAllowedError'));
        return orig.call(this);
      };
      window.__unblock = () => { blocked = false; };
    });
    await page.goto(BASE);
    await page.click('[data-nav="kamera"]');
    await page.click('[data-camera="start"]');
    await page.waitForSelector('.tap-to-play', { timeout: 8000 });
    check('Blockierte Wiedergabe: Knopf "Kamerabild anzeigen" erscheint', true);
    // Echtes iOS gibt die Wiedergabe erst im Tipp frei: beides im selben Schritt.
    await page.evaluate(() => { window.__unblock(); const b = document.querySelector('.tap-to-play'); if (b) b.click(); });
    await page.waitForFunction(() => !window.__bj.camera.playBlocked, null, { timeout: 5000 });
    check('Blockierte Wiedergabe: Tipp gibt das Bild frei', !(await page.$('.tap-to-play')));
    await ctx.close();
  }

  // 4) Gespeicherte Daten aus v0.3.0 bleiben erhalten
  {
    const { ctx, page } = await newPage(SIZES['iPad hoch'], () => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('bjassist.settings', JSON.stringify({ roundMode: 'automatisch', speech: false, demo: false, rules: { decks: 8, soft17: 'zieht', das: false, surrender: 'keine', payout: '6:5' }, camera: { fps: 15, keepAwake: false }, recognition: { fps: 2, showBoxes: false } }));
      localStorage.setItem('bjassist.calibration', JSON.stringify({ version: 1, savedAt: '2026-11-21T22:18:39Z', frame: { width: 1920, height: 1080, aspect: 1.778, orientation: 'landscape' }, regions: { dealerUp: { x: 0.38, y: 0.12, w: 0.1, h: 0.22 }, dealerHole: { x: 0.5, y: 0.12, w: 0.1, h: 0.22 }, player: { x: 0.28, y: 0.56, w: 0.34, h: 0.28 }, split: { x: 0.64, y: 0.56, w: 0.3, h: 0.28 } }, splitEnabled: false }));
      localStorage.setItem('bjassist.templates', JSON.stringify({ version: 1, consent: true, consentAt: '2026-11-21T22:00:00Z', items: [{ id: 'a1', rank: 'A', bits: btoa(String.fromCharCode(...new Uint8Array(70).fill(15))), aspect: 0.7, hRel: 0.03, suitRatio: 0.6, createdAt: '2026-11-21T22:00:00Z' }] }));
    });
    await page.goto(BASE);
    const s = await page.evaluate(() => ({
      cal: !!window.__bj.calibration.saved,
      tpl: window.__bj.templates.items.length,
      consent: window.__bj.templates.consent,
      decks: window.__bj.settings.get('rules.decks'),
      mode: window.__bj.settings.get('roundMode'),
      fps: window.__bj.settings.get('camera.fps')
    }));
    check('Daten: Kalibrierung geladen', s.cal);
    check('Daten: angelernte Muster + Zustimmung geladen', s.tpl === 1 && s.consent);
    check('Daten: Einstellungen unverändert', s.decks === 8 && s.mode === 'automatisch' && s.fps === 15);
    await ctx.close();
  }

  // 5) Service Worker: offline starten
  {
    const { ctx, page } = await newPage(SIZES['iPad quer']);
    await page.goto(BASE);
    // Erstinstallation übernimmt die Seite sofort (clients.claim).
    const controlled = await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 })
      .then(() => true).catch(() => false);
    check('Service Worker: übernimmt beim ersten Start', controlled);
    const offlineVersion = await page.waitForFunction(() => window.__bj.updates.offlineVersion, null, { timeout: 5000 })
      .then((h) => h.jsonValue()).catch(() => null);
    check('Service Worker: meldet Offline-Version', offlineVersion === 'bj-assistent-v0.4.0', String(offlineVersion));
    await ctx.setOffline(true);
    await page.reload();
    const ok = await page.waitForSelector('.screen-main', { timeout: 5000 }).then(() => true).catch(() => false);
    check('Offline: App startet ohne Netz', ok);
    await ctx.setOffline(false);

    // 6) Update: neue Version wird angeboten und erst nach Tipp aktiv
    swSuffix = '\n// neue Version (Test)\n';
    await page.evaluate(() => window.__bj.updates.check());
    const offered = await page.waitForSelector('.update-bar:not([hidden])', { timeout: 10000 }).then(() => true).catch(() => false);
    check('Update: Hinweis "Neue Version verfügbar" erscheint', offered);
    if (offered) {
      const nav = page.waitForEvent('load', { timeout: 10000 }).then(() => true).catch(() => false);
      await page.click('[data-app="update-apply"]');
      check('Update: "Aktualisieren" lädt die neue Version', await nav);
      await page.waitForSelector('.screen-main');
      const waiting = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting);
      check('Update: keine Version wartet mehr', !waiting);
    }
    swSuffix = '';
    await ctx.close();
  }
} catch (err) {
  check('Unerwarteter Abbruch', false, err.message);
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
process.exit(failed.length ? 1 : 0);
