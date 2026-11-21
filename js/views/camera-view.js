// Kamera & Kalibrierung (Phase 2).
import { View, subHeader, cameraStatus, compatMessage, warningBanner, cameraButton } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { CameraState, isStandalone, isIPad } from '../camera/camera-service.js';
import { collectDiagnostics, diagnosticsText } from '../camera/camera-diagnostics.js';
import { CalibrationEditor } from '../calibration/calibration-editor.js';
import { REGION_DEFS, DEFAULT_REGIONS, cloneRegions } from '../calibration/calibration-store.js';
import { DetectionOverlay, boxesFromScan } from '../recognition/detection-overlay.js';

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

export class CameraView extends View {
  get hostsCamera() {
    return true;
  }

  mount() {
    const { camera, calibration } = this.ctx;
    this.el.className = 'screen screen-sub screen-camera';
    this._confirmReset = false;
    this._notice = null;

    this.el.innerHTML = `
      ${subHeader('Kamera & Kalibrierung')}
      <div class="cam-layout">
        <div class="cam-stage-wrap">
          <div class="cam-statusline" data-slot="status"></div>
          <div class="camera-stage" data-slot="stage">
            <div class="stage-placeholder" data-slot="placeholder"></div>
          </div>
        </div>
        <div class="cam-panel">
          <div data-slot="warnings"></div>
          <div data-slot="controls"></div>
          <details class="diag" data-slot="diag">
            <summary>Kamera-Diagnose</summary>
            <div data-slot="diag-body"><p class="hint">Wird beim Öffnen erfasst …</p></div>
            <button type="button" class="btn btn--ghost" data-action="copy-diag">Diagnose kopieren</button>
          </details>
        </div>
      </div>`;

    this.stage = this.el.querySelector('[data-slot="stage"]');
    camera.attach(this.stage);

    this.editor = new CalibrationEditor({
      stage: this.stage,
      getFrameSize: () => this._frameSize(),
      onRegionChange: (id, rect) => calibration.updateRegion(id, rect)
    });

    this.detect = new DetectionOverlay({ stage: this.stage, getFrameSize: () => camera.dimensions() });
    this.listen(this.ctx.recognition, 'scan', () => this._updateDetections());
    this.listen(this.ctx.settings, 'change', () => this.update());

    this.el.querySelector('[data-slot="diag"]').addEventListener('toggle', (e) => {
      if (e.target.open) this._refreshDiagnostics();
    });

    this.el.addEventListener('click', (e) => this._onClick(e));
    this.el.addEventListener('change', (e) => this._onChange(e));
    this.listen(camera, 'state', () => this.update());
    this.listen(camera, 'dimensions', () => this.update());
    this.listen(camera, 'info', () => this.update());
    this.listen(calibration, 'change', () => this.update());
    this.update();
  }

  destroy() {
    super.destroy();
    clearTimeout(this._resetTimer);
    if (this.editor) this.editor.destroy();
    if (this.detect) this.detect.destroy();
  }

  _updateDetections() {
    const { settings, calibration, recognition } = this.ctx;
    const show = settings.get('recognition.showBoxes') && !calibration.editing && recognition.scanning;
    this.detect.setBoxes(show ? boxesFromScan(recognition.latest) : []);
  }

  async _refreshDiagnostics() {
    const rows = await collectDiagnostics(this.ctx.camera);
    rows.push(['Erkennung', this.ctx.recognition.scanning ? `aktiv · ${this.ctx.recognition.tickMs} ms pro Auswertung` : 'aus']);
    this._diagRows = rows;
    this.el.querySelector('[data-slot="diag-body"]').innerHTML =
      `<dl class="diag-list">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  }

  // Bildgrösse für das Overlay: live, sonst die gespeicherte (Kamera aus).
  _frameSize() {
    const live = this.ctx.camera.dimensions();
    if (live) return live;
    const saved = this.ctx.calibration.saved;
    return saved ? { width: saved.frame.width, height: saved.frame.height } : null;
  }

  async _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const { camera, calibration } = this.ctx;
    const action = btn.dataset.action;
    this._notice = null;

    switch (action) {
      case 'copy-diag': {
        await this._refreshDiagnostics();
        const text = diagnosticsText(this._diagRows);
        try {
          await navigator.clipboard.writeText(text);
          this._notice = { tone: 'ok', text: 'Diagnose kopiert. Du kannst sie in eine Nachricht einfügen.' };
        } catch {
          this._notice = { tone: 'warn', text: 'Kopieren nicht möglich. Bitte die Angaben abfotografieren.' };
        }
        this.update();
        break;
      }
      case 'edit': {
        const compat = calibration.compatibility(camera.dimensions());
        calibration.beginEdit();
        if (!compat.ok) {
          // Neue Ausrichtung: mit Standardbereichen beginnen, alte bleibt bis zum Speichern erhalten.
          const fresh = cloneRegions(DEFAULT_REGIONS);
          for (const id of Object.keys(fresh)) calibration.draft[id] = fresh[id];
          calibration.emit('change');
        }
        this.editor.select('dealerUp');
        break;
      }
      case 'select':
        this.editor.select(btn.dataset.id);
        this.update();
        break;
      case 'save': {
        const dims = camera.dimensions();
        try {
          calibration.save(dims);
          this._notice = { tone: 'ok', text: 'Kalibrierung gespeichert. Sie wird beim nächsten Start automatisch geladen.' };
        } catch (err) {
          this._notice = { tone: 'warn', text: err.message };
        }
        this.update();
        break;
      }
      case 'cancel':
        calibration.cancelEdit();
        break;
      case 'reset':
        if (!this._confirmReset) {
          this._confirmReset = true;
          clearTimeout(this._resetTimer);
          this._resetTimer = setTimeout(() => { this._confirmReset = false; this.update(); }, 4000);
          this.update();
        } else {
          this._confirmReset = false;
          clearTimeout(this._resetTimer);
          calibration.reset();
          this._notice = { tone: 'ok', text: 'Kalibrierung zurückgesetzt.' };
          this.update();
        }
        break;
      default:
        break;
    }
  }

  _onChange(e) {
    if (e.target.matches('[data-action="split"]')) {
      this.ctx.calibration.setSplitEnabled(e.target.checked);
    }
  }

  update() {
    const { camera, calibration } = this.ctx;
    const cam = cameraStatus(this.ctx);
    const active = camera.state === CameraState.ACTIVE;
    const editing = calibration.editing;
    const dims = camera.dimensions();
    const compatMsg = active && !editing ? compatMessage(cam.compat) : null;

    // --- Statuszeile
    const info = camera.info();
    this.el.querySelector('[data-slot="status"]').innerHTML = `
      <span class="status"><span class="dot dot--${cam.tone}"></span>${esc(cam.label)}</span>
      <span class="status-info">${info && info.width ? `${info.width}×${info.height} · ${info.frameRate} fps` : ''}</span>`;

    // --- Platzhalter
    const ph = this.el.querySelector('[data-slot="placeholder"]');
    const showSavedPreview = !active && calibration.hasSaved;
    ph.hidden = active;
    ph.innerHTML = showSavedPreview
      ? '<strong>Kamera aus</strong><span>Gespeicherte Bereiche werden angezeigt.</span>'
      : `<strong>Kameravorschau</strong><span>${camera.state === CameraState.STARTING ? 'Kamera startet …' : 'Tippe auf „Kamera starten“.'}</span>`;
    this.stage.classList.toggle('is-live', active);

    // --- Overlay
    let regions = calibration.visibleRegions();
    if (compatMsg) regions = null; // falsche Ausrichtung: Bereiche nicht falsch einzeichnen
    this.editor.setState({ regions, editing, dimmed: !active && !editing });

    // --- Warnungen
    const warnings = [];
    if (!window.isSecureContext) {
      warnings.push({ title: 'Kamera nur über HTTPS', message: 'Diese Seite wurde nicht über https:// geöffnet. Safari erlaubt hier keinen Kamerazugriff.' });
    }
    if (camera.state === CameraState.ERROR && camera.error) warnings.push(camera.error);
    if (camera.state === CameraState.INTERRUPTED) {
      warnings.push({ title: 'Kamera unterbrochen', message: 'Das System hat die Kamera kurz angehalten (z. B. Kontrollzentrum oder Anruf). Sie läuft automatisch weiter, sobald das vorbei ist.' });
    }
    if (compatMsg) warnings.push(compatMsg);
    if (editing && !active) {
      warnings.push({ title: 'Kamera ist aus', message: 'Starte die Kamera, um die Bereiche am echten Bild auszurichten und zu speichern.' });
    }
    const hint = isStandalone() && !active && camera.state !== CameraState.ERROR
      ? `<p class="hint hint--box">${isIPad() ? 'iPad' : 'iPhone'} als Home-Bildschirm-App: Das System fragt bei jedem App-Start erneut nach der Kamera. Tippe auf „Kamera starten“ und dann auf „Erlauben“.</p>`
      : '';
    this.el.querySelector('[data-slot="warnings"]').innerHTML = warnings.map(warningBanner).join('') + hint;
    this._updateDetections();

    // --- Bedienelemente
    this.el.querySelector('[data-slot="controls"]').innerHTML = this._controlsHtml({ active, editing, dims });
  }

  _workaroundHtml() {
    const { camera } = this.ctx;
    const failing = camera.state === CameraState.ERROR;
    if (!(isStandalone() && failing)) return '';
    return `
      <div class="workaround">
        <strong>Ausweichlösung (wenn die Kamera als Home-Bildschirm-App nicht startet)</strong>
        <ol>
          <li>Öffne die Adresse der App direkt in <b>Safari</b> (dort funktioniert die Kamera zuverlässig).</li>
          <li>In Safari: „aA“ › Website-Einstellungen › Kamera › <b>Erlauben</b> – dann fragt Safari nicht mehr nach.</li>
          <li>Für ein eigenes Symbol: App <b>Kurzbefehle</b> › neuer Kurzbefehl › „URLs öffnen“ mit der App-Adresse › „Zum Home-Bildschirm“. Das Symbol öffnet die App in Safari.</li>
          <li>Kalibrierung und angelernte Karten musst du in Safari einmal neu einrichten – Safari und die Home-Bildschirm-App haben getrennte Speicher.</li>
        </ol>
      </div>`;
  }

  _controlsHtml({ active, editing, dims }) {
    const { camera, calibration } = this.ctx;
    const saved = calibration.saved;
    const camBtn = cameraButton(camera);

    const resetBtn = saved
      ? `<button type="button" class="btn ${this._confirmReset ? 'btn--danger' : 'btn--ghost'}" data-action="reset">
           ${this._confirmReset ? 'Wirklich zurücksetzen? Nochmals tippen' : 'Kalibrierung zurücksetzen'}
         </button>`
      : '';

    let calib;
    if (!editing) {
      calib = `
        <button type="button" class="btn btn--secondary" data-action="edit" ${active ? '' : 'disabled'}>
          ${saved ? 'Kalibrierung bearbeiten' : 'Kalibrieren'}
        </button>
        ${active ? '' : '<p class="hint">Zum Kalibrieren zuerst die Kamera starten.</p>'}
        ${resetBtn}`;
    } else {
      const chips = REGION_DEFS
        .filter((d) => !d.optional || calibration.splitEnabled)
        .map((d) => `
          <button type="button" class="chip ${this.editor.selected === d.id ? 'is-active' : ''}" data-action="select" data-id="${d.id}" style="--chip-color:${d.color}">
            <span class="chip-swatch"></span><b>${esc(d.short)}</b> ${esc(d.label)}
          </button>`).join('');
      calib = `
        <div class="edit-box">
          <p class="hint">Bereich ziehen = verschieben · Ecke ziehen = Grösse ändern. Lege B so gross an, dass zusätzliche Karten Platz haben.</p>
          <div class="chips">${chips}</div>
          <label class="row row--check">
            <span>Split-Bereich C verwenden</span>
            <input type="checkbox" data-action="split" ${calibration.splitEnabled ? 'checked' : ''}>
          </label>
          <button type="button" class="btn btn--success" data-action="save" ${dims ? '' : 'disabled'}>Kalibrierung speichern</button>
          <button type="button" class="btn btn--ghost" data-action="cancel">Abbrechen</button>
          ${resetBtn}
        </div>`;
    }

    const savedLine = saved
      ? `Gespeichert: ${esc(formatDate(saved.savedAt))} · ${saved.frame.orientation === 'landscape' ? 'Querformat' : 'Hochformat'} · ${saved.frame.width}×${saved.frame.height}`
      : 'Noch keine Kalibrierung gespeichert.';
    const dirty = calibration.dirty ? ' · <span class="text-warn">Ungespeicherte Änderungen</span>' : '';
    const notice = this._notice
      ? `<p class="notice notice--${this._notice.tone}" role="status">${this._notice.tone === 'ok' ? ICONS.check : ICONS.warning}<span>${esc(this._notice.text)}</span></p>`
      : '';

    return `
      <div class="controls">
        ${camBtn}
        ${calib}
        ${notice}
        <p class="meta">${savedLine}${dirty}</p>
        <div class="link-list">
          <button type="button" class="link-row" data-nav="anlernen">Karten anlernen ${ICONS.chevron}</button>
          <button type="button" class="link-row" data-nav="test">Testmodus öffnen ${ICONS.chevron}</button>
        </div>
        ${this._workaroundHtml()}
        <p class="footnote">Das Kamerabild bleibt auf diesem Gerät. Es wird nichts aufgenommen, gespeichert oder übertragen.</p>
      </div>`;
  }
}
