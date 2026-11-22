// Overlay mit den farbigen Kalibrierungsbereichen über dem Kamerabild.
// - Das Overlay deckt exakt die sichtbare Bildfläche ab (object-fit: contain),
//   daher keine Verzerrung und keine Verschiebung durch Ränder.
// - Im Bearbeitungsmodus: Bereich ziehen = verschieben,
//   Eckpunkt ziehen = Grösse ändern (Pointer Events, funktioniert mit dem Finger).
import { containRect, moveRect, resizeRect } from './geometry.js';
import { REGION_DEFS } from './calibration-store.js';
import { esc } from '../core/dom.js';

const CORNERS = ['nw', 'ne', 'sw', 'se'];

export class CalibrationEditor {
  /**
   * @param {HTMLElement} stage – Container, in dem auch das Video liegt
   * @param {() => ({width:number,height:number}|null)} getFrameSize – Bildgrösse in Pixeln
   * @param {(id:string, rect:object) => void} onRegionChange
   */
  constructor({ stage, getFrameSize, onRegionChange }) {
    this.stage = stage;
    this.getFrameSize = getFrameSize;
    this.onRegionChange = onRegionChange;
    this.regions = null;
    this.editing = false;
    this.dimmed = false;
    this.selected = 'dealer';
    this._drag = null;

    this.overlay = document.createElement('div');
    this.overlay.className = 'calib-overlay';
    this.overlay.hidden = true;
    stage.appendChild(this.overlay);

    this._onDown = (e) => this._pointerDown(e);
    this._onMove = (e) => this._pointerMove(e);
    this._onUp = (e) => this._pointerUp(e);
    this.overlay.addEventListener('pointerdown', this._onDown);
    this.overlay.addEventListener('pointermove', this._onMove);
    this.overlay.addEventListener('pointerup', this._onUp);
    this.overlay.addEventListener('pointercancel', this._onUp);

    this._ro = new ResizeObserver(() => this.layout());
    this._ro.observe(stage);
    this._onWinResize = () => this.layout();
    window.addEventListener('orientationchange', this._onWinResize);
  }

  destroy() {
    this._ro.disconnect();
    window.removeEventListener('orientationchange', this._onWinResize);
    this.overlay.remove();
  }

  setState({ regions, editing, dimmed = false }) {
    this.regions = regions;
    this.editing = editing;
    this.dimmed = dimmed;
    this.overlay.classList.toggle('is-editing', editing);
    this.overlay.classList.toggle('is-dimmed', dimmed);
    if (!this._drag) this.render();
    this.layout();
  }

  select(id) {
    this.selected = id;
    for (const el of this.overlay.querySelectorAll('.region')) {
      el.classList.toggle('is-selected', el.dataset.id === id);
    }
  }

  // Overlay genau auf die sichtbare Bildfläche legen.
  layout() {
    const size = this.getFrameSize();
    const rect = size && containRect(this.stage.clientWidth, this.stage.clientHeight, size.width, size.height);
    if (!rect || !this.regions) {
      this.overlay.hidden = true;
      return;
    }
    this.overlay.hidden = false;
    const s = this.overlay.style;
    s.left = `${rect.left}px`;
    s.top = `${rect.top}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
  }

  render() {
    this.overlay.textContent = '';
    if (!this.regions) return;
    for (const def of REGION_DEFS) {
      const r = this.regions[def.id];
      if (!r) continue;
      const el = document.createElement('div');
      el.className = 'region';
      el.dataset.id = def.id;
      el.style.setProperty('--region-color', def.color);
      el.classList.toggle('is-selected', this.editing && def.id === this.selected);
      el.innerHTML = `<span class="region-label">${esc(def.short)}</span>` +
        (this.editing ? CORNERS.map((c) => `<span class="handle handle-${c}" data-corner="${c}" aria-hidden="true"></span>`).join('') : '');
      el.setAttribute('aria-label', `${def.short}: ${def.label}`);
      this._applyRect(el, r);
      this.overlay.appendChild(el);
    }
  }

  _applyRect(el, r) {
    el.style.left = `${r.x * 100}%`;
    el.style.top = `${r.y * 100}%`;
    el.style.width = `${r.w * 100}%`;
    el.style.height = `${r.h * 100}%`;
  }

  _pointerDown(e) {
    if (!this.editing || this._drag) return;
    const regionEl = e.target.closest('.region');
    if (!regionEl) return;
    e.preventDefault();
    const id = regionEl.dataset.id;
    const handleEl = e.target.closest('.handle');
    const box = this.overlay.getBoundingClientRect();
    this.select(id);
    // Ausgewählten Bereich nach vorne holen
    this.overlay.appendChild(regionEl);
    this._drag = {
      id,
      el: regionEl,
      corner: handleEl ? handleEl.dataset.corner : null,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      boxW: box.width,
      boxH: box.height,
      start: { ...this.regions[id] }
    };
    regionEl.classList.add('is-dragging');
    try { regionEl.setPointerCapture(e.pointerId); } catch { /* egal */ }
  }

  _pointerMove(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    const dx = (e.clientX - d.startX) / d.boxW;
    const dy = (e.clientY - d.startY) / d.boxH;
    const next = d.corner ? resizeRect(d.start, d.corner, dx, dy) : moveRect(d.start, dx, dy);
    this.regions[d.id] = next;
    this._applyRect(d.el, next);
  }

  _pointerUp(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.pointerId) return;
    d.el.classList.remove('is-dragging');
    try { d.el.releasePointerCapture(e.pointerId); } catch { /* egal */ }
    this._drag = null;
    this.onRegionChange(d.id, { ...this.regions[d.id] });
  }
}
