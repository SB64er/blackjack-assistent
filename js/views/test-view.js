// Testmodus für Phase 2: Checkliste mit den 7 Prüfschritten.
import { View, subHeader, cameraStatus, cameraButton } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { CameraState } from '../camera/camera-service.js';

export class TestView extends View {
  mount() {
    const { camera, calibration, test } = this.ctx;
    this.el.className = 'screen screen-sub';
    this.el.addEventListener('click', (e) => this._onClick(e));
    this.listen(test, 'change', () => this.render());
    this.listen(camera, 'state', () => this.render());
    this.listen(calibration, 'change', () => this.render());
    this.render();
  }

  async _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { test } = this.ctx;
    switch (btn.dataset.action) {
      case 'confirm-monitor': test.confirmMonitor(); break;
      case 'reset-test': test.reset(); break;
      default: break;
    }
  }

  render() {
    const { camera, calibration, test } = this.ctx;
    const steps = test.steps();
    const doneCount = steps.filter((s) => s.done).length;
    const cam = cameraStatus(this.ctx);
    const startup = calibration.loadedAtStartup;

    this.el.innerHTML = `
      ${subHeader('Testmodus', 'kamera')}
      <div class="sub-content">
        <p class="lead">Prüfe Kamera und Kalibrierung Schritt für Schritt. Erledigte Schritte werden automatisch abgehakt.</p>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="7" aria-valuenow="${doneCount}">
          <span style="width:${(doneCount / 7) * 100}%"></span>
        </div>
        <p class="meta">${doneCount} von 7 Schritten erledigt · <span class="dot dot--${cam.tone}"></span> ${esc(cam.label)}</p>

        <ol class="steps">
          ${steps.map((s) => `
            <li class="step ${s.done ? 'is-done' : ''} ${s.failed ? 'is-failed' : ''}">
              <span class="step-mark">${s.done ? ICONS.check : (s.failed ? ICONS.warning : s.n)}</span>
              <div class="step-body">
                <strong>${esc(s.title)}</strong>
                <span>${esc(s.hint)}</span>
                ${s.action === 'confirm-monitor' ? '<button type="button" class="btn btn--small" data-action="confirm-monitor">Ja, ich sehe den Monitor</button>' : ''}
              </div>
            </li>`).join('')}
        </ol>

        <div class="controls">
          ${camera.state === CameraState.ACTIVE ? '' : cameraButton(camera)}
          <button type="button" class="btn btn--secondary" data-nav="kamera">Zur Kamera &amp; Kalibrierung</button>
          <button type="button" class="btn btn--ghost" data-action="reset-test">Testfortschritt zurücksetzen</button>
        </div>

        <section class="group">
          <h2 class="group-title">BEIM START GELADEN</h2>
          <div class="list">
            <div class="row"><span>Kalibrierung</span><span class="row-value">${startup ? 'Ja' : 'Keine'}</span></div>
            ${startup ? `
              <div class="row"><span>Gespeichert am</span><span class="row-value">${esc(new Date(startup.savedAt).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' }))}</span></div>
              <div class="row"><span>Bildformat</span><span class="row-value">${startup.frame.width}×${startup.frame.height}</span></div>
              <div class="row"><span>Split-Bereich</span><span class="row-value">${startup.splitEnabled ? 'Aktiv' : 'Aus'}</span></div>` : ''}
          </div>
        </section>
      </div>`;
  }
}
