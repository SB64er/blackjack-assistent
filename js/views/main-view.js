// Hauptbildschirm (Design aus Phase 1) – Demo-Modus oder Live-Erkennung (Phase 3).
import { View, cameraStatus, compatMessage, cameraButton } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { DEMO_SCENARIOS, RECOMMENDATIONS } from '../demo/scenarios.js';
import { handInfo, upcardLabel, RANK_NAMES } from '../game/hand.js';
import { RecognitionReason } from '../recognition/recognition-service.js';

let demoIndex = 0; // bleibt beim Wechsel zwischen Ansichten erhalten

const RED = new Set(['♥', '♦']);

function cardHtml(c) {
  if (!c) return '<div class="card card--empty" aria-label="Keine Karte"></div>';
  if (c.confident === false) return '<div class="card card--unsure" aria-label="Karte nicht erkannt">?</div>';
  if (!c.suit) {
    return `<div class="card card--rank-only" aria-label="${esc(RANK_NAMES[c.rank] || c.rank)}"><span class="card-rank-big">${esc(c.rank)}</span></div>`;
  }
  return `<div class="card ${RED.has(c.suit) ? 'card--red' : ''}" aria-label="${esc(c.rank + ' ' + c.suit)}">
      <span class="card-rank">${esc(c.rank)}</span><span class="card-suit">${esc(c.suit)}</span>
    </div>`;
}

function handBlock(title, cards, info) {
  const list = cards.length ? cards.map(cardHtml).join('') : cardHtml(null) + cardHtml(null);
  return `
    <div class="hand">
      <div class="hand-cards">
        <span class="kicker">${esc(title)}</span>
        <div class="cards">${list}</div>
      </div>
      <div class="hand-value">
        <span class="hand-value-label">Gesamtwert</span>
        <span class="hand-value-num">${info.total == null ? '–' : info.total}</span>
      </div>
    </div>`;
}

const EVENT_TEXT = {
  'round-start': 'Neue Runde erkannt',
  'card-added': 'Karte gezogen',
  'round-suggested': 'Neue Runde? Tippe auf „Neue Hand“.'
};

export class MainView extends View {
  get hostsCamera() {
    return true;
  }

  mount() {
    const { settings, camera, calibration, recognition, templates } = this.ctx;
    this.el.className = 'screen screen-main';
    this.el.innerHTML = `
      <header class="topbar">
        <div class="topbar-text">
          <span class="app-title">Blackjack Assistent</span>
          <span class="status" data-slot="status"></span>
        </div>
        <div class="mini-cam" data-slot="mini" aria-label="Live-Kamerabild"></div>
        <nav class="topbar-actions">
          <span data-slot="fs"></span>
          <button type="button" class="icon-btn" data-nav="kamera" aria-label="Kamera und Kalibrierung">${ICONS.camera}</button>
          <button type="button" class="icon-btn" data-nav="einstellungen" aria-label="Einstellungen">${ICONS.gear}</button>
        </nav>
      </header>
      <div data-slot="notice"></div>
      <div class="main-grid" data-slot="grid"></div>`;
    this.mini = this.el.querySelector('[data-slot="mini"]');
    camera.attach(this.mini);

    this.el.addEventListener('click', (e) => this._onClick(e));
    const r = () => this.render();
    this.listen(settings, 'change', r);
    this.listen(camera, 'state', r);
    this.listen(camera, 'dimensions', r);
    this.listen(camera, 'playback', r);
    this.listen(this.ctx.display, 'change', r);
    this.listen(calibration, 'change', r);
    this.listen(templates, 'change', r);
    this.listen(recognition, 'update', r);
    this.listen(recognition, 'status', r);
    this.listen(recognition, 'event', (ev) => {
      this._event = ev;
      clearTimeout(this._eventTimer);
      this._eventTimer = setTimeout(() => { this._event = null; this.render(); }, 2500);
      this.render();
    });
    this.render();
  }

  destroy() {
    super.destroy();
    clearTimeout(this._eventTimer);
  }

  _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { settings, recognition } = this.ctx;
    switch (btn.dataset.action) {
      case 'mode-auto': settings.set('roundMode', 'automatisch'); break;
      case 'mode-manual': settings.set('roundMode', 'manuell'); break;
      case 'speech': settings.set('speech', !settings.get('speech')); break;
      case 'new-hand':
        if (settings.get('demo')) { demoIndex = (demoIndex + 1) % DEMO_SCENARIOS.length; this.render(true); }
        else recognition.newHand();
        break;
      case 'next-demo':
        demoIndex = (demoIndex + 1) % DEMO_SCENARIOS.length;
        this.render(true);
        break;
      default: break;
    }
  }

  // Spielzustand für die Anzeige (Demo oder Live).
  _model() {
    const { settings, recognition, templates, camera } = this.ctx;
    if (settings.get('demo')) {
      const s = DEMO_SCENARIOS[demoIndex];
      const confident = s.player.every((c) => c.confident) && s.dealerUp.confident;
      return {
        mode: 'demo',
        dealerUp: s.dealerUp, dealerHole: null,
        hands: [{ title: 'DEINE HAND', cards: s.player }],
        uncertain: !confident,
        recommendation: confident && s.recommendation ? RECOMMENDATIONS[s.recommendation] : null,
        handText: s.handText
      };
    }
    const blocker = recognition.blocker();
    const m = { mode: 'live', blocker, dealerUp: null, dealerHole: null, hands: [{ title: 'DEINE HAND', cards: [] }], uncertain: false, cameraError: camera.error };
    if (blocker) return m;
    const st = recognition.state;
    const res = st && st.result;
    m.round = st ? st.round : 0;
    m.waiting = !res;
    if (res) {
      m.dealerUp = res.dealerUp;
      m.dealerHole = res.dealerHole;
      m.hands = [{ title: res.split.length ? 'HAND 1' : 'DEINE HAND', cards: res.player }];
      if (res.split.length) m.hands.push({ title: 'HAND 2 (SPLIT)', cards: res.split });
      m.empty = st.empty;
    }
    m.uncertain = !!(st && st.uncertain);
    m.missing = templates.missingRanks();
    return m;
  }

  _centerHtml(m) {
    const { camera, settings } = this.ctx;
    const speech = settings.get('speech');
    if (m.uncertain) {
      return `
        <section class="rec rec--warn" role="alert">
          <span class="rec-warn-icon">${ICONS.warning}</span>
          <span class="rec-warn-title">Keine Empfehlung</span>
          <span class="rec-warn-text">Kartenerkennung unsicher</span>
          <span class="rec-warn-sub">Keine Sprachansage · Kamera und Bildschirm prüfen</span>
        </section>`;
    }
    if (m.mode === 'demo' && m.recommendation) {
      const r = m.recommendation;
      return `
        <section class="rec rec--${r.tone}" aria-live="polite">
          <span class="rec-kicker">EMPFEHLUNG · DEMO</span>
          <span class="rec-word" data-len="${r.label.length}">${esc(r.label)}</span>
          <span class="rec-hand">${esc(m.handText)}</span>
          <button type="button" class="pill-btn" data-action="speech" aria-pressed="${speech}">
            ${speech ? ICONS.speaker : ICONS.speakerOff}<span>${speech ? 'Sprachausgabe an' : 'Sprachausgabe aus'}</span>
          </button>
        </section>`;
    }
    const idle = (title, text, extra = '') => `
      <section class="rec rec--idle">
        <span class="rec-kicker">KARTENERKENNUNG</span>
        <span class="rec-idle-title">${esc(title)}</span>
        <span class="rec-hand">${esc(text)}</span>
        ${extra}
      </section>`;

    switch (m.blocker) {
      case RecognitionReason.CAMERA:
        if (m.cameraError) return idle(m.cameraError.title, m.cameraError.message, `<div class="rec-actions">${cameraButton(camera)}<button type="button" class="btn btn--ghost" data-nav="kamera">Details &amp; Diagnose</button></div>`);
        return idle(camera.canResume ? 'Kamera pausiert' : 'Kamera ist aus',
          camera.canResume ? 'Die App war im Hintergrund. Tippe auf „Kamera fortsetzen“.' : 'Starte die Kamera, damit die Karten erkannt werden.',
          `<div class="rec-actions">${cameraButton(camera)}</div>`);
      case RecognitionReason.CALIBRATION:
        return idle('Noch nicht kalibriert', 'Markiere zuerst die Kartenbereiche A1, A2 und B.', '<div class="rec-actions"><button type="button" class="btn btn--primary" data-nav="kamera">Zur Kalibrierung</button></div>');
      case RecognitionReason.EDITING:
        return idle('Kalibrierung offen', 'Speichere oder verwirf die Kalibrierung.', '<div class="rec-actions"><button type="button" class="btn btn--primary" data-nav="kamera">Zur Kalibrierung</button></div>');
      case RecognitionReason.ORIENTATION: {
        const c = compatMessage(this.ctx.calibration.compatibility(camera.dimensions()));
        return `
          <section class="rec rec--warn" role="alert">
            <span class="rec-warn-icon">${ICONS.warning}</span>
            <span class="rec-warn-title">${esc(c ? c.title : 'Bild passt nicht')}</span>
            <span class="rec-warn-sub">${esc(c ? c.message : '')}</span>
          </section>`;
      }
      case RecognitionReason.TEMPLATES:
        return idle('Karten anlernen', 'Damit die App die Kartenbilder deines Casinos erkennt, lerne die Werte A bis K einmal an.', '<div class="rec-actions"><button type="button" class="btn btn--primary" data-nav="anlernen">Karten anlernen</button></div>');
      default: break;
    }

    if (m.waiting || m.empty) {
      const auto = settings.get('roundMode') === 'automatisch';
      return idle('Warte auf Karten …', auto ? 'Die nächste Runde wird automatisch erkannt.' : 'Tippe auf „Neue Hand“, wenn eine neue Runde beginnt.');
    }

    const main = handInfo(m.hands[0].cards);
    const vs = m.dealerUp ? ` gegen ${upcardLabel(m.dealerUp)}` : '';
    const second = m.hands[1] ? handInfo(m.hands[1].cards) : null;
    return `
      <section class="rec rec--detected" aria-live="polite">
        <span class="rec-kicker">ERKANNT${m.round ? ` · RUNDE ${m.round}` : ''}</span>
        <span class="rec-word rec-word--hand" data-len="${Math.min(10, (main.text || '').length)}">${esc((main.text || '–').toUpperCase())}</span>
        <span class="rec-hand">${esc(`${main.text}${vs}`)}${second ? esc(` · Hand 2: ${second.text}`) : ''}</span>
        <span class="rec-note">Spielzugempfehlung folgt in Phase 4</span>
      </section>`;
  }

  render(force = false) {
    const { settings, camera } = this.ctx;
    const demo = settings.get('demo');
    const manual = settings.get('roundMode') === 'manuell';
    const m = this._model();
    const cam = cameraStatus(this.ctx);
    const compat = compatMessage(cam.compat);

    // Statuszeile & Mini-Kamera
    const statusText = `${demo ? 'Demo' : 'Live'} · ${cam.label}${cam.calibrated ? ' · kalibriert' : ''}`;
    this.el.querySelector('[data-slot="status"]').innerHTML = `<span class="dot dot--${cam.tone}"></span>${esc(statusText)}`;
    this.mini.classList.toggle('is-on', camera.isRunning);
    if (camera.isRunning && camera.video.parentNode !== this.mini) camera.attach(this.mini);

    // Hinweise
    let notice = '';
    if (camera.playBlocked) {
      notice = `<button type="button" class="warn-strip" data-camera="play">${ICONS.warning}<span>Kamerabild angehalten – hier tippen, um es anzuzeigen</span></button>`;
    } else if (this._event && EVENT_TEXT[this._event.type] && !demo) {
      notice = `<div class="toast" role="status">${ICONS.check}<span>${esc(EVENT_TEXT[this._event.type])}</span></div>`;
    } else if (compat || cam.tone === 'warn') {
      notice = `<button type="button" class="warn-strip" data-nav="kamera">${ICONS.warning}<span>${esc(compat ? compat.title : cam.label)} – Details</span></button>`;
    } else if (!demo && m.missing && m.missing.length && m.missing.length < 13 && !m.blocker) {
      notice = `<button type="button" class="warn-strip" data-nav="anlernen">${ICONS.warning}<span>Noch nicht angelernt: ${esc(m.missing.join(', '))}</span></button>`;
    }
    // Vollbild-Knopf (nur im Browser-Tab, wo die Fullscreen-API verfügbar ist)
    const { display } = this.ctx;
    const fs = display.fullscreenSupported
      ? `<button type="button" class="icon-btn" data-app="fullscreen" aria-label="${display.fullscreen ? 'Vollbild beenden' : 'Vollbild'}">${display.fullscreen ? ICONS.shrink : ICONS.expand}</button>`
      : '';
    const fsEl = this.el.querySelector('[data-slot="fs"]');
    if (fsEl.innerHTML !== fs) fsEl.innerHTML = fs;

    const noticeEl = this.el.querySelector('[data-slot="notice"]');
    if (noticeEl.innerHTML !== notice) noticeEl.innerHTML = notice;

    // Spielbereich nur neu zeichnen, wenn sich etwas geändert hat
    // (verhindert verlorene Tipps bei 4 Auswertungen pro Sekunde).
    const key = JSON.stringify([m, demoIndex, manual, settings.get('speech'), camera.state, camera.canResume, camera.startingSlow]);
    if (!force && key === this._lastKey) return;
    this._lastKey = key;

    const hole = m.dealerHole ? cardHtml(m.dealerHole) : '<div class="card card--back" aria-label="Verdeckte Karte"></div>';
    const hands = m.hands.map((hnd) => handBlock(hnd.title, hnd.cards, handInfo(hnd.cards))).join('');
    const showNewHand = manual;
    const autoInfo = !demo && m.round ? `Runde ${m.round} · automatisch` : 'Wartet auf neue Runde …';

    this.el.querySelector('[data-slot="grid"]').innerHTML = `
      <section class="hand hand--dealer" aria-label="Dealer">
        <div class="hand-cards">
          <span class="kicker">DEALER</span>
          <div class="cards">${cardHtml(m.dealerUp)}${hole}</div>
        </div>
        <div class="hand-value">
          <span class="hand-value-label">offene Karte</span>
          <span class="hand-value-num hand-value-num--sm">${esc(upcardLabel(m.dealerUp))}</span>
        </div>
      </section>

      ${this._centerHtml(m)}

      <section class="hand-group" aria-label="Deine Hand">${hands}</section>

      <footer class="main-footer">
        <div class="segmented" role="group" aria-label="Rundenerkennung">
          <button type="button" data-action="mode-auto" aria-pressed="${!manual}">Automatisch</button>
          <button type="button" data-action="mode-manual" aria-pressed="${manual}">Manuell</button>
        </div>
        ${showNewHand
          ? '<button type="button" class="btn btn--primary" data-action="new-hand">Neue Hand</button>'
          : `<div class="waiting"><span class="dot dot--ok"></span>${esc(autoInfo)}</div>`}
        ${demo ? `
          <button type="button" class="btn btn--ghost" data-action="next-demo">
            Demo: nächstes Szenario (${demoIndex + 1}/${DEMO_SCENARIOS.length}) ${ICONS.chevron}
          </button>` : ''}
      </footer>`;
  }
}
