// Spielarchiv (Phase 6): alle Runden anzeigen, suchen, filtern, öffnen,
// exportieren/importieren und – nur nach ausdrücklicher Bestätigung – löschen.
import { View, subHeader } from './view-base.js';
import { roundInsight } from '../archive/insights.js';
import { ICONS, esc } from '../core/dom.js';
import { filterRounds, summarizeRounds, roundOutcome, STATUS_TEXT } from '../archive/round-record.js';
import { OUTCOME_LABEL } from '../game/settle.js';

const PAGE = 60;
const FILTERS = [['all', 'Alle'], ['win', 'Gewonnen'], ['loss', 'Verloren'], ['push', 'Push'], ['open', 'Offen']];
const OUT_TEXT = { ...OUTCOME_LABEL, mixed: 'Gemischt', open: 'Offen' };

export function fmtDateTime(iso) {
  try { return new Date(iso).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; }
}

const ranks = (cards) => (cards.length ? cards.map((c) => c.rank).join(' ') : '–');

export function downloadJson(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export class ArchiveView extends View {
  mount() {
    this.el.className = 'screen screen-sub';
    this._text = '';
    this._filter = 'all';
    this._limit = PAGE;
    this._notice = null;
    this._confirmClear = false;
    this.el.innerHTML = `
      ${subHeader('Spielarchiv', 'einstellungen')}
      <div class="sub-content">
        <div data-slot="top"></div>
        <label class="field field--search"><span>Suchen</span><input type="search" name="q" placeholder="z. B. 16, Dealer 10, Datum 2026-11-22, Profil" autocomplete="off"></label>
        <div class="segmented segmented--5" role="group" aria-label="Filter" data-slot="filters"></div>
        <div data-slot="list"></div>
        <div data-slot="bottom"></div>
      </div>
      <input type="file" accept="application/json,.json" data-slot="file" hidden>`;
    this.el.addEventListener('click', (e) => this._onClick(e));
    this.el.querySelector('input[name="q"]').addEventListener('input', (e) => { this._text = e.target.value; this._limit = PAGE; this._renderList(); });
    this.el.querySelector('[data-slot="file"]').addEventListener('change', (e) => this._import(e.target.files && e.target.files[0]));
    this.listen(this.ctx.archive, 'change', () => this.render());
    this.render();
  }

  async _import(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const res = await this.ctx.archive.importData(data);
      let money = 0;
      let sims = 0;
      if (data.bankroll && this.ctx.bankroll) money = await this.ctx.bankroll.importData(data.bankroll);
      if (data.simulations && this.ctx.simulations) sims = await this.ctx.simulations.importData(data.simulations);
      // 0.9.0: Daten der früheren YUMEKO-KI/Academy werden nicht mehr eingelesen (sie bleiben in der Datei).
      const oldAi = data.yumeko || data.academy ? ' Enthaltene Daten der früheren YUMEKO-KI und Academy wurden nicht übernommen; sie bleiben in der Datei erhalten.' : '';
      this._notice = { tone: 'ok', text: `Import: ${res.added} Runden hinzugefügt, ${res.skipped} bereits vorhanden (nicht überschrieben), ${res.invalid} ungültig${money ? `, ${money} Echtgeld-Einträge` : ''}${sims ? `, ${sims} Simulationen` : ''}.${oldAi}` };
    } catch (err) {
      this._notice = { tone: 'warn', text: `Import fehlgeschlagen: ${err.message}` };
    }
    this.el.querySelector('[data-slot="file"]').value = '';
    this.render();
  }

  async _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const { archive, ui, navigate } = this.ctx;
    switch (btn.dataset.action) {
      case 'filter': this._filter = btn.dataset.f; this._limit = PAGE; this.render(); break;
      case 'open': ui.set('openRoundId', btn.dataset.id); navigate('runde'); break;
      case 'more': this._limit += PAGE; this._renderList(); break;
      case 'export': {
        const data = await archive.exportData({
          ...(this.ctx.bankroll ? { bankroll: this.ctx.bankroll.exportData() } : {}),
          ...(this.ctx.simulations ? { simulations: this.ctx.simulations.exportData() } : {})
        });
        downloadJson(`bjai-sicherung-${new Date().toISOString().slice(0, 10)}.json`, data);
        this._notice = { tone: 'ok', text: `Sicherung mit ${data.rounds.length} Runden, Echtgeld-Protokoll und Simulationen erstellt. Bewahre die Datei sicher auf (z. B. in „Dateien“) – sie enthält Geldbeträge.` };
        this.render();
        break;
      }
      case 'import': this.el.querySelector('[data-slot="file"]').click(); break;
      case 'clear-ask': this._confirmClear = true; this.render(); break;
      case 'clear-cancel': this._confirmClear = false; this.render(); break;
      case 'clear-do': {
        const ok = this.el.querySelector('input[name="clear-ok"]');
        if (!ok || !ok.checked) { this._notice = { tone: 'warn', text: 'Bitte zuerst bestätigen, dass alle Runden gelöscht werden sollen.' }; this.render(); break; }
        await archive.clearAll({ confirmed: true });
        this._confirmClear = false;
        this._notice = { tone: 'ok', text: 'Das Spielarchiv wurde gelöscht.' };
        this.render();
        break;
      }
      default: break;
    }
  }

  render() {
    const { archive } = this.ctx;
    const s = summarizeRounds(archive.rounds);
    const notice = this._notice ? `<p class="notice notice--${this._notice.tone}" role="status">${this._notice.tone === 'ok' ? ICONS.check : ICONS.warning}<span>${esc(this._notice.text)}</span></p>` : '';
    const storage = archive.kind === 'indexeddb'
      ? 'Gespeichert in der lokalen Datenbank (IndexedDB) dieses Geräts.'
      : 'IndexedDB ist nicht verfügbar – das Archiv liegt im kleineren lokalen Speicher. Bitte regelmässig exportieren.';
    this.el.querySelector('[data-slot="top"]').innerHTML = `
      ${notice}
      ${archive.error ? `<p class="notice notice--warn">${ICONS.warning}<span>${esc(archive.error)}</span></p>` : ''}
      ${archive.invalid ? `<p class="notice notice--warn">${ICONS.warning}<span>${archive.invalid} gespeicherte Einträge sind unlesbar. Sie bleiben unverändert erhalten.</span></p>` : ''}
      <div class="stat-row">
        <div class="stat"><b>${s.rounds}</b><span>Runden</span></div>
        <div class="stat stat--ok"><b>${s.win}</b><span>Gewonnen</span></div>
        <div class="stat stat--bad"><b>${s.loss}</b><span>Verloren</span></div>
        <div class="stat"><b>${s.push}</b><span>Push</span></div>
        <div class="stat stat--warn"><b>${s.open}</b><span>Offen</span></div>
      </div>
      <p class="hint">Netto ${s.net >= 0 ? '+' : ''}${s.net.toFixed(1)} Einsätze aus ${s.netHands} Händen.${s.moneyHands ? ` Mit Geldbeträgen: ${s.moneyHands} Hände, Einsatz ${s.staked.toFixed(2)}, netto ${s.moneyNet >= 0 ? '+' : ''}${s.moneyNet.toFixed(2)}.` : ''} Ergebnisse hängen stark vom Zufall ab – keine Gewinngarantie. ${esc(storage)}</p>`;
    this.el.querySelector('[data-slot="filters"]').innerHTML = FILTERS.map(([f, label]) => `<button type="button" data-action="filter" data-f="${f}" aria-pressed="${this._filter === f}">${label}</button>`).join('');
    this._renderList();
    this.el.querySelector('[data-slot="bottom"]').innerHTML = `
      <section class="group">
        <h2 class="group-title">SICHERUNG</h2>
        <p class="group-help">Alle Daten bleiben auf diesem Gerät. Safari kann Website-Daten löschen (z. B. „Verlauf löschen“ oder lange Nichtbenutzung im Browser-Tab). Exportiere deshalb regelmässig eine Sicherung.</p>
        <div class="btn-row">
          <button type="button" class="btn btn--secondary" data-action="export" ${archive.rounds.length ? '' : 'disabled'}>Als JSON exportieren</button>
          <button type="button" class="btn btn--secondary" data-action="import">Sicherung importieren</button>
        </div>
        <p class="hint">Beim Import werden vorhandene Runden nie überschrieben.</p>
      </section>
      <section class="group">
        <h2 class="group-title">ARCHIV LÖSCHEN</h2>
        ${this._confirmClear ? `
          <div class="danger-box">
            <p><b>Alle ${archive.rounds.length} Runden endgültig löschen?</b> Das kann nicht rückgängig gemacht werden.</p>
            <label class="row row--check"><span>Ja, ich möchte das ganze Spielarchiv löschen.</span><input type="checkbox" name="clear-ok"></label>
            <div class="btn-row">
              <button type="button" class="btn btn--danger" data-action="clear-do">Endgültig löschen</button>
              <button type="button" class="btn btn--ghost" data-action="clear-cancel">Abbrechen</button>
            </div>
          </div>`
          : `<button type="button" class="btn btn--ghost" data-action="clear-ask" ${archive.rounds.length ? '' : 'disabled'}>Ganzes Archiv löschen …</button>`}
      </section>`;
  }

  _renderList() {
    const { archive } = this.ctx;
    const list = filterRounds(archive.rounds, { text: this._text, outcome: this._filter });
    const shown = list.slice(0, this._limit);
    const rows = shown.map((r) => {
      const out = roundOutcome(r);
      return `
        <button type="button" class="round-row round-row--${out}" data-action="open" data-id="${esc(r.id)}">
          <span class="round-row-main">
            <span class="round-row-date">${esc(fmtDateTime(r.startedAt))}</span>
            <span class="round-row-cards">Dealer ${esc(ranks(r.dealer.cards))}${r.dealer.total != null ? ` (${r.dealer.total})` : ''} · ${r.hands.map((h, i) => `${r.hands.length > 1 ? `H${i + 1} ` : ''}${esc(ranks(h.cards))}${h.total != null ? ` (${h.total})` : ''}`).join(' · ')}</span>
            <span class="round-row-meta">${esc(r.profile ? r.profile.name : '–')} · ${esc(STATUS_TEXT[r.status])}${(() => { const ins = roundInsight(r); return `${ins.deviations ? ` · ${ins.deviations} Abweichung${ins.deviations === 1 ? '' : 'en'}` : ''}${ins.reported ? ' · Erkennung gemeldet' : ''}${r.rules.decksUnknown ? ' · Decks unbekannt' : ''}`; })()}</span>
          </span>
          <span class="outcome-chip outcome-chip--${out}">${esc(OUT_TEXT[out])}</span>
        </button>`;
    }).join('');
    this.el.querySelector('[data-slot="list"]').innerHTML = `
      <p class="hint">${list.length} ${list.length === 1 ? 'Runde' : 'Runden'}${list.length !== archive.rounds.length ? ` von ${archive.rounds.length}` : ''}</p>
      <div class="round-list">${rows || '<p class="empty-note">Noch keine Runden. Abgeschlossene Runden aus der Live-Erkennung werden hier automatisch gespeichert.</p>'}</div>
      ${list.length > shown.length ? `<button type="button" class="btn btn--ghost" data-action="more">Weitere ${Math.min(PAGE, list.length - shown.length)} anzeigen</button>` : ''}`;
  }
}
