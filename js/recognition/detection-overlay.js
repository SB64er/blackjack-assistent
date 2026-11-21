// Zeigt erkannte Zeichen als Kästchen über dem Kamerabild (zur Kontrolle).
// Liegt – wie die Kalibrierung – exakt auf der sichtbaren Bildfläche.
import { containRect } from '../calibration/geometry.js';
import { esc } from '../core/dom.js';

export class DetectionOverlay {
  constructor({ stage, getFrameSize, onPick = null }) {
    this.stage = stage;
    this.getFrameSize = getFrameSize;
    this.onPick = onPick;
    this.el = document.createElement('div');
    this.el.className = 'detect-overlay';
    this.el.classList.toggle('is-pickable', !!onPick);
    stage.appendChild(this.el);
    this._boxes = [];
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-idx]');
      if (b && this.onPick) this.onPick(this._boxes[Number(b.dataset.idx)]);
    });
    this._ro = new ResizeObserver(() => this.layout());
    this._ro.observe(stage);
  }

  destroy() {
    this._ro.disconnect();
    this.el.remove();
  }

  layout() {
    const size = this.getFrameSize();
    const r = size && containRect(this.stage.clientWidth, this.stage.clientHeight, size.width, size.height);
    if (!r) { this.el.hidden = true; return; }
    this.el.hidden = false;
    Object.assign(this.el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  /** boxes: [{ x,y,w,h (0–1 Kamerabild), tone: 'ok'|'unsure'|'none'|'ignored', label, data }] */
  setBoxes(boxes) {
    this._boxes = boxes || [];
    this.layout();
    this.el.innerHTML = this._boxes.map((b, i) => {
      const tag = this.onPick ? 'button' : 'span';
      const attrs = this.onPick ? `type="button" data-idx="${i}" aria-label="Zeichen ${esc(b.label || 'unbekannt')} anlernen"` : 'aria-hidden="true"';
      return `<${tag} class="det det--${b.tone}" ${attrs} style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%">` +
        (b.label ? `<span class="det-label">${esc(b.label)}</span>` : '') + `</${tag}>`;
    }).join('');
  }
}

// Kandidaten einer Rohauswertung in Kästchen umwandeln.
export function boxesFromScan(scan, { includeUnknown = false } = {}) {
  if (!scan) return [];
  const out = [];
  for (const [regionId, r] of Object.entries(scan.regions)) {
    for (const c of r.candidates) {
      if (c.rotated) continue;
      const m = c.match;
      let tone = 'none';
      let label = '';
      if (m && m.status === 'ok') { tone = 'ok'; label = m.rank; }
      else if (m && m.status === 'unsure') { tone = 'unsure'; label = `${m.rank}?`; }
      else if (m && m.status === 'ignored') { tone = 'ignored'; }
      if (tone === 'none' && !includeUnknown) continue;
      if (tone === 'ignored' && !includeUnknown) continue;
      // Ohne Farbsymbol darunter ist es selten ein Rang – beim Anlernen nur dezent zeigen.
      out.push({ x: c.x, y: c.y, w: c.w, h: c.h, tone, label, data: { regionId, candidate: c, likelyRank: c.suitBelow } });
    }
  }
  return out;
}
