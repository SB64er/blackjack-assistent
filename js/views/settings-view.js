// Einstellungen (Design aus Phase 1 + Kameraoptionen aus Phase 2).
import { View, subHeader, cameraStatus } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { APP_VERSION } from '../core/version.js';
import { RecognitionReason } from '../recognition/recognition-service.js';

const BLOCKER_TEXT = {
  [RecognitionReason.CAMERA]: 'Kamera aus',
  [RecognitionReason.CALIBRATION]: 'Nicht kalibriert',
  [RecognitionReason.EDITING]: 'Kalibrierung offen',
  [RecognitionReason.ORIENTATION]: 'Bildausrichtung passt nicht',
  [RecognitionReason.TEMPLATES]: 'Karten nicht angelernt'
};

export const RULES = [
  { path: 'rules.decks',     label: 'Anzahl Decks',           options: [6, 8, 1, 2, 4],            text: (v) => String(v) },
  { path: 'rules.soft17',    label: 'Dealer bei Soft 17',     options: ['steht', 'zieht'],         text: (v) => (v === 'steht' ? 'Steht' : 'Zieht') },
  { path: 'rules.das',       label: 'Verdoppeln nach Split',  options: [true, false],              text: (v) => (v ? 'Erlaubt' : 'Nicht erlaubt') },
  { path: 'rules.surrender', label: 'Aufgeben',               options: ['spaet', 'keine'],         text: (v) => (v === 'spaet' ? 'Spät' : 'Nicht erlaubt') },
  { path: 'rules.payout',    label: 'Blackjack zahlt',        options: ['3:2', '6:5'],             text: (v) => v }
];

const toggle = (action, on, label) =>
  `<button type="button" class="switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-action="${action}"><span></span></button>`;

export class SettingsView extends View {
  mount() {
    const { settings, camera, calibration } = this.ctx;
    this.el.className = 'screen screen-sub';
    this.el.addEventListener('click', (e) => this._onClick(e));
    this.listen(settings, 'change', () => this.render());
    this.listen(camera, 'state', () => this.render());
    this.listen(calibration, 'change', () => this.render());
    this.listen(this.ctx.templates, 'change', () => this.render());
    this.listen(this.ctx.recognition, 'status', () => this.render());
    this.listen(this.ctx.updates, 'change', () => this.render());
    this.listen(this.ctx.profiles, 'change', () => this.render());
    this.listen(this.ctx.display, 'change', () => this.render());
    this.render();
  }

  destroy() {
    super.destroy();
    clearTimeout(this._revokeTimer);
  }

  _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { settings, camera } = this.ctx;
    const a = btn.dataset.action;
    if (a === 'mode-auto') settings.set('roundMode', 'automatisch');
    else if (a === 'mode-manual') settings.set('roundMode', 'manuell');
    else if (a === 'speech') settings.set('speech', !settings.get('speech'));
    else if (a === 'demo') settings.set('demo', !settings.get('demo'));
    else if (a === 'keep-awake') {
      const v = !settings.get('camera.keepAwake');
      settings.set('camera.keepAwake', v);
      camera.setKeepAwake(v);
    } else if (a === 'fps') {
      const v = settings.get('camera.fps') === 30 ? 15 : 30;
      settings.set('camera.fps', v);
      camera.setFrameRate(v);
    } else if (a === 'rec-fps') {
      settings.set('recognition.fps', settings.get('recognition.fps') === 4 ? 2 : 4);
    } else if (a === 'rec-boxes') {
      settings.set('recognition.showBoxes', !settings.get('recognition.showBoxes'));
    } else if (a === 'revoke') {
      if (!this._confirmRevoke) {
        this._confirmRevoke = true;
        clearTimeout(this._revokeTimer);
        this._revokeTimer = setTimeout(() => { this._confirmRevoke = false; this.render(); }, 4000);
        this.render();
      } else {
        this._confirmRevoke = false;
        this.ctx.templates.revokeConsent();
      }
    } else if (a.startsWith('rule:')) {
      const rule = RULES.find((r) => r.path === a.slice(5));
      const cur = settings.get(rule.path);
      const i = rule.options.indexOf(cur);
      settings.set(rule.path, rule.options[(i + 1) % rule.options.length]);
    }
  }

  _appHtml() {
    const { display, updates } = this.ctx;
    let offline;
    if (!updates.supported) offline = 'Nicht verfügbar (nur über HTTPS)';
    else if (updates.offlineVersion) offline = `Bereit · ${updates.offlineVersion.replace('bj-assistent-', '')}`;
    else offline = 'Wird vorbereitet …';
    let updateRow = '';
    if (updates.supported) {
      updateRow = updates.available
        ? `<button type="button" class="row row--btn" data-app="update-apply">
             <span class="row-stack"><span class="text-ok">Neue Version installieren</span><small>Lädt die App neu · alle Daten bleiben erhalten</small></span>
             <span class="row-value">${ICONS.chevron}</span>
           </button>`
        : `<button type="button" class="row row--btn" data-app="update-check" ${updates.checking ? 'disabled' : ''}>
             <span class="row-stack"><span>Nach Updates suchen</span><small>${updates.checking ? 'Suche läuft …' : (updates.lastCheck ? `Zuletzt geprüft: ${esc(updates.lastCheck.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }))} – aktuell` : 'Geschieht auch automatisch beim Öffnen')}</small></span>
             <span class="row-value">${ICONS.chevron}</span>
           </button>`;
    }
    const fsRow = display.fullscreenSupported
      ? `<div class="row">
           <span class="row-stack"><span>Vollbild</span><small>Blendet die Safari-Leisten aus</small></span>
           ${toggle('fullscreen', display.fullscreen, 'Vollbild').replace('data-action="fullscreen"', 'data-app="fullscreen"')}
         </div>`
      : '';
    const install = display.ios && !display.standalone
      ? `<p class="hint hint--box"><b>Als App auf dem Home-Bildschirm:</b> In Safari auf <b>Teilen</b> › <b>Zum Home-Bildschirm</b> tippen. Die App startet dann ohne Browserleisten im Vollbild. Achtung: Die Home-Bildschirm-App hat einen eigenen Speicher – Kalibrierung und angelernte Karten dort einmal neu einrichten.</p>`
      : '';
    return `
        <section class="group">
          <h2 class="group-title">APP</h2>
          <div class="list">
            <div class="row"><span>Startart</span><span class="row-value">${esc(display.modeLabel)}</span></div>
            ${fsRow}
            <div class="row"><span class="row-stack"><span>Offline nutzbar</span><small>App-Dateien auf dem Gerät gespeichert</small></span><span class="row-value">${esc(offline)}</span></div>
            ${updateRow}
          </div>
          ${install}
        </section>`;
  }

  render() {
    const { settings } = this.ctx;
    const manual = settings.get('roundMode') === 'manuell';
    const cam = cameraStatus(this.ctx);
    const calText = cam.calibrated ? 'Gespeichert' : 'Nicht kalibriert';
    const blocker = this.ctx.recognition.blocker();
    const recText = blocker ? BLOCKER_TEXT[blocker] : 'Aktiv';
    const recTone = blocker ? (blocker === RecognitionReason.ORIENTATION ? 'warn' : 'idle') : 'ok';
    const counts = this.ctx.templates.countByRank();
    const learned = Object.entries(counts).filter(([r, n]) => r !== 'X' && n > 0).length;

    this.el.innerHTML = `
      ${subHeader('Einstellungen')}
      <div class="sub-content">
        <section class="group">
          <h2 class="group-title">NEUE RUNDE</h2>
          <div class="segmented" role="group" aria-label="Rundenerkennung">
            <button type="button" data-action="mode-auto" aria-pressed="${!manual}">Automatisch</button>
            <button type="button" data-action="mode-manual" aria-pressed="${manual}">Manuell</button>
          </div>
          <p class="group-help">${manual
            ? 'Tippe auf „Neue Hand“, sobald eine neue Runde beginnt.'
            : 'Die App erkennt neue Runden selbst: Sobald der Tisch leer war und neue Karten erscheinen.'}</p>
        </section>

        <section class="group">
          <h2 class="group-title">AUSGABE &amp; KAMERA</h2>
          <div class="list">
            <div class="row"><span>Sprachausgabe</span>${toggle('speech', settings.get('speech'), 'Sprachausgabe')}</div>
            <button type="button" class="row row--link" data-nav="kamera"><span>Kamera &amp; Kalibrierung</span><span class="row-value">${esc(calText)} ${ICONS.chevron}</span></button>
            <button type="button" class="row row--btn" data-action="fps">
              <span class="row-stack"><span>Bildrate</span><small>15 fps spart Akku</small></span>
              <span class="row-value">${settings.get('camera.fps')} fps ${ICONS.chevron}</span>
            </button>
            <div class="row">
              <span class="row-stack"><span>Bildschirm wach halten</span><small>Solange die Kamera läuft</small></span>
              ${toggle('keep-awake', settings.get('camera.keepAwake'), 'Bildschirm wach halten')}
            </div>
          </div>
        </section>

        <section class="group">
          <h2 class="group-title">KARTENERKENNUNG</h2>
          <div class="list">
            <div class="row"><span>Status Kartenerkennung</span><span class="row-value"><span class="dot dot--${recTone}"></span>${esc(recText)}</span></div>
            <button type="button" class="row row--link" data-nav="anlernen">
              <span class="row-stack"><span>Karten anlernen</span><small>Werte A–K einmal zeigen und benennen</small></span>
              <span class="row-value">${learned}/13 ${ICONS.chevron}</span>
            </button>
            <button type="button" class="row row--btn" data-action="rec-fps">
              <span class="row-stack"><span>Erkennungsrate</span><small>2 pro Sekunde spart Akku</small></span>
              <span class="row-value">${settings.get('recognition.fps')} pro Sek. ${ICONS.chevron}</span>
            </button>
            <div class="row">
              <span class="row-stack"><span>Erkannte Zeichen markieren</span><small>Kästchen im Kamerabild</small></span>
              ${toggle('rec-boxes', settings.get('recognition.showBoxes'), 'Erkannte Zeichen markieren')}
            </div>
            ${this.ctx.templates.consent ? `
              <button type="button" class="row row--btn" data-action="revoke">
                <span class="row-stack"><span class="${this._confirmRevoke ? 'text-danger' : ''}">${this._confirmRevoke ? 'Wirklich löschen? Nochmals tippen' : 'Angelernte Muster löschen'}</span><small>Zieht auch die Zustimmung zurück</small></span>
                <span class="row-value"></span>
              </button>` : ''}
          </div>
        </section>

        <section class="group">
          <h2 class="group-title">STRATEGIEPROFILE</h2>
          <div class="list">
            <button type="button" class="row row--link" data-nav="strategie">
              <span class="row-stack"><span>Aktives Profil</span><small>${esc(this.ctx.profiles.list().length)} Profile gespeichert · Profile verwalten, KI-Strategie</small></span>
              <span class="row-value"><span class="type-badge type-badge--${esc(this.ctx.profiles.active.type)}">${esc(this.ctx.profiles.active.name)}</span> ${ICONS.chevron}</span>
            </button>
          </div>
          <p class="group-help">Die Empfehlungen im Hauptbildschirm richten sich nach dem aktiven Profil und den Tischregeln unten.</p>
        </section>

        <section class="group">
          <h2 class="group-title">TISCHREGELN</h2>
          <div class="list">
            ${RULES.map((r) => `
              <button type="button" class="row row--btn" data-action="rule:${r.path}">
                <span>${esc(r.label)}</span>
                <span class="row-value">${esc(r.text(settings.get(r.path)))} ${ICONS.chevron}</span>
              </button>`).join('')}
          </div>
        </section>

        <section class="group">
          <h2 class="group-title">TEST</h2>
          <div class="list">
            <div class="row">
              <span class="row-stack"><span>Demo-Modus</span><small>Simulierte Karten statt Kamera</small></span>
              ${toggle('demo', settings.get('demo'), 'Demo-Modus')}
            </div>
            <button type="button" class="row row--link" data-nav="test"><span>Testmodus Kamera &amp; Kalibrierung</span><span class="row-value">${ICONS.chevron}</span></button>
          </div>
        </section>

        ${this._appHtml()}

        <p class="footnote">Version ${esc(APP_VERSION)} · Alle Daten bleiben auf diesem Gerät.</p>
      </div>`;
  }
}
