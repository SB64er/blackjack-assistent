// YUMEKO – Lernzentrum: Lernstatus (nur aus echten Daten), Archivanalyse,
// Strategieversionen (Entwurf -> mathematische Prüfung -> Bestätigung).
import { View, subHeader } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { pct } from '../strategy/analysis.js';
import { rulesText, normalizeRules, CODE_LABEL } from '../strategy/standard.js';
import { YUMEKO_ID } from '../strategy/profiles.js';
import { fmtDateTime } from './archive-view.js';

const ACTION_DE = { HIT: 'Ziehen', STAND: 'Stehen', DOUBLE: 'Verdoppeln', SPLIT: 'Splitten' };
const VSTATUS = { entwurf: 'Entwurf', 'geprüft': 'Geprüft – wartet auf Bestätigung', abgelehnt: 'Prüfung nicht bestanden', aktiv: 'Aktiv', ersetzt: 'Ersetzt' };

export class YumekoView extends View {
  mount() {
    this.el.className = 'screen screen-sub screen-yumeko';
    this._notice = null;
    this._confirm = null;
    this._openVersion = null;
    this.el.innerHTML = `
      ${subHeader('YUMEKO – Lernzentrum', 'einstellungen')}
      <div class="sub-content" data-slot="content"></div>`;
    this.el.addEventListener('click', (e) => this._onClick(e));
    this.listen(this.ctx.yumeko, 'change', () => this.render());
    this.render();
  }

  _say(tone, text) { this._notice = { tone, text }; }

  async _run(fn, okText) {
    try {
      const r = await fn();
      if (okText) this._say('ok', typeof okText === 'function' ? okText(r) : okText);
      return r;
    } catch (err) {
      this._say('warn', err.message);
      return null;
    } finally {
      this.render();
    }
  }

  async _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const { yumeko, profiles, knowledge } = this.ctx;
    const id = btn.dataset.id;
    switch (btn.dataset.action) {
      case 'activate':
        await this._run(() => profiles.activate(YUMEKO_ID), 'YUMEKO AI ist jetzt das aktive Strategieprofil.');
        break;
      case 'analyze':
        await this._run(() => yumeko.analyzeArchive(), (r) => `Analyse fertig: ${r.roundsUsed} Runden, ${r.decisionsUsed} Entscheidungen ausgewertet.`);
        break;
      case 'draft':
        await this._run(async () => { const d = await yumeko.draft(); this._openVersion = d.id; return d; }, (d) => `Entwurf ${d.number} erstellt. Bitte jetzt mathematisch prüfen.`);
        break;
      case 'verify':
        this._openVersion = id;
        await this._run(() => yumeko.verify(id), (v) => (v.verification.ok ? `Version ${v.number}: Prüfung bestanden.` : `Version ${v.number}: Prüfung nicht bestanden.`));
        break;
      case 'confirm':
        if (this._confirm !== id) { this._confirm = id; this.render(); break; }
        this._confirm = null;
        await this._run(() => yumeko.confirm(id), (v) => `Strategieversion ${v.number} ist jetzt YUMEKOS aktive Tabelle.`);
        break;
      case 'toggle-version':
        this._openVersion = this._openVersion === id ? null : id;
        this.render();
        break;
      case 'delete-version':
        await this._run(() => knowledge.removeVersion(id), 'Entwurf gelöscht.');
        break;
      case 'knowledge-filter':
        this.ctx.ui.set('knowledgeFilter', btn.dataset.filter || null);
        this.ctx.navigate('wissen');
        break;
      default: break;
    }
  }

  _reportHtml() {
    const { yumeko, knowledge } = this.ctx;
    const r = yumeko.lastReport;
    const last = knowledge.meta.lastAnalysis;
    if (!r && !last) return '<p class="hint">Noch keine Analyse. Tippe auf „Archiv analysieren“.</p>';
    if (!r) {
      return `<p class="hint">Letzte Analyse ${esc(fmtDateTime(last.at))}: ${last.roundsUsed} von ${last.roundsTotal} Runden, ${last.decisionsUsed} Entscheidungen, ${last.mistakes} Fehlertypen, rechnerischer Verlust ${Number(last.evLossTotal || 0).toFixed(3)} Einsätze. Datenqualität ${esc(last.quality)}. Für Details erneut analysieren.</p>`;
    }
    const o = r.outcomes;
    const dq = r.decisionQuality;
    return `
      <div class="analysis-block">
        <strong>Entscheidungsqualität <span class="kind kind--calc">berechnet</span></strong>
        <p>${dq.decisions} Entscheidungen ausgewertet, ${dq.mistakes} davon rechnerisch schlechter als die beste Aktion (ab 0,1 % des Einsatzes). Rechnerischer Verlust durch Abweichungen: <b>${dq.evLossTotal.toFixed(3)} Einsätze</b> – unabhängig vom Ausgang der Hände.</p>
        <div class="luck-grid">
          <div><b>${r.luck.correctWon}</b><span>richtig entschieden, gewonnen</span></div>
          <div><b>${r.luck.correctLost}</b><span>richtig entschieden, trotzdem verloren</span></div>
          <div><b>${r.luck.wrongWon}</b><span>falsch entschieden, trotzdem gewonnen</span></div>
          <div><b>${r.luck.wrongLost}</b><span>falsch entschieden, verloren</span></div>
        </div>
        <p class="hint">Ein gewonnener Zug ist nicht automatisch richtig, ein verlorener nicht automatisch falsch.</p>
      </div>
      ${r.mistakes.length ? `
        <div class="analysis-block">
          <strong>Mögliche Strategiefehler <span class="kind kind--calc">berechnet</span></strong>
          <ul class="ev-list">${r.mistakes.slice(0, 8).map((m) => `<li><span>${esc(m.text)}: ${m.count}× ${ACTION_DE[m.action]} statt ${ACTION_DE[m.best]}</span><b>−${pct(m.lossEach, 2)}</b></li>`).join('')}</ul>
        </div>` : ''}
      <div class="analysis-block">
        <strong>Spielergebnis <span class="kind kind--sim">Zufall</span></strong>
        <p>${o.hands} Hände, netto ${o.net >= 0 ? '+' : ''}${o.net.toFixed(1)} Einsätze${o.ci95 ? `, pro Hand ${pct(o.meanPerHand)} (95-%-Bereich ${pct(o.ci95[0])} bis ${pct(o.ci95[1])})` : ''}${o.expectedPerHand != null ? `. Rechnerisch erwartet: ${pct(o.expectedPerHand, 2)} pro Hand` : ''}.</p>
        <p class="hint">${esc(o.note)}</p>
      </div>
      <div class="analysis-block">
        <strong>Datenqualität: ${esc(r.quality.level)}</strong>
        <p>${r.roundsUsed} von ${r.roundsTotal} Runden genutzt (unvollständig ${r.excluded.incomplete}, unsichere Erkennung ${r.excluded.lowConfidence}).</p>
        ${r.quality.reasons.length ? `<ul class="plain-list">${r.quality.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      </div>`;
  }

  _versionsHtml() {
    const { knowledge, settings } = this.ctx;
    const table = normalizeRules(settings.get('rules'));
    const list = knowledge.versions;
    const rows = list.map((v) => {
      const open = this._openVersion === v.id;
      const ver = v.verification;
      const changed = Object.keys(v.overrides).length;
      return `
        <article class="version-card version-card--${esc(v.status)}">
          <button type="button" class="version-head" data-action="toggle-version" data-id="${esc(v.id)}">
            <strong>Version ${v.number}</strong>
            <span class="status-chip status-chip--${esc(v.status)}">${esc(VSTATUS[v.status] || v.status)}</span>
          </button>
          <p class="meta">${esc(rulesText(v.rules))} · ${changed} Abweichungen zur Standardstrategie · erstellt ${esc(fmtDateTime(v.createdAt))}</p>
          ${open ? `
            <p>${esc(v.basis.method)}</p>
            ${v.basis.adopted.length ? `<p><b>Übernommene Lerninformationen:</b></p><ul class="plain-list">${v.basis.adopted.map((x) => `<li>${esc(x.key)} → ${esc(CODE_LABEL[x.code] || x.code)}: ${esc(x.reason)}</li>`).join('')}</ul>` : ''}
            ${v.basis.rejected.length ? `<p><b>Nicht übernommen:</b></p><ul class="plain-list">${v.basis.rejected.map((x) => `<li>${esc(x.key)} → ${esc(x.code)}: ${esc(x.reason)}</li>`).join('')}</ul>` : ''}
            ${v.basis.changes.length ? `<p><b>Änderungen zur aktiven Version:</b> ${v.basis.changes.slice(0, 20).map((c) => `${esc(c.key)}: ${esc(c.from)} → ${esc(c.to)}`).join(', ')}${v.basis.changes.length > 20 ? ' …' : ''}</p>` : '<p class="hint">Keine Änderungen gegenüber der aktiven Version.</p>'}
            ${ver ? `
              <div class="ev-box">
                <div><span>Diese Version</span><b>${pct(ver.evVersion, 3)}</b></div>
                <div><span>Standardstrategie</span><b>${pct(ver.evStandard, 3)}</b></div>
                <div><span>Modellbeste</span><b>${pct(ver.evModel, 3)}</b></div>
              </div>
              <p class="hint">${esc(ver.method)} ${esc(ver.note)}</p>
              ${ver.problems.length ? `<p class="text-warn"><b>Probleme:</b></p><ul class="plain-list">${ver.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="text-ok">Prüfung bestanden: keine Zelle schlechter als erlaubt, Gesamtwert nicht unter der Standardstrategie.</p>'}` : ''}
            <div class="btn-row">
              ${v.status === 'entwurf' || v.status === 'abgelehnt' ? `<button type="button" class="btn btn--secondary" data-action="verify" data-id="${esc(v.id)}">Mathematisch prüfen</button>` : ''}
              ${(v.status === 'geprüft' || v.status === 'ersetzt') && ver && ver.ok ? `<button type="button" class="btn ${this._confirm === v.id ? 'btn--success' : 'btn--yumeko'}" data-action="confirm" data-id="${esc(v.id)}">${this._confirm === v.id ? 'Ja, Version aktivieren' : 'Version bestätigen …'}</button>` : ''}
              ${v.status !== 'aktiv' ? `<button type="button" class="btn btn--ghost" data-action="delete-version" data-id="${esc(v.id)}">Löschen</button>` : ''}
            </div>
            ${this._confirm === v.id ? '<p class="hint">Mit der Bestätigung übernimmt YUMEKO diese Tabelle für ihre Empfehlungen. Du kannst jederzeit eine frühere geprüfte Version wieder aktivieren.</p>' : ''}
            ${v.status !== 'aktiv' && !rulesTextEq(v.rules, table) ? '<p class="text-warn">Erstellt für andere Tischregeln als die aktuell eingestellten.</p>' : ''}` : ''}
        </article>`;
    }).join('');
    return `${rows || '<p class="hint">Noch keine Strategieversion. YUMEKO nutzt bis dahin die Standardstrategie.</p>'}
      <button type="button" class="btn btn--yumeko" data-action="draft">Strategie überprüfen: neuen Entwurf erstellen</button>`;
  }

  render() {
    const { yumeko, profiles } = this.ctx;
    const s = yumeko.status();
    const active = profiles.activeId === YUMEKO_ID;
    const notice = this._notice ? `<p class="notice notice--${this._notice.tone}" role="status">${this._notice.tone === 'ok' ? ICONS.check : ICONS.warning}<span>${esc(this._notice.text)}</span></p>` : '';
    this.el.querySelector('[data-slot="content"]').innerHTML = `
      ${notice}
      <section class="yumeko-hero">
        <div>
          <span class="yumeko-mark">◆</span>
          <strong>YUMEKO AI</strong>
          <span class="hint">Adaptive Blackjack Intelligence</span>
        </div>
        ${active ? `<span class="active-chip">${ICONS.check}AKTIV</span>` : '<button type="button" class="btn btn--yumeko btn--compact" data-action="activate">Als Profil aktivieren</button>'}
      </section>
      <p class="lead">${esc(s.phase)}</p>
      <div class="stat-grid">
        <div class="stat"><b>${s.roundsArchived}</b><span>archivierte Runden</span></div>
        <div class="stat"><b>${s.roundsAnalyzed}</b><span>analysierte Runden</span></div>
        <div class="stat stat--ok"><b>${s.verified}</b><span>bestätigte Erkenntnisse</span></div>
        <div class="stat stat--warn"><b>${s.unverified}</b><span>ungeprüfte Erkenntnisse</span></div>
        <div class="stat"><b>${s.videos}</b><span>Video-Lernsequenzen</span></div>
        <div class="stat"><b>v${s.strategyVersion}</b><span>Strategieversion</span></div>
      </div>
      <p class="hint">Letzte Analyse: ${s.lastAnalysisAt ? esc(fmtDateTime(s.lastAnalysisAt)) : 'noch keine'}. Alle Zahlen stammen aus deinen gespeicherten Daten – es gibt keine geschätzten Genauigkeitswerte.</p>

      <div class="yumeko-actions">
        <button type="button" class="btn btn--primary" data-action="analyze" ${yumeko.busy ? 'disabled' : ''}>${yumeko.busy === 'analyse' ? 'Analysiere …' : 'Archiv analysieren'}</button>
        <button type="button" class="btn btn--secondary" data-nav="video">Video lernen</button>
        <button type="button" class="btn btn--secondary" data-action="knowledge-filter">Wissen anzeigen</button>
        <button type="button" class="btn btn--secondary" data-action="knowledge-filter" data-filter="edit">Lerninformationen korrigieren</button>
      </div>
      <div class="yumeko-actions yumeko-actions--v2">
        <button type="button" class="btn btn--yumeko" data-nav="labor">Strategie-Labor</button>
        <button type="button" class="btn btn--secondary" data-nav="risiko">Echtgeld &amp; Risiko${this.ctx.bankroll && this.ctx.bankroll.config.enabled ? ' · aktiv' : ''}</button>
        <button type="button" class="btn btn--secondary" data-nav="chat">YUMEKO fragen (Chat)</button>
      </div>

      <section class="group">
        <h2 class="group-title">SO LERNT YUMEKO</h2>
        <div class="phase-grid">
          <div class="phase"><b>1 · Beobachten</b><span>Archivierte Runden (Karten, Aktionen, Ergebnisse, Regeln, Profil) und bestätigte Video-Lernsequenzen.</span></div>
          <div class="phase"><b>2 · Analysieren</b><span>Vergleich jeder Entscheidung mit dem Rechenmodell, Fehler, widersprüchliche Entscheidungen, Datenqualität, Erkennungskorrekturen.</span></div>
          <div class="phase"><b>3 · Lernen</b><span>Erkenntnisse im Wissensspeicher, zusätzliche Kartenprüfung bei oft korrigierten Werten, Strategieentwürfe – aktiv erst nach Prüfung und deiner Bestätigung.</span></div>
          <div class="phase"><b>4 · Überprüfen</b><span>Strategie-Labor: exakte Mathematik und reproduzierbare Simulationen unter gleichen Bedingungen. Einzelne Gewinne oder Verluste ändern die Strategie nie.</span></div>
        </div>
      </section>

      <section class="group">
        <h2 class="group-title">LETZTE ANALYSE</h2>
        ${this._reportHtml()}
      </section>

      <section class="group">
        <h2 class="group-title">STRATEGIEVERSIONEN</h2>
        <p class="group-help">Ziel: der höchste langfristige Erwartungswert für die eingestellten Tischregeln. Neue Versionen werden gegen die Standardstrategie und das Rechenmodell geprüft.</p>
        ${this._versionsHtml()}
      </section>

      <section class="group">
        <h2 class="group-title">HINWEISE UND FEHLENDE FUNKTIONEN</h2>
        <ul class="plain-list">${s.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <p class="hint">Keine Gewinngarantie: Auch die beste Strategie behält beim Blackjack einen Hausvorteil.</p>
      </section>`;
  }
}

function rulesTextEq(a, b) {
  return rulesText(a) === rulesText(b);
}
