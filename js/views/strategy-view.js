// Strategieprofil-Manager (Phase 5): Liste, aktivieren, neu, duplizieren,
// löschen, KI-Strategie erstellen. Profilwechsel ohne Neuladen.
import { View, subHeader } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { TYPE_LABEL, STANDARD_ID } from '../strategy/profiles.js';
import { rulesText, normalizeRules } from '../strategy/standard.js';
import { RULES } from './settings-view.js';
import {
  developStrategy, RemoteResearchProvider, loadResearchConfig, saveResearchConfig, RESEARCH_STATUS_TEXT
} from '../strategy/research.js';

function formatDate(iso) {
  try { return new Date(iso).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; }
}

export function typeBadge(type) {
  return `<span class="type-badge type-badge--${esc(type)}">${type === 'ai' ? '✦ ' : ''}${esc(TYPE_LABEL[type] || type)}</span>`;
}

export class StrategyView extends View {
  mount() {
    this.el.className = 'screen screen-sub';
    this._notice = null;
    this._confirmDelete = null;
    this._sheet = null;
    this.el.innerHTML = `
      ${subHeader('Strategieprofile', 'einstellungen')}
      <div class="sub-content" data-slot="content"></div>
      <div class="sheet-backdrop" data-slot="sheet" hidden></div>`;
    this.el.addEventListener('click', (e) => this._onClick(e));
    this.listen(this.ctx.profiles, 'change', () => this.render());
    this.listen(this.ctx.settings, 'change', () => this.render());
    this.render();
  }

  destroy() {
    super.destroy();
    clearTimeout(this._deleteTimer);
  }

  _say(tone, text) {
    this._notice = { tone, text };
  }

  _try(fn) {
    try {
      return fn();
    } catch (err) {
      this._say('warn', err.message);
      this.render();
      return null;
    }
  }

  _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const { profiles } = this.ctx;
    const a = btn.dataset.action;
    const id = btn.dataset.id;
    this._notice = null;
    if (a === 'activate') {
      const p = this._try(() => profiles.activate(id));
      if (p) { this._say('ok', `„${p.name}“ ist jetzt aktiv.`); this.render(); }
    } else if (a === 'open') {
      this.ctx.ui.editProfileId = id;
      this.ctx.navigate('profil');
    } else if (a === 'duplicate') {
      const p = this._try(() => profiles.duplicate(id));
      if (p) { this._say('ok', `Kopie „${p.name}“ erstellt.`); this.render(); }
    } else if (a === 'delete') {
      if (this._confirmDelete !== id) {
        this._confirmDelete = id;
        clearTimeout(this._deleteTimer);
        this._deleteTimer = setTimeout(() => { this._confirmDelete = null; this.render(); }, 4000);
        this.render();
      } else {
        this._confirmDelete = null;
        const name = (profiles.get(id) || {}).name;
        if (this._try(() => profiles.remove(id))) { this._say('ok', `„${name}“ gelöscht.`); this.render(); }
      }
    } else if (a === 'new') {
      this._sheet = { type: 'new' };
      this._renderSheet();
    } else if (a === 'ai') {
      this._sheet = { type: 'ai', rules: normalizeRules(this.ctx.settings.get('rules')), useOnline: false, running: false };
      this._renderSheet();
    } else if (a === 'close-sheet') {
      this._sheet = null;
      this._renderSheet();
    } else if (a === 'create-new') {
      const sheet = this.el.querySelector('[data-slot="sheet"]');
      const name = sheet.querySelector('[name="name"]').value;
      const description = sheet.querySelector('[name="description"]').value;
      const p = this._try(() => profiles.create({ name: name || 'Mein Profil', description, type: 'custom', followTableRules: true }));
      if (p) {
        this._sheet = null;
        this._renderSheet();
        this.ctx.ui.editProfileId = p.id;
        this.ctx.navigate('profil');
      }
    } else if (a.startsWith('ai-rule:')) {
      const rule = RULES.find((r) => r.path === a.slice(8));
      const key = rule.path.split('.')[1];
      const i = rule.options.indexOf(this._sheet.rules[key]);
      this._sheet.rules[key] = rule.options[(i + 1) % rule.options.length];
      this._renderSheet();
    } else if (a === 'ai-online') {
      this._sheet.useOnline = !this._sheet.useOnline;
      this._renderSheet();
    } else if (a === 'ai-config-save') {
      const sheet = this.el.querySelector('[data-slot="sheet"]');
      try {
        saveResearchConfig({ endpoint: sheet.querySelector('[name="endpoint"]').value, consent: sheet.querySelector('[name="consent"]').checked });
        this._sheet.configNotice = { tone: 'ok', text: 'Gespeichert.' };
      } catch (err) {
        this._sheet.configNotice = { tone: 'warn', text: err.message };
      }
      this._renderSheet();
    } else if (a === 'ai-run') {
      this._runAi();
    } else if (a === 'ai-activate') {
      const p = this._try(() => profiles.activate(this._sheet.createdId));
      if (p) { this._sheet = null; this._renderSheet(); this._say('ok', `„${p.name}“ ist jetzt aktiv.`); this.render(); }
    } else if (a === 'ai-open') {
      this.ctx.ui.editProfileId = this._sheet.createdId;
      this._sheet = null;
      this.ctx.navigate('profil');
    }
  }

  async _runAi() {
    const s = this._sheet;
    s.running = true;
    s.error = null;
    this._renderSheet();
    // UI erst zeichnen lassen, dann rechnen.
    await new Promise((r) => setTimeout(r, 30));
    try {
      const cfg = loadResearchConfig();
      const remote = new RemoteResearchProvider(cfg);
      const out = await developStrategy(s.rules, { remote, useOnline: s.useOnline });
      const r = out.rules;
      const p = this.ctx.profiles.create({
        name: `KI-Strategie ${r.decks} D ${r.soft17 === 'zieht' ? 'H17' : 'S17'}`,
        description: `Mathematisch berechnet für ${rulesText(r)}. ${out.data.deviationsFromStandard} Abweichungen von der Standardstrategie.`,
        type: 'ai',
        rules: r,
        overrides: out.overrides,
        data: out.data
      });
      s.createdId = p.id;
      s.result = out;
    } catch (err) {
      s.error = err.message;
    }
    s.running = false;
    this._renderSheet();
  }

  _renderSheet() {
    const sheet = this.el.querySelector('[data-slot="sheet"]');
    const s = this._sheet;
    if (!s) { sheet.hidden = true; sheet.innerHTML = ''; return; }
    sheet.hidden = false;
    if (s.type === 'new') {
      sheet.innerHTML = `
        <div class="sheet" role="dialog" aria-modal="true" aria-label="Neues Strategieprofil">
          <strong class="sheet-title">Neues Strategieprofil</strong>
          <p class="hint">Startet als Kopie der Standardstrategie. Danach kannst du einzelne Entscheidungen in der Tabelle ändern.</p>
          <label class="field"><span>Name</span><input name="name" type="text" maxlength="60" placeholder="z. B. Mein Casino" autocomplete="off"></label>
          <label class="field"><span>Beschreibung</span><textarea name="description" rows="3" maxlength="500" placeholder="Wofür ist dieses Profil?"></textarea></label>
          <button type="button" class="btn btn--primary" data-action="create-new">Profil erstellen</button>
          <button type="button" class="btn btn--ghost" data-action="close-sheet">Abbrechen</button>
        </div>`;
      return;
    }
    // KI-Strategie
    const cfg = loadResearchConfig();
    const remote = new RemoteResearchProvider(cfg);
    const status = !cfg.endpoint ? 'not-configured' : (!cfg.consentAt ? 'no-consent' : (navigator.onLine ? 'ok' : 'offline'));
    const onlineReady = status === 'ok';
    const rules = s.rules;
    let body;
    if (s.running) {
      body = '<div class="progress-box"><span class="spinner" aria-hidden="true"></span><span>Berechne Erwartungswerte für alle Hände …</span></div>';
    } else if (s.result) {
      const res = s.result.data.research;
      body = `
        <p class="notice notice--ok">${ICONS.check}<span>KI-Strategie erstellt und als eigenes Profil gespeichert. ${s.result.data.deviationsFromStandard} Abweichungen von der Standardstrategie.</span></p>
        <p class="hint">Online-Recherche: <b>${esc(RESEARCH_STATUS_TEXT[res.status] || res.status)}</b>${res.message ? ` – ${esc(res.message)}` : ''}</p>
        <button type="button" class="btn btn--primary" data-action="ai-activate">Profil aktivieren</button>
        <button type="button" class="btn btn--secondary" data-action="ai-open">Profil und Analyse ansehen</button>
        <button type="button" class="btn btn--ghost" data-action="close-sheet">Schliessen</button>`;
    } else {
      body = `
        <div class="list">
          ${RULES.map((r) => `
            <button type="button" class="row row--btn" data-action="ai-rule:${r.path}">
              <span>${esc(r.label)}</span><span class="row-value">${esc(r.text(rules[r.path.split('.')[1]]))} ${ICONS.chevron}</span>
            </button>`).join('')}
        </div>
        <div class="source-box">
          <strong>1. Mathematische Berechnung <span class="kind kind--calc">berechnet</span></strong>
          <p>Auf diesem Gerät, offline: exakte Erwartungswerte für jede Hand gegen jede Dealerkarte (Modell mit unendlich vielen Decks). Die beste Aktion je Zelle wird übernommen.</p>
        </div>
        <div class="source-box">
          <strong>2. Online-Recherche <span class="kind kind--ai">KI-Vorschlag</span></strong>
          <p class="${onlineReady ? '' : 'text-warn'}"><b>${esc(RESEARCH_STATUS_TEXT[status])}.</b> ${onlineReady
            ? 'Gesendet werden nur die Tischregeln. Vorschläge werden mit dem Rechenmodell geprüft und nicht automatisch übernommen.'
            : 'Die App täuscht keine Recherche vor. Für echte Online-Recherche wird ein eigener Server benötigt (siehe „Einrichten“).'}</p>
          <label class="row row--check"><span>Online-Recherche verwenden</span>
            <input type="checkbox" data-action="ai-online" ${s.useOnline ? 'checked' : ''} ${onlineReady ? '' : 'disabled'}></label>
          <details class="setup">
            <summary>Einrichten (eigener Server)</summary>
            <p class="hint">Trage die https-Adresse deines eigenen Recherche-Servers ein. Der Server hält den API-Schlüssel (z. B. für eine KI- oder Suchschnittstelle) – <b>nie</b> die App. Er erhält die Tischregeln und antwortet mit Quellen (Titel, URL, Abrufdatum), Zusammenfassung und Vorschlägen. Mögliche Kosten entstehen bei deinem Anbieter.</p>
            <label class="field"><span>Server-Adresse (https)</span><input name="endpoint" type="url" inputmode="url" autocomplete="off" placeholder="https://…" value="${esc(cfg.endpoint)}"></label>
            <label class="row row--check"><span>Ich stimme zu, dass die Tischregeln an diese Adresse gesendet werden.</span><input type="checkbox" name="consent" ${cfg.consentAt ? 'checked' : ''}></label>
            <button type="button" class="btn btn--secondary" data-action="ai-config-save">Speichern</button>
            ${s.configNotice ? `<p class="notice notice--${s.configNotice.tone}">${s.configNotice.tone === 'ok' ? ICONS.check : ICONS.warning}<span>${esc(s.configNotice.text)}</span></p>` : ''}
          </details>
        </div>
        ${s.error ? `<p class="notice notice--warn">${ICONS.warning}<span>${esc(s.error)}</span></p>` : ''}
        <button type="button" class="btn btn--primary" data-action="ai-run">Strategie berechnen und speichern</button>
        <button type="button" class="btn btn--ghost" data-action="close-sheet">Abbrechen</button>`;
    }
    void remote;
    sheet.innerHTML = `
      <div class="sheet sheet--wide" role="dialog" aria-modal="true" aria-label="KI-Strategie erstellen">
        <strong class="sheet-title">✦ KI-Strategie erstellen</strong>
        <p class="hint">Für die gewählten Tischregeln: ${esc(rulesText(rules))}</p>
        ${body}
      </div>`;
  }

  render() {
    const { profiles } = this.ctx;
    const active = profiles.active;
    const list = [...profiles.list()].sort((a, b) => (a.id === active.id ? -1 : b.id === active.id ? 1 : 0));
    const notice = this._notice
      ? `<p class="notice notice--${this._notice.tone}" role="status">${this._notice.tone === 'ok' ? ICONS.check : ICONS.warning}<span>${esc(this._notice.text)}</span></p>` : '';
    const warn = [];
    if (profiles.readOnly) warn.push(`<p class="notice notice--warn">${ICONS.warning}<span>${esc(profiles.error)} Die Profile werden nur angezeigt und nicht verändert.</span></p>`);
    if (profiles.invalidCount) warn.push(`<p class="notice notice--warn">${ICONS.warning}<span>${profiles.invalidCount} gespeicherte Einträge konnten nicht gelesen werden. Sie wurden unverändert aufbewahrt und nicht gelöscht.</span></p>`);

    const cards = list.map((p) => {
      const isActive = p.id === active.id;
      const dev = Object.keys(p.overrides).length;
      const confirm = this._confirmDelete === p.id;
      const st = profiles.strategyFor(p);
      return `
        <article class="profile-card ${isActive ? 'is-active' : ''} profile-card--${esc(p.type)}">
          <div class="profile-card-head">
            <div class="profile-card-title">
              <strong>${esc(p.name)}</strong>
              ${typeBadge(p.type)}
            </div>
            ${isActive ? `<span class="active-chip">${ICONS.check}AKTIV</span>` : ''}
          </div>
          ${p.description ? `<p class="profile-card-desc">${esc(p.description)}</p>` : ''}
          <p class="meta">${esc(p.settings.followTableRules ? 'Folgt den Tischregeln' : rulesText(p.rules))} · ${p.type === 'standard' ? 'Referenztabelle' : `${dev} ${dev === 1 ? 'Abweichung' : 'Abweichungen'}`}${p.id !== STANDARD_ID ? ` · geändert ${esc(formatDate(p.updatedAt))}` : ''}</p>
          ${st.rulesMismatch ? `<p class="meta text-warn">${ICONS.warning} Für andere Tischregeln erstellt</p>` : ''}
          <div class="profile-actions">
            ${isActive ? '' : `<button type="button" class="btn btn--primary btn--compact" data-action="activate" data-id="${esc(p.id)}">Aktivieren</button>`}
            <button type="button" class="btn btn--secondary btn--compact" data-action="open" data-id="${esc(p.id)}">${p.type === 'standard' ? 'Ansehen' : 'Bearbeiten'}</button>
            <button type="button" class="btn btn--ghost btn--compact" data-action="duplicate" data-id="${esc(p.id)}">Duplizieren</button>
            ${p.type === 'standard' ? '' : (isActive
              ? '<span class="hint profile-hint">Aktives Profil – zum Löschen zuerst ein anderes aktivieren</span>'
              : `<button type="button" class="btn ${confirm ? 'btn--danger' : 'btn--ghost'} btn--compact" data-action="delete" data-id="${esc(p.id)}">${confirm ? 'Wirklich löschen?' : 'Löschen'}</button>`)}
          </div>
        </article>`;
    }).join('');

    this.el.querySelector('[data-slot="content"]').innerHTML = `
      <p class="lead">Die Empfehlungen richten sich nach dem <b>aktiven</b> Profil. Es ist immer genau ein Profil aktiv. Wechseln geht ohne Neuladen.</p>
      ${notice}${warn.join('')}
      <div class="profile-toolbar">
        <button type="button" class="btn btn--secondary" data-action="new">+ Neues Profil</button>
        <button type="button" class="btn btn--ai" data-action="ai">✦ KI-Strategie erstellen</button>
      </div>
      <div class="profile-list">${cards}</div>
      <p class="footnote">Profile werden nur auf diesem Gerät gespeichert und funktionieren auch offline.</p>`;
  }
}
