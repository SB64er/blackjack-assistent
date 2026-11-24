// Lernzentrum › Brain (ab 0.11.0). Design: Brain.dc.html (iPad quer 1180×820), Zustand "Start (leer)".
// Yumekos Gedächtnis. Vorerst leer; Daten kommen aus brainState(). Das Gedächtnis der früheren
// KI (bis 0.8.0) wird hier bewusst NICHT angezeigt.
import { View } from './view-base.js';
import { esc } from '../core/dom.js';
import { lzHeader, emptyBox, bindActions } from './lz-common.js';
import { brainState, brainStats, BRAIN_AREAS, NOT_READY_TEXT } from '../lernzentrum/bereiche.js';

const SEARCH = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const memo = { area: 'knowledge', entry: 0 };

export class BrainView extends View {
  mount() {
    this.el.className = 'screen screen-lz lzs lzs-brain';
    bindActions(this, (a, id) => {
      if (a === 'area') { memo.area = id; memo.entry = 0; }
      else if (a === 'entry') memo.entry = Number(id);
      this.render();
    });
    this.render();
  }

  render() {
    const st = brainState();
    const n = brainStats(st);
    const area = BRAIN_AREAS.find((a) => a.id === memo.area) || BRAIN_AREAS[0];
    const list = st.entries[area.id] || [];
    const total = n.knowledge;
    const entry = list[memo.entry] || null;

    this.el.innerHTML = `
      <div class="lz">
        ${lzHeader('brain', 'Brain', 'Yumekos Gedächtnis', `
          <label class="lzs-search">${SEARCH}<span class="sr-only">Wissen durchsuchen</span>
            <input type="search" placeholder="Wissen durchsuchen …" ${total ? '' : `disabled title="${esc(NOT_READY_TEXT)}"`}>
          </label>`)}
        <section class="lzs-statbar" aria-label="Brain Statistik">
          ${[['Gespeichertes Wissen', n.knowledge], ['Erfahrungen', n.experience], ['Strategien', n.strategies], ['Lernquellen', n.sources]]
            .map(([l, v]) => `<div class="lzs-statbar-item"><span class="lzs-muted">${l}</span><span class="lzs-statbar-val">${v}</span></div>`).join('')}
        </section>
        <div class="lzs-body lzs-row lzs-gap16">
          <div class="lzs-col lzs-side">
            <nav class="lzs-stack6" aria-label="Wissensbereiche">
              ${BRAIN_AREAS.map((a) => {
                const c = (st.entries[a.id] || []).length;
                const on = a.id === area.id;
                return `<button type="button" class="lzs-area" data-lzs="area" data-id="${a.id}" aria-current="${on}" style="${on ? `border-color:${a.color}` : ''}">
                  <span class="lzs-area-dot" style="background:${c ? a.color : '#4B5563'};box-shadow:${c ? `0 0 10px ${a.glow}` : 'none'}"></span>
                  <span class="lzs-area-label">${esc(a.label)}</span><span class="lzs-muted lzs-tnum">${c}</span></button>`;
              }).join('')}
            </nav>
            <section class="lzs-panel lzs-grow lzs-stack10" aria-label="Letzte Erkenntnisse">
              <span class="lzs-cap">LETZTE ERKENNTNISSE</span>
              ${st.recent.length ? st.recent.map((r) => `<div class="lzs-stack2"><span class="lzs-text-sm">${esc(r.text)}</span><span class="lzs-muted lzs-xs">${esc(r.meta)}</span></div>`).join('')
                : '<span class="lzs-muted lzs-text-sm">Noch keine Erkenntnisse.</span>'}
            </section>
          </div>
          <div class="lzs-col lzs-grow">
            <section class="lzs-net" aria-label="Wissensnetz">
              <span class="lzs-cap lzs-net-cap">WISSENSNETZ</span>
              <span class="lzs-muted lzs-small lzs-net-fill">${total ? `Gedächtnis wächst · ${total} Einträge` : 'Gedächtnis leer'}</span>
              ${network(st, area.id)}
            </section>
            <section class="lzs-panel lzs-grow lzs-stack6" aria-label="Wissenseinträge">
              <div class="lzs-spread"><span class="lzs-cap">${esc(area.label.toUpperCase())}</span><span class="lzs-muted lzs-small">${list.length} Einträge</span></div>
              ${list.length ? list.map((e, i) => `<button type="button" class="lzs-entry" data-lzs="entry" data-id="${i}" aria-pressed="${i === memo.entry}"><span class="lzs-entry-title">${esc(e.title)}</span><span class="lzs-small" style="color:${e.ok ? '#6EE7B7' : '#FDBA74'}">${esc(e.verified)}</span></button>`).join('')
                : emptyBox('Noch kein Wissen gespeichert', 'Das Gedächtnis füllt sich, sobald Yumeko über Karten, AI Table und Study lernt.', 'lzs-grow')}
            </section>
          </div>
          <section class="lzs-panel lzs-detail" aria-label="Wissenseintrag">
            ${entry ? detail(entry, area) : `
              <div class="lzs-detail-empty">
                <span class="lzs-y-empty">Y</span>
                <span class="lzs-empty-title">Leeres Gedächtnis</span>
                <span class="lzs-muted lzs-text-sm">Hier erscheinen später einzelne Wissenseinträge mit Herkunft, Datum, Überprüfung und Verlauf.</span>
              </div>`}
          </section>
        </div>
      </div>`;
  }
}

// Wissensnetz als skalierbares SVG (520×284 wie im Design). Leer: gestrichelte Bereiche ohne Verbindungen.
function network(st, current) {
  const cx = 260, cy = 150;
  let links = '', nodes = '', dots = '';
  BRAIN_AREAS.forEach((a, i) => {
    const ang = -Math.PI / 2 + i * (Math.PI * 2 / BRAIN_AREAS.length);
    const x = cx + Math.cos(ang) * 172, y = cy + Math.sin(ang) * 86;
    const c = (st.entries[a.id] || []).length;
    const on = a.id === current && c > 0;
    const r = c ? 12 + Math.sqrt(c) * 1.6 : 14;
    const col = c ? a.color : '#3A404A';
    if (c) {
      links += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${a.color}" stroke-width="${on ? 1.6 : 1}" stroke-opacity="${on ? 0.7 : 0.25}"/>`;
      const k = Math.min(14, Math.round(c / 4) + 2);
      for (let j = 0; j < k; j++) {
        const aa = ang + (j - k / 2) * 0.16, rr = r + 10 + (j % 3) * 7, dr = 1.6 + (j % 2);
        dots += `<circle cx="${(x + Math.cos(aa) * rr).toFixed(1)}" cy="${(y + Math.sin(aa) * rr * 0.75).toFixed(1)}" r="${dr}" fill="${a.color}" opacity="${on ? 0.9 : 0.45}"/>`;
      }
    }
    nodes += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="#0E1015" stroke="${col}" stroke-width="${on ? 2.5 : 1.2}" ${c ? '' : 'stroke-dasharray="3 3"'}/>
      <text x="${x.toFixed(1)}" y="${(y + r + 14).toFixed(1)}" text-anchor="middle" class="lzs-net-label" fill="${c ? (on ? '#F2F4F7' : '#9AA3AE') : '#6B7280'}">${esc(a.label)}</text>`;
  });
  return `<svg class="lzs-net-svg" role="img" aria-label="${dots ? 'Wissensnetz mit sechs Bereichen' : 'Leeres Wissensnetz mit sechs Bereichen'}" viewBox="0 0 520 284" preserveAspectRatio="xMidYMid meet">
    <circle cx="${cx}" cy="${cy}" r="118" fill="none" stroke="#1C2028" stroke-dasharray="2 6"/>
    <circle cx="${cx}" cy="${cy}" r="64" fill="none" stroke="#1C2028" stroke-dasharray="2 6"/>
    ${links}${dots}${nodes}
    <circle cx="${cx}" cy="${cy}" r="22" fill="#16111A" stroke="#F472B6" stroke-width="1.5"/>
    <text x="${cx}" y="${cy + 6}" text-anchor="middle" class="lzs-net-y">Y</text>
  </svg>`;
}

function detail(e, area) {
  return `
    <div class="lzs-stack8">
      <span class="lzs-cap" style="color:${area.color}">${esc(area.label.toUpperCase())}</span>
      <span class="lzs-val lzs-val--sm">${esc(e.title)}</span>
      <span class="lzs-text-sm">${esc(e.text)}</span>
    </div>
    <div class="lzs-detail-grid">
      ${[['Quelle', e.source], ['Gelernt am', e.date], ['Überprüft', e.verified], ['Sicherheit', e.confidence]].map(([l, v]) => `<span class="lzs-stack2"><span class="lzs-muted lzs-xs">${l}</span><b class="lzs-small">${esc(v)}</b></span>`).join('')}
    </div>
    <div class="lzs-stack10"><span class="lzs-cap">ENTWICKLUNG</span>
      ${(e.history || []).map((h) => `<span class="lzs-stack2"><span class="lzs-text-sm">${esc(h.text)}</span><span class="lzs-muted lzs-xs">${esc(h.when)}</span></span>`).join('')}
    </div>`;
}

