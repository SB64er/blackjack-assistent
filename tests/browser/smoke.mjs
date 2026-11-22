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
    check(`${name}: Version 0.8.0 angezeigt`, (await page.textContent('.footnote')).includes('0.8.0'));
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
      calV: window.__bj.calibration.saved && window.__bj.calibration.saved.version,
      dealer: window.__bj.calibration.saved && window.__bj.calibration.saved.regions.dealer,
      backup: !!localStorage.getItem('bjassist.calibration.v1backup'),
      tpl: window.__bj.templates.items.length,
      consent: window.__bj.templates.consent,
      decks: window.__bj.settings.get('rules.decks'),
      mode: window.__bj.settings.get('roundMode'),
      fps: window.__bj.settings.get('camera.fps')
    }));
    check('Daten: Kalibrierung geladen', s.cal);
    check('Migration: zwei Dealer-Felder -> ein Dealer-Feld (mit Sicherung)', s.calV === 2 && !!s.dealer && Math.abs(s.dealer.x - 0.38) < 1e-6 && Math.abs(s.dealer.x + s.dealer.w - 0.6) < 1e-6 && s.backup, JSON.stringify(s.dealer));
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
    check('Service Worker: meldet Offline-Version', offlineVersion === 'bj-assistent-v0.8.0', String(offlineVersion));
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
    check('Profile: nach Neuladen wiederhergestellt', after.n === 3 && after.active === 'Testprofil', JSON.stringify(after));
    // Aktives Profil kann nicht gelöscht werden
    await page.click('.profile-tag');
    await page.waitForSelector('.profile-card');
    const activeCard = page.locator('.profile-card.is-active');
    check('Profile: aktives Profil hat keinen Löschen-Knopf', (await activeCard.locator('[data-action="delete"]').count()) === 0);
    check('Profile: aktives Profil klar markiert', (await activeCard.textContent()).includes('AKTIV'));
    // Standard aktivieren, dann Testprofil löschen (zwei Tipps)
    await page.locator('.profile-card', { hasText: 'Standardstrategie' }).first().locator('[data-action="activate"]').click();
    const testCard = () => page.locator('.profile-card', { hasText: 'Testprofil' }).locator('[data-action="delete"]');
    await testCard().click();
    const stillThere = await page.evaluate(() => window.__bj.profiles.list().length);
    check('Profile: Löschen braucht Bestätigung', stillThere === 3, String(stillThere));
    await testCard().click();
    const left = await page.evaluate(() => window.__bj.profiles.list().map((p) => p.id));
    check('Profile: nach Bestätigung gelöscht', left.length === 2 && left[0] === 'standard' && left[1] === 'yumeko', left.join(','));
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
    check('Migration 0.4.0: Standardprofil aktiv, Einstellungen unverändert', m.active === 'standard' && m.n === 2 && m.s17 === 'zieht' && m.mode === 'manuell', JSON.stringify(m));
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
  // 10) Phase 6: Live-Runde -> Archiv -> Korrektur -> YUMEKO lernt -> Strategieversion
  {
    const { ctx, page, errors } = await newPage(SIZES['iPad quer'], () => {
      if (sessionStorage.getItem('seeded6')) return;
      sessionStorage.setItem('seeded6', '1');
      localStorage.setItem('bjassist.settings', JSON.stringify({ roundMode: 'automatisch', demo: false }));
    });
    await page.goto(BASE);
    await page.waitForSelector('.screen-main');
    await page.evaluate(() => window.__bj.archive.ready());
    // Erkennung simulieren (gleiche Daten wie aus dem Kamerabild): 16 gegen 7 – gestanden
    const ran = await page.evaluate(() => {
      const rec = window.__bj.recognition;
      const d = (rank, x, y = 0.2) => ({ rank, score: 0.95, confident: true, box: { x, y, w: 0.02, h: 0.04 } });
      const raw = (dealer, player, split = []) => ({ dealer, player, split, unsure: false, cardFaceWithoutRank: false });
      let t = 1000;
      const feed = (r, n = 4) => { for (let i = 0; i < n; i++) { t += 250; rec.ingest(r, t); } };
      feed(raw([d('7', 0.4)], [d('10', 0.3, 0.7), d('6', 0.35, 0.7)]));
      const beforeHole = rec.round.snapshot();
      feed(raw([d('7', 0.4), d('10', 0.45)], [d('10', 0.3, 0.7), d('6', 0.35, 0.7)]));
      feed(raw([], []), 2);           // kurz nichts sichtbar
      feed(raw([d('7', 0.4), d('10', 0.45)], [d('10', 0.3, 0.7), d('6', 0.35, 0.7)]));
      const sameRound = rec.round && rec.round.snapshot().dealer.length === 2;
      feed(raw([], []), 30);          // Tisch lange leer -> Runde endet
      return { holeUnknown: !beforeHole.holeKnown && beforeHole.dealer.length === 1, sameRound, open: !!rec.round };
    });
    check('Live: verdeckte Dealerkarte zunächst unbekannt', ran.holeUnknown);
    check('Live: kurze Lücke ohne Karten = gleiche Runde', ran.sameRound);
    const saved = await page.waitForFunction(() => window.__bj.archive.rounds.length === 1, null, { timeout: 5000 }).then(() => true).catch(() => false);
    check('Archiv: abgeschlossene Runde automatisch gespeichert', saved);
    const rec0 = await page.evaluate(() => window.__bj.archive.rounds[0]);
    check('Archiv: Ergebnis Verloren (16 gegen 17), Aktion Stehen erfasst', rec0 && rec0.hands[0].outcome === 'loss' && rec0.hands[0].actions.some((a) => a.action === 'STAND'), JSON.stringify(rec0 && rec0.hands[0]));
    // Archiv-Ansicht: anzeigen, öffnen, Karte korrigieren
    await page.evaluate(() => window.__bj.navigate('archiv'));
    await page.waitForSelector('.round-row');
    check('Archiv: Runde in der Liste', (await page.locator('.round-row').count()) === 1);
    check('Archiv: ohne Überlauf', !(await overflow(page)));
    await page.click('.round-row');
    await page.waitForSelector('.mini-card');
    await page.click('[data-action="card"][data-where="dealer"][data-index="1"]');
    await page.click('[data-action="pick-rank"][data-rank="A"]');
    const corrected = await page.waitForFunction(() => { const r = window.__bj.archive.rounds[0]; return r.dealer.cards[1].rank === 'A' && r.confirmation === 'manual'; }, null, { timeout: 3000 }).then(() => true).catch(() => false);
    check('Archiv: Karte korrigiert und als manuell bestätigt markiert', corrected);
    const rec1 = await page.evaluate(() => window.__bj.archive.rounds[0]);
    check('Archiv: Werte nach Korrektur neu berechnet (Dealer 7+A = 18, 16 verliert)', rec1.dealer.total === 18 && rec1.hands[0].outcome === 'loss' && rec1.status !== 'incomplete', JSON.stringify({ d: rec1.dealer.total, o: rec1.hands[0].outcome, s: rec1.status }));
    // Export enthält Runden und YUMEKO-Wissen
    const exp = await page.evaluate(async () => { const d = await window.__bj.archive.exportData({ yumeko: window.__bj.knowledge.exportData() }); return { n: d.rounds.length, k: d.yumeko.knowledge.length }; });
    check('Archiv: JSON-Export mit Runden und Wissen', exp.n === 1 && exp.k >= 1, JSON.stringify(exp));
    // YUMEKO: analysieren, Entwurf, prüfen, bestätigen
    await page.evaluate(() => window.__bj.navigate('yumeko'));
    await page.waitForSelector('[data-action="analyze"]');
    await page.click('[data-action="analyze"]');
    await page.waitForSelector('.luck-grid', { timeout: 5000 });
    const k = await page.evaluate(() => window.__bj.knowledge.items.filter((i) => i.category === 'verified' && i.id.includes('hard:16:7')).length);
    check('YUMEKO: Fehler (Stehen bei 16 gegen 7) als geprüfte Erkenntnis gespeichert', k === 1);
    await page.click('[data-action="draft"]');
    await page.waitForSelector('[data-action="verify"]');
    await page.click('[data-action="verify"]');
    await page.waitForSelector('[data-action="confirm"]', { timeout: 10000 });
    await page.click('[data-action="confirm"]');
    await page.click('[data-action="confirm"]');
    const v = await page.waitForFunction(() => window.__bj.profiles.get('yumeko').data.strategyVersion === 1, null, { timeout: 5000 }).then(() => true).catch(() => false);
    check('YUMEKO: Strategieversion erst nach Prüfung und Bestätigung aktiv', v);
    await page.click('[data-action="activate"]');
    check('YUMEKO: als einziges Profil aktiv', await page.evaluate(() => window.__bj.profiles.activeId === 'yumeko' && window.__bj.profiles.list().filter((p) => p.id === window.__bj.profiles.activeId).length === 1));
    check('YUMEKO: Lernzentrum ohne Überlauf', !(await overflow(page)));
    // Wissen bleibt nach Neustart erhalten
    await page.reload();
    await page.waitForSelector('.screen-main');
    const persisted = await page.evaluate(async () => { await window.__bj.knowledge.ready(); await window.__bj.archive.ready(); return { k: window.__bj.knowledge.items.length, r: window.__bj.archive.rounds.length, v: window.__bj.knowledge.versions.length }; });
    check('YUMEKO: Wissen, Archiv und Versionen nach Neustart erhalten', persisted.k > 2 && persisted.r === 1 && persisted.v === 1, JSON.stringify(persisted));
    // Demo mit YUMEKO: Empfehlung mit Begründung, nie Aufgeben
    await page.evaluate(() => window.__bj.settings.set('demo', true));
    await page.waitForSelector('.rec-word');
    let sawSurrender = false;
    for (let i = 0; i < 7; i++) {
      const w = await page.evaluate(() => (document.querySelector('.rec-word') || {}).textContent || '');
      if (/AUFGEBEN/.test(w)) sawSurrender = true;
      await page.evaluate(() => document.querySelector('[data-action="next-demo"]').click());
    }
    check('Aufgeben erscheint nirgends in den Empfehlungen', !sawSurrender);
    // Video lernen: Live-Erkennung pausiert, Hinweise "Noch nicht verfügbar"
    await page.evaluate(() => window.__bj.navigate('video'));
    await page.waitForSelector('.feature-list');
    check('Video: Live-Spielerkennung pausiert', await page.evaluate(() => window.__bj.recognition.pausedFor === 'video'));
    check('Video: nicht unterstützte Funktionen klar markiert', (await page.locator('.feature-list .is-missing').count()) === 3);
    await page.evaluate(() => window.__bj.navigate('haupt'));
    check('Video: Erkennung nach Verlassen wieder aktiv', await page.evaluate(() => !window.__bj.recognition.pausedFor));
    for (const v2 of ['wissen', 'einstellungen', 'video']) {
      await page.evaluate((n) => window.__bj.navigate(n), v2);
      await page.waitForTimeout(200);
      check(`Ansicht ${v2}: ohne Überlauf`, !(await overflow(page)));
    }
    check('Phase 6: keine JavaScript-Fehler', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // 11) iPhone-Breite: neue Ansichten ohne Überlauf
  {
    const { ctx, page, errors } = await newPage(SIZES.iPhone);
    await page.goto(BASE);
    await page.waitForSelector('.screen-main');
    for (const v3 of ['archiv', 'yumeko', 'wissen', 'video', 'labor', 'risiko', 'chat']) {
      await page.evaluate((n) => window.__bj.navigate(n), v3);
      await page.waitForTimeout(200);
      check(`iPhone ${v3}: ohne Überlauf`, !(await overflow(page)));
    }
    check('iPhone: keine JavaScript-Fehler', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // 12) Phase 7: Strategie-Labor, Echtgeld & Risiko, Chat, Wissensbibliothek
  {
    const { ctx, page, errors } = await newPage(SIZES['iPad quer']);
    await page.goto(BASE);
    await page.waitForSelector('.screen-main');
    // Echtgeld-Modus: nur mit Bestätigung
    await page.evaluate(() => window.__bj.navigate('risiko'));
    await page.waitForSelector('[data-action="enable"]');
    check('Echtgeld: deutlicher Verlusthinweis vor Aktivierung', /finanziellen Verlusten/.test(await page.textContent('.danger-box')));
    await page.click('[data-action="enable"]');
    check('Echtgeld: ohne Bestätigung nicht aktiviert', await page.evaluate(() => !window.__bj.bankroll.config.enabled));
    await page.check('input[name="ack"]');
    await page.click('[data-action="enable"]');
    await page.waitForSelector('input[name="budget"]');
    await page.fill('input[name="budget"]', '100');
    await page.fill('input[name="start"]', '100');
    await page.click('[data-action="save-setup"]');
    // warten, bis gespeichert ist (Speichern endet erst nach dem IndexedDB-Commit, danach neu gezeichnet)
    await page.waitForFunction(() => window.__bj.bankroll.config.budget === 100 && /Budget und Startsaldo gespeichert/.test(document.querySelector('.sub-content').textContent));
    await page.waitForSelector('input[name="sessionLoss"]');
    await page.fill('input[name="maxBet"]', '10');
    await page.fill('input[name="sessionLoss"]', '20');
    await page.click('[data-action="save-limits"]');
    await page.waitForTimeout(150);
    for (let i = 0; i < 2; i++) {
      await page.fill('[data-draft="stake"]', '10');
      await page.click('[data-action="outcome"][data-o="loss"]');
      check(`Echtgeld: Auszahlung als Vorschlag berechnet (Runde ${i + 1})`, (await page.inputValue('[data-draft="payout"]')) === '0');
      await page.click('[data-action="save-round"]');
      await page.waitForTimeout(150);
    }
    const st = await page.evaluate(() => window.__bj.bankroll.stats());
    check('Echtgeld: Saldo aus echten Eingaben (100 − 2 × 10 = 80)', st.balance === 80, JSON.stringify(st.balance));
    check('Echtgeld: Stopp beim Erreichen des Sitzungslimits', /STOPP/.test(await page.textContent('.risk-card')) && /keine weiteren Einsatzempfehlungen/i.test(await page.textContent('.risk-card')));
    check('Echtgeld: negativer Erwartungswert, Abraten', /rät vom Spiel mit echtem Geld ab/.test(await page.textContent('.risk-card')));
    await page.fill('input[name="sessionLoss"]', '50');
    await page.click('[data-action="save-limits"]');
    await page.waitForTimeout(150);
    check('Echtgeld: Limit in laufender Sitzung nicht erhöhbar', await page.evaluate(() => window.__bj.bankroll.config.limits.sessionLoss === 20) && /nur gesenkt/.test(await page.textContent('.notice')));
    check('Echtgeld: ohne Überlauf', !(await overflow(page)));
    await page.evaluate(() => window.__bj.navigate('haupt'));
    await page.waitForSelector('.risk-strip');
    check('Hauptansicht: Risikoleiste getrennt von der Spielempfehlung (STOPP)', /STOPP/.test(await page.textContent('.risk-strip')) && /Spielempfehlung ≠ Empfehlung, Geld einzusetzen/.test(await page.textContent('.risk-strip')));
    check('Hauptansicht mit Risikoleiste ohne Überlauf', !(await overflow(page)));
    // Strategie-Labor
    await page.evaluate(() => window.__bj.navigate('labor'));
    await page.waitForSelector('[data-action="run"]');
    await page.selectOption('select[name="rounds"]', '10000');
    await page.click('[data-action="run"]');
    await page.waitForSelector('.lab-table', { timeout: 60000 });
    const rows = await page.locator('.lab-table tbody tr').count();
    check('Labor: Vergleich Standard vs. YUMEKO unter gleichen Bedingungen', rows === 2);
    check('Labor: exakte Mathematik und Simulation getrennt ausgewiesen', /Exakte Mathematik/.test(await page.textContent('.lab-table thead')) && /Simulation/.test(await page.textContent('.lab-table thead')));
    await page.click('[data-action="save"]');
    await page.waitForFunction(() => window.__bj.simulations.list.length === 1, null, { timeout: 5000 }).catch(() => {});
    const sims = await page.evaluate(() => ({ sims: window.__bj.simulations.list.length, rounds: window.__bj.archive.rounds.length }));
    check('Labor: Simulation getrennt gespeichert (nicht im Spielarchiv)', sims.sims === 1 && sims.rounds === 0, JSON.stringify(sims));
    check('Labor: ohne Überlauf', !(await overflow(page)));
    // Chat
    await page.evaluate(() => window.__bj.navigate('chat'));
    await page.waitForSelector('.chat-form');
    await page.fill('input[name="q"]', 'Wie hoch waren meine tatsächlichen Verluste?');
    await page.press('input[name="q"]', 'Enter');
    await page.waitForSelector('.chat-msg--yumeko');
    check('Chat: Antwort aus echten Daten (verloren 20.00 CHF)', /verloren 20\.00 CHF/.test(await page.textContent('.chat-msg--yumeko')));
    check('Chat: ohne Überlauf', !(await overflow(page)));
    // Wissensbibliothek: Lernverlauf
    await page.evaluate(() => window.__bj.navigate('wissen'));
    await page.click('[data-action="cat"][data-cat="history"]');
    check('Wissen: Lernverlauf sichtbar', /Simulation gespeichert/.test(await page.textContent('.sub-content')));
    // Neustart: Echtgeld-Daten und Simulation bleiben
    await page.reload();
    await page.waitForSelector('.screen-main');
    const kept = await page.evaluate(async () => { await window.__bj.bankroll.ready(); await window.__bj.simulations.ready(); return { b: window.__bj.bankroll.stats().balance, s: window.__bj.simulations.list.length, on: window.__bj.bankroll.config.enabled }; });
    check('Phase 7: Echtgeld-Protokoll und Simulation nach Neustart erhalten', kept.b === 80 && kept.s === 1 && kept.on, JSON.stringify(kept));
    check('Phase 7: keine JavaScript-Fehler', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  // 13) Phase 8: Deckanzahl „Unbekannt“, Yumeko Academy, Offline, Kamera
  {
    const { ctx, page, errors } = await newPage(SIZES['iPad hoch']);
    const external = [];
    page.on('request', (req) => { const u = new URL(req.url()); if (!['localhost', '127.0.0.1'].includes(u.hostname)) external.push(u.hostname); });
    await page.goto(BASE);
    await page.waitForSelector('.screen-main');
    // Deckanzahl
    await page.click('[data-nav="einstellungen"]');
    await page.click('[data-action="decks"][data-value="unbekannt"]');
    check('Deckanzahl: „Unbekannt“ wählbar, Annahme sichtbar gekennzeichnet', /Annahme, keine Erkennung/.test(await page.textContent('.sub-content')));
    check('Einstellungen mit Deckauswahl ohne Überlauf', !(await overflow(page)));
    await page.reload();
    await page.waitForSelector('.screen-main');
    await page.click('[data-nav="einstellungen"]');
    check('Deckanzahl: „Unbekannt“ bleibt nach Neustart ausgewählt', (await page.getAttribute('[data-action="decks"][data-value="unbekannt"]', 'aria-pressed')) === 'true');
    // Academy: Link einfügen startet die Analyse automatisch (ohne Server: ehrlich „kein Transkript“)
    await page.evaluate(() => window.__bj.navigate('akademie'));
    await page.waitForSelector('input[name="yt-url"]');
    await page.fill('input[name="yt-url"]', 'https://youtu.be/dQw4w9WgXcQ');
    await page.waitForFunction(() => { const s = window.__bj.academy.sources[0]; return s && s.status === 'unverifiable'; }, null, { timeout: 8000 });
    const card = await page.textContent('.academy-card');
    check('Academy: Link startet Analyse automatisch, Status sichtbar', /Nicht überprüfbar/.test(card));
    check('Academy: fehlendes Transkript wird angezeigt, nichts erfunden', /Kein Transkript verfügbar/.test(card) && (await page.evaluate(() => window.__bj.academy.claims.length)) === 0);
    check('Academy: ohne Server keine Anfrage an YouTube oder andere Dienste', external.length === 0, external.join(','));
    // Transkript einfügen -> Aussagen erkannt und mathematisch geprüft
    await page.click('[data-action="transcript"]');
    await page.fill('textarea[name="transcript"]', '0:05\nAlways split aces and eights.\n0:20 Stand on 12 against a 2.\n0:30 Never take insurance.');
    await page.click('[data-action="sheet-save"]');
    await page.waitForFunction(() => { const s = window.__bj.academy.sources[0]; return s && ['verified', 'partial'].includes(s.status); }, null, { timeout: 15000 });
    check('Academy: eingefügtes Transkript analysiert und geprüft', /Erfolgreich geprüft/.test(await page.textContent('.academy-card')));
    check('Academy: YouTube-Bibliothek ohne Überlauf', !(await overflow(page)));
    await page.click('[data-action="tab"][data-tab="wissen"]');
    const kb = await page.textContent('[data-slot="body"]');
    check('Academy: Wissensbibliothek zeigt bestätigte und widerlegte Aussagen mit Quelle', /Mathematisch bestätigt/.test(kb) && /Mathematisch widerlegt/.test(kb) && /als fehlerhaft markiert/.test(kb) && /\(0:20\)/.test(kb));
    await page.fill('input[name="q"]', 'versicherung');
    check('Academy: Wissen durchsuchen', (await page.locator('.knowledge-card').count()) === 1);
    check('Academy: Wissensbibliothek ohne Überlauf', !(await overflow(page)));
    await page.click('[data-action="tab"][data-tab="statistik"]');
    check('Academy: Lernstatistik aus echten Daten', /bestätigte Strategien/.test(await page.textContent('.stat-grid')) && (await page.textContent('.stat-grid')).includes('1'));
    check('Academy: Lernstatistik ohne Überlauf', !(await overflow(page)));
    await page.click('[data-action="tab"][data-tab="rechner"]');
    await page.click('[data-action="calc"]');
    await page.waitForSelector('.analysis-block', { timeout: 15000 });
    const calc = await page.textContent('.analysis-block');
    check('Strategie-Engine: beste Aktion mit Erwartungswerten und Deck-Vergleich (Decks unbekannt)', /Beste Aktion: Ziehen/.test(calc) && /Vergleich Deckanzahl/.test(calc) && /Annahme/.test(calc));
    check('Strategie-Engine ohne Überlauf', !(await overflow(page)));
    // Export / Zurücksetzen / Import
    await page.click('[data-action="tab"][data-tab="daten"]');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]')]);
    const exported = JSON.parse(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8'));
    check('Academy: Export als Datei', exported.format === 'bjai-academy' && exported.sources.length === 1 && exported.claims.length === 4, `${exported.sources && exported.sources.length}/${exported.claims && exported.claims.length}`);
    await page.click('[data-action="reset"]');
    await page.click('[data-action="reset"]');
    await page.waitForFunction(() => window.__bj.academy.sources.length === 0);
    check('Academy: Zurücksetzen nur nach zweitem Tipp', true);
    await page.setInputFiles('input[data-slot="file"]', { name: 'academy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await page.waitForFunction(() => window.__bj.academy.claims.length === 4, null, { timeout: 5000 }).catch(() => {});
    check('Academy: Import stellt die Daten wieder her', await page.evaluate(() => window.__bj.academy.claims.length === 4 && window.__bj.academy.sources.length === 1));
    check('Academy: Daten & Server ohne Überlauf', !(await overflow(page)));
    // Neustart: Daten bleiben
    await page.reload();
    await page.waitForSelector('.screen-main');
    const keptA = await page.evaluate(async () => { await window.__bj.academy.ready(); return window.__bj.academy.claims.length; });
    check('Academy: Wissen nach Neustart erhalten', keptA === 4, String(keptA));
    // Offline: Academy und Strategie-Engine funktionieren ohne Netz
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
    await ctx.setOffline(true);
    await page.reload();
    const offStart = await page.waitForSelector('.screen-main', { timeout: 5000 }).then(() => true).catch(() => false);
    await page.evaluate(() => window.__bj.navigate('akademie'));
    await page.click('[data-action="tab"][data-tab="rechner"]');
    await page.click('[data-action="calc"]');
    const offCalc = await page.waitForSelector('.analysis-block', { timeout: 15000 }).then(() => true).catch(() => false);
    check('Offline: App startet, Academy und Strategie-Engine rechnen ohne Netz', offStart && offCalc);
    await ctx.setOffline(false);
    // Kamera funktioniert weiterhin (Testkamera, iPad-Grösse) und „Erkennung melden“ speichert nur Kartenwerte
    await page.evaluate(() => window.__bj.navigate('kamera'));
    await page.click('[data-camera="start"]');
    await page.waitForFunction(() => window.__bj.camera.state === 'active', null, { timeout: 8000 });
    check('Phase 8: Kamera startet weiterhin (iPad-Grösse, Testkamera)', true);
    const fb = await page.evaluate(async () => { const f = await window.__bj.academy.addFeedback({ kind: 'wrong-card', dealer: [{ rank: 'K', score: 0.7 }], hands: [] }); return Object.keys(f.dealer[0]).join(','); });
    check('Kamera-Lernmodus: Meldung enthält nur Kartenwerte', fb === 'rank,score', fb);
    check('Phase 8: keine JavaScript-Fehler', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // 14) Phase 8: Academy auf dem iPhone ohne Überlauf
  {
    const { ctx, page, errors } = await newPage(SIZES.iPhone);
    await page.goto(BASE);
    await page.waitForSelector('.screen-main');
    await page.evaluate(() => window.__bj.navigate('einstellungen'));
    check('iPhone: Deckauswahl ohne Überlauf', !(await overflow(page)));
    await page.evaluate(() => window.__bj.navigate('akademie'));
    for (const t of ['videos', 'wissen', 'statistik', 'rechner', 'daten']) {
      await page.click(`[data-action="tab"][data-tab="${t}"]`);
      check(`iPhone Academy ${t}: ohne Überlauf`, !(await overflow(page)));
    }
    check('iPhone Academy: keine JavaScript-Fehler', errors.length === 0, errors.join(' | '));
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
