// Gemeinsame Bausteine der Lernzentrum-Unterseiten (ab 0.11.0).
import { ICONS, esc } from '../core/dom.js';

export const LZ_ICONS = {
  karten: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="3" width="12" height="16" rx="2"/><path d="M16 21H6a2 2 0 0 1-2-2V7"/></svg>',
  table: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="10" rx="9" ry="5"/><path d="M3 10v3c0 2.8 4 5 9 5s9-2.2 9-5v-3"/></svg>',
  study: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/></svg>',
  brain: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4.5" r="2"/><circle cx="4.5" cy="12" r="2"/><circle cx="19.5" cy="12" r="2"/><circle cx="12" cy="19.5" r="2"/><path d="M10.6 5.9 5.9 10.6M13.4 5.9l4.7 4.7M5.9 13.4l4.7 4.7M18.1 13.4l-4.7 4.7"/></svg>'
};

const COLORS = {
  karten: ['#60A5FA', 'rgba(96,165,250,0.12)'],
  table: ['#34D399', 'rgba(52,211,153,0.12)'],
  study: ['#A78BFA', 'rgba(167,139,250,0.12)'],
  brain: ['#F472B6', 'rgba(244,114,182,0.12)']
};

/** Kopfzeile: Zurück zum Lernzentrum, Bereichssymbol, Titel, rechts optionale Bedienelemente. */
export function lzHeader(id, title, subtitle, right = '') {
  const [color, tint] = COLORS[id];
  return `
    <header class="lz-head lzs-head">
      <div class="lz-head-left">
        <button type="button" class="lz-back" data-nav="lernzentrum" aria-label="Zurück zum Lernzentrum">${ICONS.back}</button>
        <span class="lzs-icon" style="background:${tint};color:${color}">${LZ_ICONS[id]}</span>
        <div class="lz-head-text">
          <h1 class="lz-title">${esc(title)}</h1>
          <span class="lz-subtitle">${esc(subtitle)}</span>
        </div>
      </div>
      ${right ? `<div class="lz-head-right lzs-head-right">${right}</div>` : ''}
    </header>`;
}

/** Segment-Umschalter (z. B. Deckzahl, Filter). items: [{ id, label }] */
export function segmented(items, current, action, { label = '', disabled = false, cls = '' } = {}) {
  return `<div class="lzs-seg ${cls}" role="group"${label ? ` aria-label="${esc(label)}"` : ''}>
    ${items.map((it) => `<button type="button" class="lzs-seg-btn" data-lzs="${action}" data-id="${esc(it.id)}" aria-pressed="${it.id === current}" ${disabled ? 'disabled' : ''}>${esc(it.label)}</button>`).join('')}
  </div>`;
}

/** Spielkarte (weiss). size: '' | 'sm' | 'xs' */
export function cardFace(rank, size = '') {
  return `<span class="lzs-card ${size ? `lzs-card--${size}` : ''}">${esc(rank)}</span>`;
}

/** Leerer Zustand mit gestricheltem Rahmen. */
export function emptyBox(title, text = '', cls = '') {
  return `<div class="lzs-empty ${cls}"><span class="lzs-empty-title">${esc(title)}</span>${text ? `<span class="lzs-empty-text">${esc(text)}</span>` : ''}</div>`;
}

export const DASH = '—';

/** Lernstands-Balken (Prozent 0–100). */
export function bar(pct, color) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<span class="lzs-bar"><span style="width:${p}%;background:${color}"></span></span>`;
}

/** Grundklasse: Klicks auf data-lzs an handle(action, id, el) weiterleiten, Zustand pro Seite merken. */
export function bindActions(view, handle) {
  view.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lzs]');
    if (!b || b.disabled) return;
    handle(b.dataset.lzs, b.dataset.id, b);
  });
}
