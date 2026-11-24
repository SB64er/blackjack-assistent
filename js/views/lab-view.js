// Einstellungen → Strategie-Labor.
// Strategieprofile unter GLEICHEN Bedingungen vergleichen (gleiche Tischregeln, gleiche
// Mischfolge/Startwert, gleiche Rundenzahl). Klar getrennt:
//   Exakte Mathematik (Rechenmodell) · Simulation (Zufall mit Startwert)
// 0.9.0: YUMEKO-Entwürfe und KI-Hypothesen (frühere YUMEKO-KI) sind entfernt.
// Simulationsergebnisse werden getrennt von echten Runden gespeichert.
import { View, subHeader } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { Simulation } from '../strategy/simulate.js';
import { strategyEV, profilePolicy } from '../strategy/ev.js';
import { normalizeRules, rulesText } from '../strategy/standard.js';
import { pct } from '../strategy/analysis.js';
import { fmtDateTime } from './archive-view.js';

const ROUND_OPTIONS = [10000, 50000, 100000, 500000];
const CHUNK = 4000;
const rate = (x, d = 1) => `${(x * 100).toFixed(d).replace('.', ',')} %`;

export class LabView extends View {
  mount() {
    this.el.className = 'screen screen-sub';
    this._notice = null;
    this._rounds = 50000;
    this._seed = 20261122;
    this._selected = null;
    this._run = null;      // { results, current, total, cancel }
    this._result = null;
    this.el.innerHTML = `
      ${subHeader('Strategie-Labor', 'einstellungen')}
      <div class="sub-content" data-slot="content"></div>`;
    this.el.addEventListener('click', (e) => this._onClick(e));
    this.el.addEventListener('change', (e) => this._onChange(e));
    const r = () => { if (!this._run) this.render(); };
    this.listen(this.ctx.profiles, 'change', r);
    this.listen(this.ctx.simulations, 'change', r);
    this.render();
  }

  destroy() {
    super.destroy();
    if (this._run) this._run.cancel = true;
  }

  _rules() { return normalizeRules(this.ctx.settings.get('rules')); }

  /** Alle vergleichbaren Strategien: die gespeicherten Strategieprofile. */
  _candidates() {
    const { profiles } = this.ctx;
    return profiles.list().map((p) => {
      const st = profiles.strategyFor(p);
      return { id: `p:${p.id}`, name: p.name, kind: 'Profil', overrides: st.overrides, strategyRules: st.strategyRules, base: p.id === 'standard' };
    });
  }

  _onChange(e) {
    const t = e.target;
    if (t.name === 'rounds') this._rounds = Number(t.value) || 50000;
    if (t.name === 'seed') this._seed = Math.max(1, Math.floor(Number(t.value) || 1));
    if (t.name === 'pick') {
      const set = new Set(this._selectedIds());
      if (t.checked) set.add(t.value); else set.delete(t.value);
      this._selected = [...set];
    }
  }

  _selectedIds() {
    const all = this._candidates();
    if (!this._selected) return all.filter((c) => c.base || c.id === `p:${this.ctx.profiles.activeId}`).map((c) => c.id);
    return this._selected.filter((id) => all.some((c) => c.id === id));
  }

  async _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const { simulations } = this.ctx;
    try {
      switch (btn.dataset.action) {
        case 'run': this._start(); return;
        case 'cancel': if (this._run) this._run.cancel = true; return;
        case 'save': {
          if (!this._result) return;
          const r = this._result;
          await simulations.add({ rules: r.rules, rounds: r.rounds, seed: r.seed, results: r.results.map(({ name, kind, ev, se, ci95, exact, winRate, lossRate, pushRate, perInitialUnit, perWagered, avgWager, longestLossStreak, maxDrawdown, rounds, sessions }) => ({ name, kind, ev, se, ci95, exact, winRate, lossRate, pushRate, perInitialUnit, perWagered, avgWager, longestLossStreak, maxDrawdown, rounds, ...(sessions && sessions.n ? { sessions } : {}) })), note: 'Strategie-Labor' });
          this._notice = { tone: 'ok', text: 'Simulation gespeichert (getrennt von echten Runden).' };
          break;
        }
        case 'delete-sim': await simulations.remove(btn.dataset.id); this._notice = { tone: 'ok', text: 'Simulation gelöscht.' }; break;
        default: return;
      }
    } catch (err) {
      this._notice = { tone: 'warn', text: err.message };
    }
    this.render();
  }

  _start() {
    const rules = this._rules();
    const picks = this._candidates().filter((c) => this._selectedIds().includes(c.id));
    if (picks.length < 1) { this._notice = { tone: 'warn', text: 'Bitte mindestens eine Strategie wählen.' }; this.render(); return; }
    const total = this._rounds;
    const seed = this._seed;
    const run = { cancel: false, i: 0, done: 0, total: total * picks.length, results: [] };
    this._run = run;
    this._result = null;
    this._notice = null;
    let sim = null;
    const tick = () => {
      if (run.cancel) { this._run = null; this._notice = { tone: 'warn', text: 'Simulation abgebrochen.' }; this.render(); return; }
      const st = picks[run.i];
      if (!sim) sim = new Simulation({ rules, overrides: st.overrides, strategyRules: st.strategyRules, seed });
      const n = Math.min(CHUNK, total - sim.rounds);
      sim.step(n);
      run.done += n;
      if (sim.rounds >= total) {
        const exact = strategyEV(rules, profilePolicy(st.overrides, st.strategyRules, rules)).ev;
        run.results.push({ id: st.id, name: st.name, kind: st.kind, exact, ...sim.result() });
        sim = null;
        run.i += 1;
      }
      this._progress(run);
      if (run.i >= picks.length) {
        this._run = null;
        this._result = { rules, rounds: total, seed, results: run.results, at: new Date().toISOString() };
        this.render();
        return;
      }
      setTimeout(tick, 0);
    };
    this.render();
    setTimeout(tick, 0);
  }

  _progress(run) {
    const el = this.el.querySelector('[data-slot="progress"]');
    if (el) el.innerHTML = `<div class="progress"><span style="width:${Math.round((run.done / run.total) * 100)}%"></span></div><p class="hint">${run.done.toLocaleString('de-CH')} von ${run.total.toLocaleString('de-CH')} Runden simuliert …</p>`;
  }

  _resultHtml(r) {
    const base = r.results.find((x) => x.id === 'p:standard') || r.results[0];
    return `
      <div class="table-wrap">
        <table class="lab-table">
          <thead><tr><th>Strategie</th><th>Exakte Mathematik</th><th>Simulation (95 %)</th><th>Δ zu ${esc(base.name)}</th><th>Gewinn / Verlust / Push</th><th>Ø Einsatz</th><th>Längste Verlustserie</th><th>Max. Drawdown</th></tr></thead>
          <tbody>${r.results.map((x) => `
            <tr>
              <th>${esc(x.name)}<small>${esc(x.kind || '')}</small></th>
              <td>${pct(x.exact, 3)}</td>
              <td>${pct(x.ev, 2)} ± ${rate(1.96 * x.se, 2)}</td>
              <td>${x === base ? '–' : `${pct(x.exact - base.exact, 3)} <small>(Sim. ${pct(x.ev - base.ev, 2)})</small>`}</td>
              <td>${rate(x.winRate)} / ${rate(x.lossRate)} / ${rate(x.pushRate)}</td>
              <td>${x.avgWager.toFixed(3)} E.</td>
              <td>${x.longestLossStreak} <small>(erwartet ≈ ${x.expectedLongestLossStreak != null ? x.expectedLongestLossStreak.toFixed(0) : '–'})</small></td>
              <td>${x.maxDrawdown.toFixed(0)} E.</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
      <p class="hint">E. = Einsatz-Einheiten (ursprünglicher Einsatz = 1). Ertrag pro ursprünglicher Einheit = Simulationswert; pro tatsächlich gesetzter Einheit: ${r.results.map((x) => `${esc(x.name)} ${pct(x.perWagered, 2)}`).join(', ')}.</p>
      <p class="hint">Alle Strategien wurden mit derselben Mischfolge (Startwert ${r.seed}), denselben Regeln (${esc(rulesText(r.rules))}) und ${r.rounds.toLocaleString('de-CH')} Runden gespielt. Unterschiede innerhalb des ±-Bereichs sind nicht aussagekräftig – dann entscheidet die exakte Mathematik. Eine hohe Gewinnquote beweist keine profitable Strategie.</p>
      ${this._distributionHtml(r)}
      <button type="button" class="btn btn--secondary" data-action="save">Ergebnis speichern</button>`;
  }

  // 0.8.0: Gewinn- und Verlustverteilung (aus denselben simulierten Runden).
  _distributionHtml(r) {
    const withSessions = r.results.filter((x) => x.sessions && x.sessions.n);
    const base = r.results[0];
    if (!base || !base.distribution) return '';
    const fmtU = (v) => `${v > 0 ? '+' : ''}${String(v).replace('.', ',')}`;
    return `
      <div class="analysis-block">
        <strong>Gewinn- und Verlustverteilung <span class="kind kind--sim">Simulation</span></strong>
        ${withSessions.length ? `<ul class="ev-list">${withSessions.map((x) => `<li><span>${esc(x.name)}: nach je ${x.sessions.size} Runden in ${rate(x.sessions.lossShare)} der Fälle im Minus; 90 % der Ergebnisse zwischen ${fmtU(Math.round(x.sessions.p05))} und ${fmtU(Math.round(x.sessions.p95))} E.</span><b>${x.sessions.n.toLocaleString('de-CH')} Blöcke</b></li>`).join('')}</ul>` : ''}
        <p class="hint">Ergebnis je Runde (${esc(base.name)}): ${base.distribution.filter((d) => d.share >= 0.001).map((d) => `${fmtU(d.net)} E. ${rate(d.share)}`).join(' · ')}</p>
        <p class="hint">Simulationswerte zeigen die Schwankung bei diesen Regeln. Sie sind keine Vorhersage und keine Gewinngarantie – auf Dauer wirkt der Hausvorteil.</p>
      </div>`;
  }

  render() {
    const { simulations } = this.ctx;
    const rules = this._rules();
    const cands = this._candidates();
    const sel = new Set(this._selectedIds());
    const notice = this._notice ? `<p class="notice notice--${this._notice.tone}" role="status">${this._notice.tone === 'ok' ? ICONS.check : ICONS.warning}<span>${esc(this._notice.text)}</span></p>` : '';
    this.el.querySelector('[data-slot="content"]').innerHTML = `
      ${notice}
      <p class="lead">Vergleiche Strategien unter gleichen Bedingungen. Tischregeln: <b>${esc(rulesText(rules))}</b> (Einstellungen → Tischregeln).</p>
      <div class="kind-legend">
        <span class="kind kind--calc">Exakte Mathematik</span><span>Rechenmodell, ohne Zufall, jederzeit nachrechenbar (unendliches Deck).</span>
        <span class="kind kind--sim">Simulation</span><span>Endlicher Schuh, Zufall mit Startwert – reproduzierbar, mit statistischer Unsicherheit.</span>
      </div>

      <section class="group">
        <h2 class="group-title">STRATEGIEN VERGLEICHEN</h2>
        <div class="pick-list">${cands.map((c) => `
          <label class="row row--check"><span>${esc(c.name)} <small class="meta">${esc(c.kind)}${c.mismatch ? ' · andere Tischregeln' : ''}</small></span><input type="checkbox" name="pick" value="${esc(c.id)}" ${sel.has(c.id) ? 'checked' : ''} ${this._run ? 'disabled' : ''}></label>`).join('')}</div>
        <div class="form-grid">
          <label class="field"><span>Runden je Strategie</span><select name="rounds" ${this._run ? 'disabled' : ''}>${ROUND_OPTIONS.map((n) => `<option value="${n}" ${n === this._rounds ? 'selected' : ''}>${n.toLocaleString('de-CH')}</option>`).join('')}</select></label>
          <label class="field"><span>Startwert (gleich = gleiches Ergebnis)</span><input name="seed" inputmode="numeric" value="${this._seed}" ${this._run ? 'disabled' : ''}></label>
        </div>
        ${this._run ? '<button type="button" class="btn btn--ghost" data-action="cancel">Abbrechen</button>' : '<button type="button" class="btn btn--primary" data-action="run">Simulation starten</button>'}
        <div data-slot="progress"></div>
        ${this._result ? this._resultHtml(this._result) : ''}
      </section>

      <section class="group">
        <h2 class="group-title">GESPEICHERTE SIMULATIONEN</h2>
        ${simulations.list.length ? simulations.list.slice(0, 20).map((s) => `
          <article class="knowledge-card">
            <p><b>${esc(fmtDateTime(s.at))}</b> · ${s.rounds.toLocaleString('de-CH')} Runden je Strategie · Startwert ${s.seed}${s.rules ? ` · ${esc(rulesText(s.rules))}` : ''}</p>
            <ul class="ev-list">${s.results.map((x) => `<li><span>${esc(x.name)}</span><b>${pct(x.ev, 2)} ± ${rate(1.96 * (x.se || 0), 2)}${x.exact != null ? ` · exakt ${pct(x.exact, 3)}` : ''}</b></li>`).join('')}</ul>
            <button type="button" class="btn btn--small" data-action="delete-sim" data-id="${esc(s.id)}">Löschen</button>
          </article>`).join('') : '<p class="hint">Noch keine gespeicherten Simulationen. Simulationen werden getrennt von echten Runden gespeichert.</p>'}
      </section>
      <p class="hint">Keine Gewinngarantie: Bei üblichen Regeln hat auch die beste Strategie einen negativen Erwartungswert.</p>`;
  }
}
