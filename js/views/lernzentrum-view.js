// Yumeko-Lernzentrum (0.10.0): Grundgerüst nach dem iPad-Design (quer 1180×820).
// Nur Oberfläche – keine KI, keine Lernfunktionen. Ab 0.11.0 öffnen die vier Kacheln eigene Unterseiten.
import { View } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { STANDARD_ID } from '../strategy/profiles.js';
import { AREAS, PROFILE_PANEL, yumekoStats, percentText, toggleYumeko } from '../lernzentrum/lernzentrum.js';
import { SUBPAGES } from '../lernzentrum/bereiche.js';

const AREA_ICONS = {
  karten: '<svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="3" width="12" height="16" rx="2"/><path d="M16 21H6a2 2 0 0 1-2-2V7"/></svg>',
  table: '<svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="10" rx="9" ry="5"/><path d="M3 10v3c0 2.8 4 5 9 5s9-2.2 9-5v-3"/></svg>',
  study: '<svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/></svg>',
  brain: '<svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4.5" r="2"/><circle cx="4.5" cy="12" r="2"/><circle cx="19.5" cy="12" r="2"/><circle cx="12" cy="19.5" r="2"/><path d="M10.6 5.9 5.9 10.6M13.4 5.9l4.7 4.7M5.9 13.4l4.7 4.7M18.1 13.4l-4.7 4.7"/></svg>'
};
const POWER = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>';
const CHECK = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

export class LernzentrumView extends View {
  mount() {
    this.el.className = 'screen screen-lz';
    this.panel = null;
    this.notice = null;
    this.el.addEventListener('click', (e) => this._onClick(e));
    this._onKey = (e) => { if (e.key === 'Escape' && this.panel) { this.panel = null; this.render(); } };
    document.addEventListener('keydown', this._onKey);
    const r = () => this.render();
    this.listen(this.ctx.profiles, 'change', r);
    if (this.ctx.archive) this.listen(this.ctx.archive, 'change', r);
    this.render();
  }

  destroy() {
    super.destroy();
    document.removeEventListener('keydown', this._onKey);
  }

  _onClick(e) {
    const btn = e.target.closest('[data-lz]');
    if (!btn) {
      if (this.panel && e.target.classList.contains('lz-backdrop')) { this.panel = null; this.render(); }
      return;
    }
    const a = btn.dataset.lz;
    if (a === 'open') this.panel = btn.dataset.id;
    else if (a === 'close') this.panel = null;
    else if (a === 'toggle') {
      try {
        toggleYumeko(this.ctx.profiles);
        this.notice = null;
      } catch (err) {
        this.notice = err.message || 'Das Yumeko-Profil konnte nicht umgeschaltet werden.';
      }
    }
    this.render();
    if (a === 'open') { const c = this.el.querySelector('.lz-dialog [data-lz="close"]'); if (c) c.focus(); }
  }

  render() {
    const { profiles, archive } = this.ctx;
    const active = profiles.yumekoActive;
    const s = yumekoStats(archive ? archive.rounds : []);
    const y = profiles.yumeko;
    const strategy = y ? (Object.keys(y.overrides).length ? 'Eigene Tabelle' : profiles.get(STANDARD_ID).name) : profiles.get(STANDARD_ID).name;
    const stats = [
      { label: 'HAND', value: s.hands, sub: 'gespielt', color: '#C5CBD3' },
      { label: 'WINS', value: s.win, sub: percentText(s.win, s.hands), color: '#34D399' },
      { label: 'LOSE', value: s.loss, sub: percentText(s.loss, s.hands), color: '#F87171' },
      { label: 'BUST', value: s.bust, sub: percentText(s.bust, s.hands), color: '#FB923C' },
      { label: 'GLEICHSTAND', value: s.push, sub: percentText(s.push, s.hands), color: '#60A5FA' }
    ];
    const panel = this.panel === 'profil' ? PROFILE_PANEL : null;

    this.el.innerHTML = `
      <div class="lz">
        <header class="lz-head">
          <div class="lz-head-left">
            <button type="button" class="lz-back" data-nav="haupt" aria-label="Zurück zum Blackjack-Assistenten">${ICONS.back}</button>
            <div class="lz-head-text">
              <h1 class="lz-title">Lernzentrum</h1>
              <span class="lz-subtitle">Yumeko AI · Training und Wissen</span>
            </div>
          </div>
          <div class="lz-head-right">
            <span class="lz-status" data-slot="lz-status"><span class="lz-dot ${active ? 'is-on' : ''}"></span>${active ? 'Profil aktiv' : 'Profil inaktiv'}</span>
            <div class="lz-avatar" role="img" aria-label="Yumeko">Y</div>
          </div>
        </header>

        <section class="lz-stats" aria-label="Statistik">
          ${stats.map((x) => `
            <div class="lz-stat">
              <span class="lz-stat-label"><span class="lz-stat-dot" style="background:${x.color}"></span>${esc(x.label)}</span>
              <span class="lz-stat-line"><span class="lz-stat-value">${esc(x.value)}</span><span class="lz-stat-sub">${esc(x.sub)}</span></span>
            </div>`).join('')}
        </section>

        <button type="button" class="lz-profile" data-lz="open" data-id="profil" aria-label="Yumeko Profil anzeigen">
          <span class="lz-profile-avatar">Y</span>
          <span class="lz-profile-text">
            <span class="lz-profile-name">Yumeko Profil</span>
            <span class="lz-profile-strategy">Strategie: <b>${esc(strategy)}</b></span>
          </span>
          ${ICONS.chevron}
        </button>

        <section class="lz-tiles" aria-label="Bereiche">
          ${AREAS.map((t) => `
            <button type="button" class="lz-tile" data-nav="${SUBPAGES[t.id]}" data-id="${t.id}" aria-label="${esc(t.title)} öffnen">
              <span class="lz-tile-icon" style="background:${t.tint};color:${t.color}">${AREA_ICONS[t.id]}</span>
              <span class="lz-tile-title">${esc(t.title)}</span>
            </button>`).join('')}
        </section>

        ${this.notice ? `<p class="notice notice--warn" role="alert">${ICONS.warning}<span>${esc(this.notice)}</span></p>` : ''}
        <button type="button" class="lz-activate ${active ? 'is-active' : ''}" data-lz="toggle" aria-pressed="${active}" ${profiles.readOnly ? 'disabled' : ''}>
          ${active ? CHECK : POWER}<span>${active ? 'Yumeko Profil aktiv' : 'Yumeko Profil aktivieren'}</span>
        </button>
      </div>
      ${panel ? `
        <div class="lz-backdrop">
          <div class="lz-dialog" role="dialog" aria-modal="true" aria-label="${esc(panel.title)}">
            <span class="lz-dialog-head"><span class="lz-dialog-dot" style="background:${panel.color}"></span><span class="lz-dialog-title">${esc(panel.title)}</span></span>
            <p class="lz-dialog-text">${esc(panel.text)}</p>
            <ul class="lz-dialog-points">
              ${panel.points.map((pt) => `<li><span style="background:${panel.color}"></span>${esc(pt)}</li>`).join('')}
            </ul>
            ${panel.id === 'profil' ? `
              <dl class="lz-facts">
                <div><dt>Status</dt><dd>${active ? 'Aktiv' : 'Inaktiv'}</dd></div>
                <div><dt>Strategie</dt><dd>${esc(strategy)}</dd></div>
                <div><dt>Lernstand</dt><dd>Yumeko lernt noch nichts</dd></div>
              </dl>` : ''}
            <div class="lz-placeholder">Platzhalter – der Aufbau dieses Bereichs folgt in einem späteren Schritt.</div>
            <button type="button" class="lz-close" data-lz="close">Schliessen</button>
          </div>
        </div>` : ''}`;
  }
}
