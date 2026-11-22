// Strategieprofil ansehen/bearbeiten (Phase 5): Name, Beschreibung, Regeln,
// Strategietabelle, Analyse (berechnet / Simulation), KI-Daten mit Quellen.
import { View, subHeader } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { typeBadge } from './strategy-view.js';
import { RULES } from './settings-view.js';
import { STANDARD_ID } from '../strategy/profiles.js';
import {
  ROWS, UPCARDS, cellKey, standardCode, CODES_BY_KIND, CODE_LABEL, rulesText, upLabel, rowLabel, STANDARD_SOURCE, normalizeRules
} from '../strategy/standard.js';
import { modelFor } from '../strategy/ev.js';
import { analyzeProfile, pct } from '../strategy/analysis.js';
import { Simulation } from '../strategy/simulate.js';
import { RESEARCH_STATUS_TEXT } from '../strategy/research.js';

const KIND_LABEL = { hard: 'Hart', soft: 'Weich', pair: 'Paare' };
const ACTION_DE = { HIT: 'Ziehen', STAND: 'Stehen', DOUBLE: 'Verdoppeln', SPLIT: 'Splitten', SURRENDER: 'Aufgeben' };
const SIM_TOTAL = 500000;
const SIM_CHUNK = 10000;

function codeTone(code) {
  if (code === 'H') return 'hit';
  if (code === 'S') return 'stand';
  if (code === 'D' || code === 'Ds') return 'double';
  if (code === 'P' || code === 'Ph') return 'split';
  return 'surrender';
}

function cellText(kind, v) {
  if (kind === 'hard') return `Hart ${v}`;
  if (kind === 'soft') return `Weich ${v} (${rowLabel(kind, v)})`;
  return `Paar ${rowLabel(kind, v)}`;
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; }
}

export class ProfileView extends View {
  mount() {
    this.el.className = 'screen screen-sub screen-profile';
    this.tab = 'hard';
    this._notice = null;
    this._analysis = null;
    this._sim = null;
    this._picked = null;
    this.el.addEventListener('click', (e) => this._onClick(e));
    this.listen(this.ctx.profiles, 'change', () => { this._analysis = null; this.render(); });
    this.listen(this.ctx.settings, 'change', ({ path }) => { if (path.startsWith('rules')) { this._analysis = null; this._stopSim(); this.render(); } });
    this.render();
  }

  destroy() {
    super.destroy();
    this._stopSim();
  }

  get profile() {
    return this.ctx.profiles.get(this.ctx.ui.editProfileId) || null;
  }

  get editable() {
    const p = this.profile;
    return p && p.type !== 'standard' && !this.ctx.profiles.readOnly;
  }

  _strategyRules(p) {
    return this.ctx.profiles.strategyFor(p).strategyRules;
  }

  _tableRules() {
    return normalizeRules(this.ctx.settings.get('rules'));
  }

  _say(tone, text) { this._notice = { tone, text }; }

  _try(fn) {
    try { return fn(); } catch (err) { this._say('warn', err.message); this.render(); return null; }
  }

  _stopSim() {
    if (this._simTimer) clearTimeout(this._simTimer);
    this._simTimer = null;
    if (this._sim) this._sim.running = false;
  }

  _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const { profiles } = this.ctx;
    const p = this.profile;
    if (!p) return;
    const a = btn.dataset.action;
    this._notice = null;
    if (a === 'tab') { this.tab = btn.dataset.tab; this.render(); }
    else if (a === 'activate') { if (this._try(() => profiles.activate(p.id))) { this._say('ok', 'Profil aktiviert.'); this.render(); } }
    else if (a === 'duplicate') {
      const c = this._try(() => profiles.duplicate(p.id));
      if (c) { this.ctx.ui.editProfileId = c.id; this._say('ok', `Kopie „${c.name}“ erstellt – jetzt bearbeitbar.`); this.render(); }
    } else if (a === 'save-details') {
      const name = this.el.querySelector('[name="name"]').value;
      const description = this.el.querySelector('[name="description"]').value;
      if (this._try(() => profiles.update(p.id, { name, description }))) { this._say('ok', 'Gespeichert.'); this.render(); }
    } else if (a === 'follow') {
      this._try(() => profiles.update(p.id, { followTableRules: !p.settings.followTableRules, rules: this._tableRules() }));
    } else if (a === 'take-table') {
      this._try(() => profiles.update(p.id, { rules: this._tableRules() }));
    } else if (a === 'apply-to-table') {
      const r = p.rules;
      for (const k of Object.keys(r)) this.ctx.settings.set(`rules.${k}`, r[k]);
      this._say('ok', 'Tischregeln an das Profil angepasst.');
      this.render();
    } else if (a.startsWith('rule:')) {
      const rule = RULES.find((r) => r.path === a.slice(5));
      const key = rule.path.split('.')[1];
      const i = rule.options.indexOf(p.rules[key]);
      const rules = { ...p.rules, [key]: rule.options[(i + 1) % rule.options.length] };
      this._try(() => profiles.update(p.id, { rules }));
    } else if (a === 'cell') {
      this._picked = btn.dataset.key;
      this._renderSheet();
    } else if (a === 'set-code') {
      const code = btn.dataset.code || null;
      if (this._try(() => profiles.setCell(p.id, this._picked, code))) { this._picked = null; this._renderSheet(); }
    } else if (a === 'close-sheet') { this._picked = null; this._renderSheet(); }
    else if (a === 'reset-cells') {
      if (!this._confirmReset) { this._confirmReset = true; this.render(); setTimeout(() => { this._confirmReset = false; this.render(); }, 4000); }
      else { this._confirmReset = false; this._try(() => profiles.resetCells(p.id)); }
    } else if (a === 'analyze') {
      this._analysis = { running: true };
      this.render();
      setTimeout(() => {
        try { this._analysis = analyzeProfile(p, this._tableRules()); } catch (err) { this._analysis = { error: err.message }; }
        this.render();
      }, 30);
    } else if (a === 'simulate') this._startSim(p);
    else if (a === 'sim-stop') { this._stopSim(); this.render(); }
  }

  _startSim(p) {
    this._stopSim();
    const st = this.ctx.profiles.strategyFor(p);
    const seed = 20261122;
    const sim = new Simulation({ rules: this._tableRules(), overrides: st.overrides, strategyRules: st.strategyRules, seed });
    this._sim = { sim, running: true, result: sim.result(), profileId: p.id };
    const tick = () => {
      if (!this._sim || !this._sim.running) return;
      this._sim.result = sim.step(SIM_CHUNK);
      if (sim.rounds >= SIM_TOTAL) this._sim.running = false;
      this._renderSim();
      if (this._sim.running) this._simTimer = setTimeout(tick, 0);
    };
    this.render();
    this._simTimer = setTimeout(tick, 30);
  }

  _renderSheet() {
    let sheet = this.el.querySelector('[data-slot="sheet"]');
    const p = this.profile;
    if (!this._picked || !p) { if (sheet) { sheet.hidden = true; sheet.innerHTML = ''; } return; }
    const [kind, v, up] = this._picked.split(':');
    const value = Number(v);
    const u = Number(up);
    const std = standardCode(kind, value, u, this._strategyRules(p));
    const cur = p.overrides[this._picked] || std;
    const m = modelFor(u, this._tableRules());
    const evs = m.cellEVs(kind, value);
    const best = Object.entries(evs).sort((x, y) => y[1] - x[1])[0][0];
    sheet.hidden = false;
    sheet.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Entscheidung wählen">
        <strong class="sheet-title">${esc(cellText(kind, value))} gegen ${esc(upLabel(u))}</strong>
        <p class="hint">Standard: <b>${esc(std)}</b> – ${esc(CODE_LABEL[std])}</p>
        <div class="code-grid">
          ${CODES_BY_KIND[kind].map((c) => `
            <button type="button" class="code-btn code--${codeTone(c)} ${c === cur ? 'is-current' : ''}" data-action="set-code" data-code="${c}" ${this.editable ? '' : 'disabled'}>
              <b>${c}</b><small>${esc(CODE_LABEL[c])}</small>
            </button>`).join('')}
        </div>
        ${this.editable && p.overrides[this._picked] ? '<button type="button" class="btn btn--secondary" data-action="set-code" data-code="">Zurück zur Standardstrategie</button>' : ''}
        <div class="ev-box">
          <strong>Erwartungswerte <span class="kind kind--calc">berechnet</span></strong>
          <dl class="ev-list">${Object.entries(evs).map(([k, x]) => `<dt>${esc(ACTION_DE[k])}${k === best ? ' ★' : ''}</dt><dd>${esc(pct(x / (k === 'DOUBLE' ? 1 : 1), 2))}</dd>`).join('')}</dl>
          <p class="hint">Pro ursprünglichem Einsatz, im Modell mit unendlich vielen Decks, ohne Dealer-Blackjack. Verdoppeln und Split enthalten den doppelten Einsatz. ★ = höchster Wert.</p>
        </div>
        <button type="button" class="btn btn--ghost" data-action="close-sheet">Schliessen</button>
      </div>`;
  }

  _tableHtml(p) {
    const rules = this._strategyRules(p);
    const kind = this.tab;
    const head = `<tr><th scope="col">${esc(KIND_LABEL[kind])}</th>${UPCARDS.map((u) => `<th scope="col">${upLabel(u)}</th>`).join('')}</tr>`;
    const rows = ROWS[kind].filter((v) => !(kind !== 'pair' && v === 21)).map((v) => `
      <tr><th scope="row">${esc(rowLabel(kind, v))}</th>${UPCARDS.map((u) => {
        const key = cellKey(kind, v, u);
        const own = p.overrides[key];
        const code = own || standardCode(kind, v, u, rules);
        return `<td><button type="button" class="cell code--${codeTone(code)} ${own ? 'is-own' : ''}" data-action="cell" data-key="${key}" aria-label="${esc(cellText(kind, v))} gegen ${upLabel(u)}: ${esc(CODE_LABEL[code])}${own ? ' (geändert)' : ''}">${code}</button></td>`;
      }).join('')}</tr>`).join('');
    return `
      <div class="segmented segmented--3" role="tablist">
        ${Object.keys(KIND_LABEL).map((k) => `<button type="button" role="tab" data-action="tab" data-tab="${k}" aria-pressed="${k === kind}">${KIND_LABEL[k]}</button>`).join('')}
      </div>
      <div class="table-scroll"><table class="strategy-table">${head}${rows}</table></div>
      <p class="legend-line">
        <span class="cell-swatch code--hit">H</span>Ziehen <span class="cell-swatch code--stand">S</span>Stehen
        <span class="cell-swatch code--double">D</span>Verdoppeln <span class="cell-swatch code--split">P</span>Splitten
        <span class="cell-swatch code--surrender">R</span>Aufgeben · <span class="own-dot"></span>geändert
      </p>`;
  }

  _analysisHtml() {
    const an = this._analysis;
    if (!an) {
      return `<button type="button" class="btn btn--secondary" data-action="analyze">Profil analysieren</button>
        <p class="hint">Berechnet den Erwartungswert dieses Profils und vergleicht ihn mit der Standardstrategie und dem Rechenmodell.</p>`;
    }
    if (an.running) return '<div class="progress-box"><span class="spinner" aria-hidden="true"></span><span>Analyse läuft …</span></div>';
    if (an.error) return `<p class="notice notice--warn">${ICONS.warning}<span>Analyse fehlgeschlagen: ${esc(an.error)}</span></p><button type="button" class="btn btn--secondary" data-action="analyze">Erneut versuchen</button>`;
    const c = an.computed;
    const diffRow = (d) => `<li><b>${esc(cellText(d.kind, d.value))} gegen ${esc(upLabel(d.up))}</b>: ${esc(ACTION_DE[d.profile])} statt ${esc(ACTION_DE[d.standard])} <span class="mono">(${esc(pct(d.evProfile - d.evStandard, 2))} in dieser Situation)</span></li>`;
    const lossRow = (d) => `<li><b>${esc(cellText(d.kind, d.value))} gegen ${esc(upLabel(d.up))}</b>: ${esc(ACTION_DE[d.profile])} – besser im Modell: ${esc(ACTION_DE[d.best])} <span class="mono">(−${esc((d.loss * 100).toFixed(2).replace('.', ','))} % in dieser Situation)</span></li>`;
    return `
      <div class="analysis-block">
        <strong>Ergebnis <span class="kind kind--calc">berechnet</span></strong>
        <dl class="ev-list ev-list--wide">
          <dt>Erwartungswert dieses Profils</dt><dd>${esc(pct(c.evProfile, 3))}</dd>
          <dt>Standardstrategie</dt><dd>${esc(pct(c.evStandard, 3))}</dd>
          <dt>Beste Entscheidungen im Modell</dt><dd>${esc(pct(c.evModelBest, 3))}</dd>
          <dt>Unterschied zur Standardstrategie</dt><dd>${esc(pct(c.evProfile - c.evStandard, 3))}</dd>
        </dl>
        <p class="hint">Pro Einsatz über alle Startsituationen, Tischregeln: ${esc(rulesText(an.rules))}. Rechnung ohne Zufall – jederzeit gleich nachrechenbar.</p>
      </div>
      <div class="analysis-block">
        <strong>Unterschiede zur Standardstrategie (${c.vsStandard.length})</strong>
        ${c.vsStandard.length ? `<ul class="diff-list">${c.vsStandard.slice(0, 40).map(diffRow).join('')}</ul>` : '<p class="hint">Keine – gleiche Entscheidungen wie die Standardstrategie.</p>'}
      </div>
      <div class="analysis-block">
        <strong>Schwächer als das Rechenmodell (${c.vsModel.length})</strong>
        ${c.vsModel.length ? `<ul class="diff-list">${c.vsModel.slice(0, 40).map(lossRow).join('')}</ul>` : '<p class="hint">Keine – jede Startentscheidung entspricht der besten im Modell.</p>'}
      </div>
      ${an.invalidCells.length ? `<p class="notice notice--warn">${ICONS.warning}<span>${an.invalidCells.length} ungültige Zellen – dort gilt automatisch die Standardstrategie.</span></p>` : ''}
      ${an.notes.map((n) => `<p class="notice notice--warn">${ICONS.warning}<span>${esc(n)}</span></p>`).join('')}
      <div class="analysis-block">
        <strong>Annahmen und Grenzen <span class="kind kind--assume">nicht überprüft</span></strong>
        <ul class="plain-list">${an.assumptions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <p class="hint">Dass eine Strategie im Modell vorne liegt, beweist nicht, dass sie an einem echten Tisch optimal ist.</p>
      </div>
      <div data-slot="sim">${this._simHtml()}</div>`;
  }

  _simHtml() {
    const s = this._sim && this._sim.profileId === (this.profile && this.profile.id) ? this._sim : null;
    const r = s && s.result;
    const head = `<strong>Simulation <span class="kind kind--sim">Simulation</span></strong>`;
    if (!s) {
      return `<div class="analysis-block">${head}
        <p class="hint">Spielt ${SIM_TOTAL.toLocaleString('de-CH')} Runden mit einem echten Schuh (${this._tableRules().decks} Decks) und festem Startwert – reproduzierbar, mit Unsicherheitsbereich.</p>
        <button type="button" class="btn btn--secondary" data-action="simulate">Simulation starten</button></div>`;
    }
    const pctDone = Math.round((r.rounds / SIM_TOTAL) * 100);
    return `<div class="analysis-block">${head}
      <div class="progress" aria-label="Fortschritt"><span style="width:${pctDone}%"></span></div>
      <dl class="ev-list ev-list--wide">
        <dt>Runden</dt><dd>${r.rounds.toLocaleString('de-CH')}</dd>
        <dt>Ergebnis pro Einsatz</dt><dd>${r.rounds ? esc(pct(r.ev, 3)) : '–'}</dd>
        <dt>95-%-Bereich</dt><dd>${r.rounds > 1 ? `${esc(pct(r.ci95[0], 2))} bis ${esc(pct(r.ci95[1], 2))}` : '–'}</dd>
        <dt>Startwert · Schuh</dt><dd>${r.seed} · ${r.decks} Decks, Mischen nach ${Math.round(r.penetration * 100)} %</dd>
      </dl>
      <p class="hint">Simulationswerte schwanken zufällig. Der 95-%-Bereich zeigt die statistische Unsicherheit. Gleicher Startwert = gleiches Ergebnis.</p>
      ${s.running ? '<button type="button" class="btn btn--ghost" data-action="sim-stop">Simulation anhalten</button>' : '<button type="button" class="btn btn--ghost" data-action="simulate">Erneut simulieren</button>'}
    </div>`;
  }

  _renderSim() {
    const slot = this.el.querySelector('[data-slot="sim"]');
    if (slot) slot.innerHTML = this._simHtml();
  }

  _aiHtml(p) {
    if (p.type === 'standard') {
      return `
        <section class="group">
          <h2 class="group-title">QUELLE</h2>
          <div class="source-box">
            <strong>${esc(STANDARD_SOURCE.title)}</strong>
            <p><a href="${esc(STANDARD_SOURCE.url)}" target="_blank" rel="noopener noreferrer">${esc(STANDARD_SOURCE.url)}</a></p>
            <p class="hint">Abgerufen am ${esc(STANDARD_SOURCE.retrievedAt)}. ${esc(STANDARD_SOURCE.note)}</p>
          </div>
        </section>`;
    }
    if (p.type !== 'ai') return '';
    const d = p.data || {};
    const res = d.research || { status: 'skipped' };
    const ok = res.status === 'ok';
    return `
      <section class="group">
        <h2 class="group-title">KI-STRATEGIE: HERKUNFT</h2>
        <div class="source-box source-box--ai">
          <strong>Methode <span class="kind kind--calc">berechnet</span></strong>
          <p>${esc(d.method || 'unbekannt')}</p>
          <p class="hint">Erstellt ${d.computedAt ? esc(fmtDate(d.computedAt)) : '–'} mit ${esc(d.createdWith || '–')} für ${esc(rulesText(p.rules))}.</p>
        </div>
        <div class="source-box">
          <strong>Online-Recherche <span class="kind kind--ai">KI-Vorschlag</span></strong>
          <p class="${ok ? '' : 'text-warn'}"><b>${esc(RESEARCH_STATUS_TEXT[res.status] || res.status)}</b>${res.message ? ` – ${esc(res.message)}` : ''}</p>
          ${ok ? `
            ${res.summary ? `<p>${esc(res.summary)}</p>` : ''}
            <ul class="source-list">${(res.sources || []).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a><small>${esc(s.url)} · abgerufen ${esc(s.retrievedAt)}</small></li>`).join('')}</ul>
            ${(res.approaches || []).length ? `<p><b>Strategieansätze:</b></p><ul class="plain-list">${res.approaches.map((x) => `<li><b>${esc(x.name)}</b> – ${esc(x.summary)}</li>`).join('')}</ul>` : ''}
            ${(res.suggestions || []).length ? `<p><b>Vorschläge (mit Rechenmodell geprüft):</b></p><ul class="plain-list">${res.suggestions.map((x) => `<li>${esc(x.key)} → ${esc(x.code)}: <b>${esc(x.verdict)}</b>${x.rationale ? ` – ${esc(x.rationale)}` : ''}</li>`).join('')}</ul>` : ''}`
            : '<p class="hint">Diese Strategie stammt ausschliesslich aus der Berechnung auf dem Gerät. Es wurden keine Online-Quellen verwendet.</p>'}
        </div>
        <div class="source-box">
          <strong>Annahmen <span class="kind kind--assume">nicht überprüft</span></strong>
          <ul class="plain-list">${(d.assumptions || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          <strong>Grenzen</strong>
          <ul class="plain-list">${(d.limitations || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        </div>
      </section>`;
  }

  render() {
    const p = this.profile;
    if (!p) {
      this.el.innerHTML = `${subHeader('Strategieprofil', 'strategie')}<div class="sub-content"><p class="notice notice--warn">${ICONS.warning}<span>Profil nicht gefunden.</span></p></div>`;
      return;
    }
    const { profiles } = this.ctx;
    const isActive = profiles.activeId === p.id;
    const st = profiles.strategyFor(p);
    const editable = this.editable;
    const dev = Object.keys(p.overrides).length;
    const notice = this._notice ? `<p class="notice notice--${this._notice.tone}" role="status">${this._notice.tone === 'ok' ? ICONS.check : ICONS.warning}<span>${esc(this._notice.text)}</span></p>` : '';

    const details = editable ? `
      <label class="field"><span>Name</span><input name="name" type="text" maxlength="60" value="${esc(p.name)}" autocomplete="off"></label>
      <label class="field"><span>Beschreibung</span><textarea name="description" rows="3" maxlength="500">${esc(p.description)}</textarea></label>
      <button type="button" class="btn btn--secondary" data-action="save-details">Name und Beschreibung speichern</button>`
      : `<p class="profile-card-desc">${esc(p.description)}</p>
         <button type="button" class="btn btn--secondary" data-action="duplicate">Duplizieren, um eine eigene Version zu bearbeiten</button>`;

    const rulesBox = p.type === 'standard'
      ? `<p class="hint">Folgt immer den Tischregeln: ${esc(rulesText(this._tableRules()))}</p>`
      : `
        <div class="list">
          <div class="row"><span class="row-stack"><span>Regeln folgen den Tischregeln</span><small>Tabelle passt sich bei Regeländerungen an</small></span>
            <button type="button" class="switch" role="switch" aria-checked="${p.settings.followTableRules}" data-action="follow" ${editable ? '' : 'disabled'}><span></span></button></div>
          ${p.settings.followTableRules ? '' : RULES.map((r) => `
            <button type="button" class="row row--btn" data-action="rule:${r.path}" ${editable ? '' : 'disabled'}>
              <span>${esc(r.label)}</span><span class="row-value">${esc(r.text(p.rules[r.path.split('.')[1]]))} ${ICONS.chevron}</span>
            </button>`).join('')}
        </div>
        ${st.rulesMismatch ? `
          <div class="warn-banner"><span class="warn-banner-icon">${ICONS.warning}</span><div>
            <strong>Profilregeln ≠ Tischregeln</strong>
            <p>Profil: ${esc(rulesText(p.rules))}<br>Tisch: ${esc(rulesText(this._tableRules()))}<br>Erlaubte Aktionen richten sich nach den Tischregeln.</p>
            <div class="inline-actions">
              <button type="button" class="btn btn--small" data-action="apply-to-table">Tischregeln anpassen</button>
              ${editable ? '<button type="button" class="btn btn--small" data-action="take-table">Profilregeln anpassen</button>' : ''}
            </div>
          </div></div>` : ''}`;

    this.el.innerHTML = `
      ${subHeader(p.name, 'strategie')}
      <div class="sub-content">
        <div class="profile-head">
          ${typeBadge(p.type)}
          ${isActive ? `<span class="active-chip">${ICONS.check}AKTIV</span>` : '<button type="button" class="btn btn--primary btn--compact" data-action="activate">Aktivieren</button>'}
        </div>
        ${notice}
        <section class="group">
          <h2 class="group-title">PROFIL</h2>
          ${details}
          <p class="meta">Erstellt ${esc(fmtDate(p.createdAt))} · geändert ${esc(fmtDate(p.updatedAt))} · ID ${esc(p.id)}</p>
        </section>
        <section class="group">
          <h2 class="group-title">REGELN</h2>
          ${rulesBox}
        </section>
        <section class="group">
          <h2 class="group-title">STRATEGIETABELLE ${dev ? `· ${dev} GEÄNDERT` : ''}</h2>
          <p class="group-help">${editable ? 'Zelle antippen, um die Entscheidung zu ändern. Leere Zellen nutzen automatisch die Standardstrategie.' : 'Zelle antippen für Details und berechnete Erwartungswerte.'}</p>
          ${this._tableHtml(p)}
          ${editable && dev ? `<button type="button" class="btn ${this._confirmReset ? 'btn--danger' : 'btn--ghost'}" data-action="reset-cells">${this._confirmReset ? 'Wirklich alle Änderungen verwerfen?' : 'Alle Zellen auf Standard zurücksetzen'}</button>` : ''}
        </section>
        ${this._aiHtml(p)}
        <section class="group">
          <h2 class="group-title">ANALYSE</h2>
          ${this._analysisHtml()}
        </section>
      </div>
      <div class="sheet-backdrop" data-slot="sheet" hidden></div>`;
    this._renderSheet();
  }
}

export { STANDARD_ID };
