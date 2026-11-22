// Browser-Test (Chromium über Playwright) in iPad- und iPhone-Grössen.
// Aufruf: npm run test:browser   (benötigt Playwright: npm i -D playwright)
// Prüft: Start ohne Fehler, Kamera (Testkamera), hängender Kamerastart,
// blockierte Wiedergabe, Erhalt gespeicherter Daten, Offline-Start, Layout ohne Überlauf,
// Strategieprofile (Phase 5) und Betrieb unter /blackjack-assistent/ (GitHub Pages).
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
const PAGES_PREFIX = 'blackjack-assistent/';
const outside = []; // Anfragen ausserhalb des GitHub-Pages-Unterpfads
const server = createServer(async (req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  if (req.headers.host.startsWith('127.0.0.1')) {
    // Zweiter Zugang wie GitHub Pages: nur unter /blackjack-assistent/ erreichbar.
    if (!path.startsWith(PAGES_PREFIX) && path !== PAGES_PREFIX.slice(0, -1)) { outside.push(path); res.writeHead(404); res.end('nicht gefunden'); return; }
    path = path.slice(PAGES_PREFIX.length);
  }
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
const PAGES = `http://127.0.0.1:${server.address().port}/${PAGES_PREFIX}`;

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
    check(`${name}: Version 0.5.0 angezeigt`, (await page.textContent('.footnote')).includes('0.5.0'));
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
    check('Service Worker: meldet Offline-Version', offlineVersion === 'bj-assistent-v0.5.0', String(offlineVersion));
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
  // 7) Strategieprofile: anlegen, aktivieren, wechseln ohne Neuladen, speichern, löschen
  {
    const { ctx, page, errors } = await newPage(SIZES['iPad quer']);
    await page.goto(BASE);
    await page.waitForSelector('.screen-main');
    const recWord = () => page.textContent('.rec-word');
    check('Profile: Standard ist aktiv', await page.evaluate(() => window.__bj.profiles.activeId === 'standard'));
    check('Profile: Demo empfiehlt mit Standard STEHEN (16 gegen 6)', (await recWord()).trim() === 'STEHEN');
    await page.click('.profile-tag');
    await page.waitForSelector('[data-action="new"]');
    await page.click('[data-action="new"]');
    await page.fill('input[name="name"]', 'Testprofil');
    await page.fill('textarea[name="description"]', 'Browser-Test');
    await page.click('[data-action="create-new"]');
    await page.waitForSelector('.strategy-table');
    check('Profile: neues Profil öffnet den Editor', true);
    // Zelle hart 16 gegen 6 auf Ziehen setzen (über die Tabelle)
    await page.click('[data-action="cell"][data-key="hard:16:6"]');
    await page.click('[data-action="set-code"][data-code="H"]');
    const own = await page.evaluate(() => {
      const p = window.__bj.profiles.list().find((x) => x.name === 'Testprofil');
      return p && p.overrides['hard:16:6'];
    });
    check('Profile: Zelle in der Tabelle geändert', own === 'H', String(own));
    await page.evaluate(() => { const b = document.querySelector('[data-action="close-sheet"]'); if (b) b.click(); });
    await page.click('[data-action="activate"]');
    const active = await page.evaluate(() => window.__bj.profiles.active.name);
    check('Profile: Testprofil aktiviert', active === 'Testprofil', active);
    const loads = [];
    page.on('load', () => loads.push(1));
    await page.evaluate(() => window.__bj.navigate('haupt'));
    await page.waitForSelector('.screen-main');
    check('Profile: Empfehlung folgt dem aktiven Profil ohne Neuladen', (await recWord()).trim() === 'ZIEHEN' && loads.length === 0);
    check('Profile: Hauptansicht zeigt Profilnamen', (await page.textContent('.profile-tag')).includes('Testprofil'));
    // Wechsel zurück zu Standard ohne Neuladen
    await page.evaluate(() => window.__bj.profiles.activate('standard'));
    await page.waitForFunction(() => document.querySelector('.rec-word')?.textContent.trim() === 'STEHEN', null, { timeout: 3000 }).catch(() => {});
    check('Profile: Zurückwechseln aktualisiert sofort', (await recWord()).trim() === 'STEHEN');
    await page.evaluate(() => { const p = window.__bj.profiles.list().find((x) => x.name === 'Testprofil'); window.__bj.profiles.activate(p.id); });
    // Speichern + Wiederherstellen
    await page.reload();
    await page.waitForSelector('.screen-main');
    const after = await page.evaluate(() => ({ n: window.__bj.profiles.list().length, active: window.__bj.profiles.active.name }));
    check('Profile: nach Neuladen wiederhergestellt', after.n === 2 && after.active === 'Testprofil', JSON.stringify(after));
    // Aktives Profil kann nicht gelöscht werden
    await page.click('.profile-tag');
    await page.waitForSelector('.profile-card');
    const activeCard = page.locator('.profile-card.is-active');
    check('Profile: aktives Profil hat keinen Löschen-Knopf', (await activeCard.locator('[data-action="delete"]').count()) === 0);
    check('Profile: aktives Profil klar markiert', (await activeCard.textContent()).includes('AKTIV'));
    // Standard aktivieren, dann Testprofil löschen (zwei Tipps)
    await page.click('.profile-card:not(.is-active) [data-action="activate"]');
    await page.click('.profile-card:not(.is-active) [data-action="delete"]');
    const stillThere = await page.evaluate(() => window.__bj.profiles.list().length);
    check('Profile: Löschen braucht Bestätigung', stillThere === 2);
    await page.click('.profile-card:not(.is-active) [data-action="delete"]');
    const left = await page.evaluate(() => window.__bj.profiles.list().map((p) => p.id));
    check('Profile: nach Bestätigung gelöscht', left.length === 1 && left[0] === 'standard', left.join(','));
    // KI-Strategie ohne Server: berechnet lokal, zeigt offen "nicht eingerichtet"
    await page.click('[data-action="ai"]');
    await page.waitForSelector('[data-action="ai-run"]');
    const sheetText = await page.textContent('.sheet');
    check('KI: Online-Recherche ehrlich als nicht eingerichtet angezeigt', /Keine Online-Recherche verbunden/.test(sheetText) && /täuscht keine Recherche vor/.test(sheetText));
    check('KI: Online-Option ohne Server gesperrt', await page.isDisabled('[data-action="ai-online"]'));
    await page.click('[data-action="ai-run"]');
    await page.waitForSelector('[data-action="ai-activate"]', { timeout: 15000 });
    const ai = await page.evaluate(() => window.__bj.profiles.list().find((p) => p.type === 'ai'));
    check('KI: Profil gespeichert (Typ KI, lokal berechnet)', !!ai && ai.data.research.status !== 'ok', ai ? ai.data.research.status : 'fehlt');
    await page.click('[data-action="close-sheet"]');
    check('KI: Profilkarte visuell abgehoben', (await page.locator('.profile-card--ai').count()) === 1);
    check('Profile: keine JavaScript-Fehler', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // 8) Migration: Daten aus v0.4.0 (ohne Profile) -> Standard aktiv, Tischregeln bleiben
  {
    const { ctx, page } = await newPage(SIZES['iPad hoch'], () => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.clear();
      localStorage.setItem('bjassist.settings', JSON.stringify({ roundMode: 'manuell', speech: false, demo: true, rules: { decks: 6, soft17: 'zieht', das: true, surrender: 'keine', payout: '3:2' }, camera: { fps: 30, keepAwake: true }, recognition: { fps: 4, showBoxes: true } }));
    });
    await page.goto(BASE);
    await page.waitForSelector('.screen-main');
    const m = await page.evaluate(() => ({ active: window.__bj.profiles.activeId, n: window.__bj.profiles.list().length, s17: window.__bj.settings.get('rules.soft17'), mode: window.__bj.settings.get('roundMode') }));
    check('Migration 0.4.0: Standardprofil aktiv, Einstellungen unverändert', m.active === 'standard' && m.n === 1 && m.s17 === 'zieht' && m.mode === 'manuell', JSON.stringify(m));
    // Ohne Aufgeben-Regel: 16 gegen 10 = Ziehen statt Aufgeben
    await page.evaluate(() => { for (let i = 0; i < 4; i++) document.querySelector('[data-action="next-demo"]').click(); });
    check('Regeln: ohne Aufgeben wird 16 gegen 10 zu ZIEHEN', (await page.textContent('.rec-word')).trim() === 'ZIEHEN');
    await ctx.close();
  }

  // 9) GitHub Pages: App unter /blackjack-assistent/ inkl. Service Worker und offline
  {
    outside.length = 0;
    const { ctx, page, errors } = await newPage(SIZES['iPad quer']);
    await page.goto(PAGES);
    const ok = await page.waitForSelector('.screen-main', { timeout: 8000 }).then(() => true).catch(() => false);
    check('GitHub Pages: App startet unter /blackjack-assistent/', ok);
    const scope = await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.scope, null, { timeout: 10000 })
      .then((h) => h.jsonValue()).catch(() => null);
    check('GitHub Pages: Service Worker im Unterpfad registriert', !!scope && scope.endsWith('/blackjack-assistent/'), String(scope));
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
    await page.click('.profile-tag');
    await page.waitForSelector('.profile-card');
    check('GitHub Pages: Strategieprofile erreichbar', true);
    await ctx.setOffline(true);
    await page.reload();
    const off = await page.waitForSelector('.screen-main', { timeout: 6000 }).then(() => true).catch(() => false);
    check('GitHub Pages: offline startbar', off);
    await ctx.setOffline(false);
    check('GitHub Pages: keine Anfragen ausserhalb des Unterpfads', outside.length === 0, outside.join(', '));
    check('GitHub Pages: keine JavaScript-Fehler', errors.length === 0, errors.join(' | '));
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
