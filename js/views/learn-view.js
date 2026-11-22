// Karten anlernen: Rangzeichen im Kamerabild antippen und Wert zuordnen.
import { View, subHeader, cameraStatus, cameraButton, warningBanner, compatMessage, playbackButton } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { RANKS, RANK_NAMES } from '../game/hand.js';
import { GLYPH_W, GLYPH_H } from '../recognition/vision.js';
import { IGNORE } from '../recognition/template-store.js';
import { DetectionOverlay, boxesFromScan } from '../recognition/detection-overlay.js';
import { RecognitionReason } from '../recognition/recognition-service.js';

// Vorschau genau des Musters, das gespeichert wird (20×28 Punkte).
function glyphSvg(bits) {
  let rects = '';
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < GLYPH_W; x++) {
      if (bits[y * GLYPH_W + x]) rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  }
  return `<svg class="glyph-preview" viewBox="0 0 ${GLYPH_W} ${GLYPH_H}" role="img" aria-label="Gespeichertes Muster" shape-rendering="crispEdges">${rects}</svg>`;
}

function rankLike(box) {
  const r = box.data.candidate.suitRatio;
  return r != null && r >= 0.35 && r <= 0.95 ? 1 : 0;
}

export class LearnView extends View {
  get hostsCamera() {
    return true;
  }

  mount() {
    const { camera, calibration, templates, recognition } = this.ctx;
    this.el.className = 'screen screen-sub screen-camera';
    this._picked = null;
    this._notice = null;
    this.el.innerHTML = `
      ${subHeader('Karten anlernen', 'kamera')}
      <div class="cam-layout">
        <div class="cam-stage-wrap">
          <div class="cam-statusline" data-slot="status"></div>
          <div class="camera-stage" data-slot="stage">
            <div class="stage-placeholder" data-slot="placeholder"><strong>Kameravorschau</strong><span>Tippe auf „Kamera starten“.</span></div>
            <div class="stage-play" data-slot="play"></div>
          </div>
        </div>
        <div class="cam-panel" data-slot="panel"></div>
      </div>
      <div class="sheet-backdrop" data-slot="sheet" hidden></div>`;
    this.stage = this.el.querySelector('[data-slot="stage"]');
    camera.attach(this.stage);
    // Kästchen im Bild nur zur Orientierung; angetippt wird in der Galerie.
    this.overlay = new DetectionOverlay({ stage: this.stage, getFrameSize: () => camera.dimensions() });
    this._snapshot = null;

    this.el.addEventListener('click', (e) => this._onClick(e));
    const u = () => this.update();
    this.listen(camera, 'state', u);
    this.listen(camera, 'dimensions', u);
    this.listen(camera, 'playback', u);
    this.listen(calibration, 'change', u);
    this.listen(templates, 'change', u);
    this.listen(recognition, 'status', u);
    this.listen(recognition, 'scan', () => this._updateBoxes());
    this.update();
  }

  destroy() {
    super.destroy();
    this.overlay.destroy();
  }

  _updateBoxes() {
    const { templates, recognition } = this.ctx;
    if (!templates.consent || !recognition.scanning) { this.overlay.setBoxes([]); return; }
    const boxes = boxesFromScan(recognition.latest, { includeUnknown: true })
      .filter((b) => b.tone !== 'none' || b.data.likelyRank);
    this.overlay.setBoxes(boxes);
  }

  // Momentaufnahme: gefundene Zeichen als vergrösserte Kacheln.
  _capture() {
    const { recognition } = this.ctx;
    const order = { dealer: 0, player: 1, split: 2 };
    const items = boxesFromScan(recognition.latest, { includeUnknown: true })
      .filter((b) => b.tone !== 'ignored' && (b.tone !== 'none' || b.data.likelyRank))
      // Wahrscheinliche Rangzeichen zuerst (kleineres Farbsymbol direkt darunter).
      .sort((a, b) => (rankLike(b) - rankLike(a)) || (order[a.data.regionId] - order[b.data.regionId]) || (a.x - b.x) || (a.y - b.y))
      .slice(0, 24);
    this._snapshot = items.map((b) => ({ ...b, assigned: null }));
    this.update();
  }

  _pick(item) {
    if (!item) return;
    this._picked = item;
    this._renderSheet();
  }

  _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { templates } = this.ctx;
    const a = btn.dataset.action;
    if (a === 'consent') {
      templates.giveConsent();
    } else if (a === 'capture') {
      this._capture();
    } else if (a === 'tile') {
      this._pick(this._snapshot && this._snapshot[Number(btn.dataset.idx)]);
    } else if (a === 'assign') {
      const rank = btn.dataset.rank;
      try {
        templates.add(rank, this._picked.data.candidate);
        this._picked.assigned = rank;
        this._notice = { tone: 'ok', text: rank === IGNORE ? 'Als „kein Kartenwert“ gespeichert.' : `Gespeichert: ${rank}${RANK_NAMES[rank] ? ` (${RANK_NAMES[rank]})` : ''}` };
      } catch (err) {
        this._notice = { tone: 'warn', text: err.message };
      }
      this._picked = null;
      this._renderSheet();
      this.update();
    } else if (a === 'close-sheet') {
      this._picked = null;
      this._renderSheet();
    } else if (a === 'clear') {
      if (!this._confirmClear) {
        this._confirmClear = true;
        setTimeout(() => { this._confirmClear = false; this.update(); }, 4000);
      } else {
        this._confirmClear = false;
        templates.clear();
        this._notice = { tone: 'ok', text: 'Alle angelernten Muster gelöscht.' };
      }
      this.update();
    }
  }

  _renderSheet() {
    const sheet = this.el.querySelector('[data-slot="sheet"]');
    if (!this._picked) { sheet.hidden = true; sheet.innerHTML = ''; return; }
    const c = this._picked.data.candidate;
    const current = this._picked.label ? `Aktuell erkannt: <b>${esc(this._picked.label)}</b>` : 'Noch nicht erkannt';
    sheet.hidden = false;
    sheet.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Kartenwert wählen">
        <div class="sheet-head">
          ${glyphSvg(c.bits)}
          <div>
            <strong>Welcher Wert ist das?</strong>
            <p class="hint">${current}. Gespeichert wird nur dieses 20×28-Punkte-Muster.</p>
          </div>
        </div>
        <div class="rank-grid">
          ${RANKS.map((r) => `<button type="button" class="rank-btn" data-action="assign" data-rank="${r}">${r}${RANK_NAMES[r] ? `<small>${RANK_NAMES[r]}</small>` : ''}</button>`).join('')}
        </div>
        <button type="button" class="btn btn--secondary" data-action="assign" data-rank="${IGNORE}">Kein Kartenwert (z. B. Farbsymbol)</button>
        <button type="button" class="btn btn--ghost" data-action="close-sheet">Abbrechen</button>
      </div>`;
  }

  _galleryHtml() {
    if (!this._snapshot) return '';
    if (!this._snapshot.length) {
      return '<p class="hint hint--box">Keine Zeichen gefunden. Liegen Karten in den Bereichen A/B? Ist die Kalibrierung richtig?</p>';
    }
    const regionLabel = { dealer: 'A', player: 'B', split: 'C' };
    const tiles = this._snapshot.map((it, i) => {
      const label = it.assigned ? (it.assigned === IGNORE ? '–' : it.assigned) : (it.label || '?');
      const tone = it.assigned ? 'ok' : it.tone;
      return `<button type="button" class="tile tile--${tone}" data-action="tile" data-idx="${i}" aria-label="Zeichen ${i + 1} in Bereich ${regionLabel[it.data.regionId]}: ${esc(label)}">
          ${glyphSvg(it.data.candidate.bits)}
          <span class="tile-label">${esc(label)}</span>
          <span class="tile-region">${regionLabel[it.data.regionId]}</span>
        </button>`;
    }).join('');
    return `
      <p class="meta">Gefundene Zeichen (wahrscheinliche Rangzeichen zuerst). Benenne die <b>Rangzeichen</b> A, 2–10, J, Q, K. Farbsymbole kannst du ignorieren – nur falls eines fälschlich als Wert erkannt wird, markiere es als „Kein Kartenwert“.</p>
      <div class="tiles">${tiles}</div>`;
  }

  update() {
    const { camera, calibration, templates, recognition } = this.ctx;
    const cam = cameraStatus(this.ctx);
    const active = camera.state === 'active';
    this.el.querySelector('[data-slot="status"]').innerHTML =
      `<span class="status"><span class="dot dot--${cam.tone}"></span>${esc(cam.label)}</span>`;
    this.el.querySelector('[data-slot="placeholder"]').hidden = active;
    this.stage.classList.toggle('is-live', active);
    const dims = camera.dimensions();
    if (dims) this.stage.style.setProperty('--frame-aspect', `${dims.width} / ${dims.height}`);
    this.el.querySelector('[data-slot="play"]').innerHTML = playbackButton(camera);

    const panel = [];
    if (!templates.consent) {
      panel.push(`
        <div class="consent">
          <strong>Zustimmung zum Speichern von Kartenmustern</strong>
          <p>Damit die App die Karten deines Casinos erkennt, speichert sie beim Anlernen <b>kleine Schwarz-Weiss-Muster der Rangzeichen</b> (20×28 Punkte, etwa so gross wie dieses Wort) – lokal auf diesem Gerät.</p>
          <p>Es werden <b>keine Fotos</b> oder Kamerabilder gespeichert und nichts wird übertragen. Du kannst die Muster jederzeit in den Einstellungen löschen.</p>
          <button type="button" class="btn btn--primary" data-action="consent">Zustimmen und anlernen</button>
          <button type="button" class="btn btn--ghost" data-nav="kamera">Nicht jetzt</button>
        </div>`);
    } else {
      const blocker = recognition.blocker();
      if (blocker === RecognitionReason.CAMERA) panel.push(cameraButton(camera));
      else if (blocker === RecognitionReason.CALIBRATION || blocker === RecognitionReason.EDITING) {
        panel.push(warningBanner({ title: 'Erst kalibrieren', message: 'Markiere zuerst die Bereiche A (Dealer) und B (Spieler) und speichere die Kalibrierung.' }));
        panel.push('<button type="button" class="btn btn--primary" data-nav="kamera">Zur Kalibrierung</button>');
      } else if (blocker === RecognitionReason.ORIENTATION) {
        panel.push(warningBanner(compatMessage(calibration.compatibility(camera.dimensions()))));
      } else {
        panel.push(`
          <ol class="learn-steps">
            <li>Spiele eine Runde, sodass Karten in den Bereichen A und B liegen.</li>
            <li>Tippe auf <b>„Zeichen erfassen“</b>. Die gefundenen Zeichen erscheinen vergrössert.</li>
            <li>Tippe auf ein Zeichen und wähle den Wert. Wiederhole das mit weiteren Runden, bis alle 13 Werte grün sind.</li>
          </ol>
          <button type="button" class="btn btn--primary" data-action="capture">Zeichen erfassen</button>`);
        panel.push(this._galleryHtml());
      }

      const counts = templates.countByRank();
      panel.push(`
        <div class="rank-progress" aria-label="Angelernte Werte">
          ${RANKS.map((r) => `<span class="rank-chip ${counts[r] ? 'is-done' : ''}" title="${counts[r]} Muster">${r}${counts[r] ? `<small>${counts[r]}</small>` : ''}</span>`).join('')}
        </div>
        <p class="meta">${RANKS.filter((r) => counts[r]).length} von 13 Werten angelernt${counts[IGNORE] ? ` · ${counts[IGNORE]}× „kein Kartenwert“` : ''}</p>`);
      if (templates.items.length) {
        panel.push(`<button type="button" class="btn ${this._confirmClear ? 'btn--danger' : 'btn--ghost'}" data-action="clear">${this._confirmClear ? 'Wirklich alle löschen? Nochmals tippen' : 'Alle Muster löschen'}</button>`);
      }
    }
    if (this._notice) {
      panel.push(`<p class="notice notice--${this._notice.tone}" role="status">${this._notice.tone === 'ok' ? ICONS.check : ICONS.warning}<span>${esc(this._notice.text)}</span></p>`);
    }
    panel.push('<div class="legend"><span class="det det-swatch det--ok"></span>erkannt <span class="det det-swatch det--unsure"></span>unsicher <span class="det det-swatch det--none"></span>unbekannt <span class="det det-swatch det--ignored"></span>kein Wert</div>');
    this.el.querySelector('[data-slot="panel"]').innerHTML = `<div class="controls">${panel.join('')}</div>`;
    this._updateBoxes();
  }
}
