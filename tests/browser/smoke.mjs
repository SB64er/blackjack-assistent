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
    check(`${name}: Version 0.10.0 angezeigt`, (await page.textContent('.footnote')).includes('0.10.0'));
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
    check('Service Worker: meldet Offline-Version', offlineVersion === 'bj-assistent-v0.10.0', String(offlineVersion));
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
    await page.locator('.profile-card', { hasText: 'Standardstrategie' }).first().locator('[data-action="activate"]').click();
    const testCard = () => page.locator('.profile-card', { hasText: 'Testprofil' }).locator('[data-action="delete"]');
    await testCard().click();
    const stillThere = await page.evaluate(() => window.__bj.profiles.list().length);
    check('Profile: Löschen braucht Bestätigung', stillThere === 2, String(stillThere));
    await testCard().click();
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
  // 10) Phase 6: Live-Runde -> Archiv -> Korrektur (YUMEKO-Teile seit 0.9.0 entfernt)
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
    // Export enthält Runden (seit 0.9.0 ohne alte KI-Daten)
    const exp = await page.evaluate(async () => { const d = await window.__bj.archive.exportData({}); return { n: d.rounds.length, y: 'yumeko' in d }; });
    check('Archiv: JSON-Export mit Runden', exp.n === 1 && !exp.y, JSON.stringify(exp));
    // Archiv bleibt nach Neustart erhalten
    await page.reload();
    await page.waitForSelector('.screen-main');
    const persisted = await page.evaluate(async () => { await window.__bj.archive.ready(); return window.__bj.archive.rounds.length; });
    check('Archiv: Runde nach Neustart erhalten', persisted === 1, String(persisted));
    // Demo: Empfehlung, nie Aufgeben
    await page.evaluate(() => window.__bj.settings.set('demo', true));
    await page.waitForSelector('.rec-word');
    let sawSurrender = false;
    for (let i = 0; i < 7; i++) {
      const w = await page.evaluate(() => (document.querySelector('.rec-word') || {}).textContent || '');
      if (/AUFGEBEN/.test(w)) sawSurrender = true;
      await page.evaluate(() => document.querySelector('[data-action="next-demo"]').click());
    }
    check('Aufgeben erscheint nirgends in den Empfehlungen', !sawSurrender);
    for (const v2 of ['einstellungen', 'labor', 'risiko', 'strategie']) {
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
    for (const v3 of ['archiv', 'labor', 'risiko', 'einstellungen', 'strategie']) {
      await page.evaluate((n) => window.__bj.navigate(n), v3);
      await page.waitForTimeout(200);
      check(`iPhone ${v3}: ohne Überlauf`, !(await overflow(page)));
    }
    check('iPhone: keine JavaScript-Fehler', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // 12) Phase 7: Strategie-Labor, Echtgeld & Risiko (Chat und Wissensbibliothek seit 0.9.0 entfernt)
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
    await page.evaluate(() => window.__bj.profiles.duplicate('standard', 'Vergleichsprofil'));
    await page.evaluate(() => window.__bj.navigate('labor'));
    await page.waitForSelector('[data-action="run"]');
    for (const box of await page.locator('input[name="pick"]').all()) if (!(await box.isChecked())) await box.check();
    await page.selectOption('select[name="rounds"]', '10000');
    await page.click('[data-action="run"]');
    await page.waitForSelector('.lab-table', { timeout: 60000 });
    const rows = await page.locator('.lab-table tbody tr').count();
    check('Labor: Vergleich zweier Profile unter gleichen Bedingungen', rows === 2, String(rows));
    check('Labor: exakte Mathematik und Simulation getrennt ausgewiesen', /Exakte Mathematik/.test(await page.textContent('.lab-table thead')) && /Simulation/.test(await page.textContent('.lab-table thead')));
    await page.click('[data-action="save"]');
    await page.waitForFunction(() => window.__bj.simulations.list.length === 1, null, { timeout: 5000 }).catch(() => {});
    const sims = await page.evaluate(() => ({ sims: window.__bj.simulations.list.length, rounds: window.__bj.archive.rounds.length }));
    check('Labor: Simulation getrennt gespeichert (nicht im Spielarchiv)', sims.sims === 1 && sims.rounds === 0, JSON.stringify(sims));
    check('Labor: ohne Überlauf', !(await overflow(page)));
    // Neustart: Echtgeld-Daten und Simulation bleiben
    await page.reload();
    await page.waitForSelector('.screen-main');
    const kept = await page.evaluate(async () => { await window.__bj.bankroll.ready(); await window.__bj.simulations.ready(); return { b: window.__bj.bankroll.stats().balance, s: window.__bj.simulations.list.length, on: window.__bj.bankroll.config.enabled }; });
    check('Phase 7: Echtgeld-Protokoll und Simulation nach Neustart erhalten', kept.b === 80 && kept.s === 1 && kept.on, JSON.stringify(kept));
    check('Phase 7: keine JavaScript-Fehler', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  // 13) Phase 8: Deckanzahl „Unbekannt“, Offline, Kamera (Academy seit 0.9.0 entfernt)
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
    check('Ohne alte KI: keine Anfrage an andere Dienste', external.length === 0, external.join(','));
    // Offline: App startet, Einstellungen und Strategieprofile funktionieren ohne Netz
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
    await ctx.setOffline(true);
    await page.reload();
    const offStart = await page.waitForSelector('.screen-main', { timeout: 5000 }).then(() => true).catch(() => false);
    await page.evaluate(() => window.__bj.navigate('strategie'));
    const offStrat = await page.waitForSelector('.profile-card', { timeout: 5000 }).then(() => true).catch(() => false);
    check('Offline: App startet, Strategieprofile ohne Netz', offStart && offStrat);
    await ctx.setOffline(false);
    // Kamera funktioniert weiterhin (Testkamera, iPad-Grösse)
    await page.evaluate(() => window.__bj.navigate('kamera'));
    await page.click('[data-camera="start"]');
    await page.waitForFunction(() => window.__bj.camera.state === 'active', null, { timeout: 8000 });
    check('Phase 8: Kamera startet weiterhin (iPad-Grösse, Testkamera)', true);
    check('Phase 8: keine JavaScript-Fehler', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // 14) 0.9.0: Daten aus 0.8.0 (YUMEKO aktiv, KI-Gedächtnis) -> Profil gesichert, KI-Gedächtnis erst sichern, dann löschen
  for (const [label, size] of [['iPad quer', SIZES['iPad quer']], ['iPhone', SIZES.iPhone]]) {
    const { ctx, page, errors } = await newPage(size);
    await page.goto(BASE);
    await page.waitForSelector('.screen-main');
    // Stand von 0.8.0 nachbilden (gleiche Speicherorte wie die alte App)
    await page.evaluate(async () => {
      await window.__bj.archive.ready();
      const AT = '2026-11-22T10:00:00Z';
      const R = { decks: 6, soft17: 'steht', das: true, payout: '3:2' };
      localStorage.setItem('bjassist.strategyProfiles', JSON.stringify({ version: 2, rev: 9, activeId: 'yumeko', invalid: [], profiles: [
        { id: 'standard', name: 'Standardstrategie', type: 'standard', rules: R, settings: { followTableRules: true }, overrides: {}, data: {}, createdAt: AT, updatedAt: AT },
        { id: 'yumeko', name: 'YUMEKO AI', description: 'Adaptive Blackjack Intelligence.', type: 'yumeko', rules: R, settings: { followTableRules: true }, overrides: { 'hard:16:10': 'S' }, data: { strategyVersion: 2, versionId: 'v2' }, createdAt: AT, updatedAt: AT }
      ] }));
      localStorage.setItem('bjassist.yumekoChat', JSON.stringify([{ from: 'user', text: 'Hallo' }]));
      const db = await new Promise((res, rej) => { const r = indexedDB.open('bjassist', 3); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const put = (store, v) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(v); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      await put('knowledge', { id: 'k1', category: 'verified', content: 'Hart 16 gegen 7: Ziehen' });
      await put('versions', { id: 'v2', number: 2, status: 'aktiv', overrides: { 'hard:16:10': 'S' } });
      await put('claims', { id: 'c1', text: 'Always split aces' });
      await put('meta', { id: 'yumeko', dismissed: [] });
      await put('meta', { id: 'bankroll', enabled: false, currency: 'CHF' });
      await put('rounds', { id: 'r_alt', startedAt: AT, status: 'complete', rules: R, hands: [{ cards: [{ rank: '10' }, { rank: '9' }], actions: [], outcome: 'win' }], dealer: { cards: [{ rank: '10' }, { rank: '7' }], total: 17, final: true } });
      db.close();
    });
    await page.reload();
    await page.waitForSelector('.screen-main');
    const prof = await page.evaluate(() => ({ active: window.__bj.profiles.active, ids: window.__bj.profiles.list().map((p) => p.id), backup: JSON.parse(localStorage.getItem('bjassist.legacy.yumekoProfile') || 'null') }));
    check(`${label}: YUMEKO-Tabelle bleibt als normales aktives Profil (gleiche Empfehlung)`, prof.active.id === 'yumeko-gesichert' && prof.active.type === 'custom' && prof.active.overrides['hard:16:10'] === 'S' && !prof.ids.includes('yumeko'), JSON.stringify(prof.ids));
    check(`${label}: Original-Profil gesichert`, prof.backup && prof.backup.profile.type === 'yumeko' && prof.backup.wasActive === true);
    await page.evaluate(() => window.__bj.archive.ready());
    check(`${label}: Spielarchiv aus 0.8.0 unverändert lesbar`, await page.evaluate(() => window.__bj.archive.rounds.length === 1));
    await page.evaluate(() => window.__bj.navigate('einstellungen'));
    await page.waitForSelector('[data-slot="legacy-ai"]');
    const sec = await page.textContent('[data-slot="legacy-ai"]');
    check(`${label}: Einstellungen zeigen altes KI-Gedächtnis mit Inhalt`, /1 Wissenseinträge/.test(sec) && /1 Strategieversionen/.test(sec) && /1 Academy-Aussagen/.test(sec), sec.replace(/\s+/g, ' ').slice(0, 160));
    check(`${label}: Löschen vor der Sicherung gesperrt`, await page.isDisabled('[data-action="ai-clear-ask"]'));
    check(`${label}: Einstellungen ohne Überlauf`, !(await overflow(page)));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="ai-export"]')]);
    const backup = JSON.parse(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8'));
    check(`${label}: Sicherung als JSON-Datei mit allen alten KI-Daten`, backup.format === 'bjai-ki-gedaechtnis-sicherung' && backup.indexedDB.knowledge.length === 1 && backup.indexedDB.versions.length === 1 && backup.indexedDB.claims.length === 1 && backup.localStorage.yumekoChat.length === 1 && backup.localStorage['legacy.yumekoProfile'].profile.type === 'yumeko' && backup.indexedDB.meta.length === 1, dl.suggestedFilename());
    await page.waitForSelector('[data-action="ai-clear-ask"]:not([disabled])');
    await page.click('[data-action="ai-clear-ask"]');
    await page.click('[data-action="ai-clear-do"]');
    check(`${label}: ohne Bestätigung nichts gelöscht`, await page.evaluate(async () => (await window.__bj.legacyAi.refresh()).total) === 6);
    await page.check('input[name="ai-clear-ok"]');
    await page.click('[data-action="ai-clear-do"]');
    await page.waitForFunction(() => window.__bj.legacyAi.empty, null, { timeout: 5000 }).catch(() => {});
    const after = await page.evaluate(async () => {
      const db = await new Promise((res) => { const r = indexedDB.open('bjassist', 3); r.onsuccess = () => res(r.result); });
      const all = (s) => new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); });
      const out = { knowledge: (await all('knowledge')).length, claims: (await all('claims')).length, meta: (await all('meta')).map((m) => m.id), rounds: (await all('rounds')).length, chat: localStorage.getItem('bjassist.yumekoChat'), profiles: !!localStorage.getItem('bjassist.strategyProfiles') };
      db.close();
      return out;
    });
    check(`${label}: KI-Gedächtnis gelöscht, Archiv, Echtgeld-Einstellungen und Profile bleiben`, after.knowledge === 0 && after.claims === 0 && after.rounds === 1 && after.meta.join() === 'bankroll' && after.chat === null && after.profiles, JSON.stringify(after));
    check(`${label}: Bestätigung angezeigt`, /wurde gelöscht/.test(await page.textContent('.sub-content')));
    check(`${label}: nach dem Löschen ohne Überlauf`, !(await overflow(page)));
    check(`${label}: keine JavaScript-Fehler`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // 15) 0.10.0: Yumeko-Lernzentrum (Grundgerüst) – Knopf, Layout in allen Grössen, Profil ein/aus
  for (const [name, size] of Object.entries(SIZES)) {
    const label = `Lernzentrum ${name}`;
    const shot = (file) => (process.env.LZ_SHOTS ? page.screenshot({ path: `${process.env.LZ_SHOTS}/${file}` }) : null);
    const slug = name.split(' ').join('-');
    const { ctx, page, errors } = await newPage(size);
    await page.goto(BASE);
    await page.waitForSelector('.screen-main');
    const order = await page.$$eval('.topbar-actions [data-nav]', (els) => els.map((e) => e.dataset.nav));
    check(`${label}: Lern-Knopf zwischen Kamera und Einstellungen`, order.join() === 'kamera,lernzentrum,einstellungen', order.join());
    check(`${label}: Hauptansicht mit Lern-Knopf ohne Überlauf`, !(await overflow(page)));
    await shot(`main-${slug}.png`);
    await page.click('[data-nav="lernzentrum"]');
    await page.waitForSelector('.screen-lz');
    check(`${label}: vier Bereiche und Statistik`, (await page.$$('.lz-tile')).length === 4 && (await page.$$('.lz-stat')).length === 5);
    check(`${label}: Statistik startet bei 0`, (await page.$$eval('.lz-stat-value', (els) => els.map((e) => e.textContent))).join() === '0,0,0,0,0');
    check(`${label}: ohne seitlichen Überlauf`, !(await overflow(page)));
    if (size[0] >= 760 && size[1] > 700) {
      const fits = await page.evaluate(() => {
        const b = document.querySelector('.lz-activate').getBoundingClientRect();
        return b.bottom <= window.innerHeight + 1 && document.documentElement.scrollHeight <= window.innerHeight + 1;
      });
      check(`${label}: passt ohne Scrollen auf den Bildschirm`, fits);
      const tile = await page.$eval('.lz-tile', (e) => e.getBoundingClientRect().height);
      check(`${label}: Kacheln gross genug zum Tippen`, tile >= 150, String(Math.round(tile)));
    }
    await shot(`lz-${slug}.png`);
    await page.click('.lz-tile[data-id="study"]');
    await page.waitForSelector('.lz-dialog');
    check(`${label}: Bereich öffnet Fenster mit Platzhalter`, /Study/.test(await page.textContent('.lz-dialog')) && /Platzhalter/.test(await page.textContent('.lz-dialog')));
    if (name === 'iPad quer') await shot('lz-dialog.png');
    await page.click('.lz-dialog [data-lz="close"]');
    check(`${label}: Fenster schliesst`, !(await page.$('.lz-dialog')));
    await page.click('.lz-activate');
    const on = await page.evaluate(() => ({ id: window.__bj.profiles.activeId, saved: JSON.parse(localStorage.getItem('bjassist.strategyProfiles')).activeId }));
    check(`${label}: Aktivieren schaltet Yumeko-Profil in den Strategieprofilen ein`, on.id === 'yumeko-ai' && on.saved === 'yumeko-ai', JSON.stringify(on));
    check(`${label}: Knopf und Status zeigen aktiv`, /Yumeko Profil aktiv/.test(await page.textContent('.lz-activate')) && (name.startsWith('iPhone') || /Profil aktiv/.test(await page.textContent('.lz-status'))));
    if (name === 'iPad quer') await shot('lz-aktiv.png');
    await page.click('[data-nav="haupt"]');
    await page.waitForSelector('.screen-main');
    check(`${label}: Hauptbildschirm zeigt Profil Yumeko`, /Yumeko/.test(await page.textContent('.screen-main')));
    await page.click('[data-nav="lernzentrum"]');
    await page.waitForSelector('.screen-lz');
    await page.click('.lz-activate');
    check(`${label}: Ausschalten -> wieder Standardstrategie`, await page.evaluate(() => window.__bj.profiles.activeId) === 'standard');
    check(`${label}: keine JavaScript-Fehler`, errors.length === 0, errors.join(' | '));
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
