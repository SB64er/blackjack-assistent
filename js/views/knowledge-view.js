// YUMEKOS Wissen anzeigen, korrigieren, löschen und eigene Regeln ergänzen.
import { View, subHeader } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { CATEGORIES, STATUS, CONFIDENCE } from '../yumeko/knowledge.js';
import { rulesText, normalizeRules, ROWS, UPCARDS, rowLabel, upLabel, cellKey, parseKey, CODES_BY_KIND, CODE_LABEL } from '../strategy/standard.js';
import { fmtDateTime } from './archive-view.js';

const ORIGIN = { archive: 'Spielarchiv', video: 'Video', analysis: 'Analyse', math: 'Berechnung', user: 'Benutzer', source: 'Quelle' };
const STATUS_TONE = {
  [STATUS.observed]: 'calc', [STATUS.unconfirmed]: 'assume', [STATUS.verified]: 'calc',
  [STATUS.contradicted]: 'warn', [STATUS.userConfirmed]: 'ai', [STATUS.rejected]: 'warn'
};

export class KnowledgeView extends View {
  mount() {
    this.el.className = 'screen screen-sub';
    this._cat = 'all';
    this._sheet = null;
    this._confirmDelete = null;
    this._notice = null;
    this.el.innerHTML = `
      ${subHeader('YUMEKO – Wissen', 'yumeko')}
      <div class="sub-content" data-slot="content"></div>
      <div class="sheet-backdrop" data-slot="sheet" hidden></div>`;
    this.el.addEventListener('click', (e) => this._onClick(e));
    this.listen(this.ctx.knowledge, 'change', () => this.render());
    this.editMode = this.ctx.ui.knowledgeFilter === 'edit';
    this.render();
  }

  async _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const { knowledge, ui, navigate } = this.ctx;
    const id = btn.dataset.id;
    try {
      switch (btn.dataset.action) {
        case 'cat': this._cat = btn.dataset.cat; this.render(); break;
        case 'edit': this._sheet = { type: 'edit', id }; this.render(); break;
        case 'new': this._sheet = { type: 'new' }; this.render(); break;
        case 'close-sheet': this._sheet = null; this.render(); break;
        case 'save-edit': {
          const sh = this.el.querySelector('.sheet');
          await knowledge.correct(id, {
            content: sh.querySelector('[name="content"]').value,
            status: sh.querySelector('[name="status"]').value,
            confidence: { level: sh.querySelector('[name="confidence"]').value }
          });
          this._sheet = null;
          this._notice = { tone: 'ok', text: 'Korrektur gespeichert. YUMEKO überschreibt diesen Eintrag nicht mehr automatisch.' };
          this.render();
          break;
        }
        case 'save-new': {
          const sh = this.el.querySelector('.sheet');
          const content = sh.querySelector('[name="content"]').value.trim();
          const cellKind = sh.querySelector('[name="kind"]').value;
          const data = {};
          let category = 'hypothesis';
          let status = STATUS.unconfirmed;
          if (cellKind) {
            const value = Number(sh.querySelector('[name="value"]').value);
            const up = Number(sh.querySelector('[name="up"]').value);
            const code = sh.querySelector('[name="code"]').value;
            if (!CODES_BY_KIND[cellKind].includes(code)) throw new Error('Diese Aktion passt nicht zur Handart.');
            if (!parseKey(cellKey(cellKind, value, up))) throw new Error(cellKind === 'soft' ? 'Weiche Hände: Wert 13 bis 21.' : (cellKind === 'pair' ? 'Paare: Wert 2 bis 11.' : 'Harte Hände: Wert 5 bis 21.'));
            data.cell = { key: cellKey(cellKind, value, up), code };
            category = 'rule';
            status = STATUS.userConfirmed;
          }
          if (!content && !data.cell) throw new Error('Bitte einen Inhalt eingeben.');
          await knowledge.upsert({
            id: `u:${Date.now().toString(36)}`,
            category,
            content: content || `${rowLabel(cellKind, Number(data.cell.key.split(':')[1]))} gegen ${upLabel(Number(data.cell.key.split(':')[2]))}: ${CODE_LABEL[data.cell.code]}`,
            origin: { type: 'user', detail: 'Von Hand eingetragen' },
            rules: normalizeRules(this.ctx.settings.get('rules')),
            confidence: { level: 'mittel', basis: 'Eigene Angabe' },
            status,
            data
          });
          this._sheet = null;
          this._notice = { tone: 'ok', text: data.cell ? 'Strategieregel gespeichert. Sie wird beim nächsten Strategieentwurf mathematisch geprüft und nur übernommen, wenn sie besteht.' : 'Hypothese gespeichert (unbestätigt).' };
          this.render();
          break;
        }
        case 'delete':
          if (this._confirmDelete !== id) { this._confirmDelete = id; this.render(); break; }
          this._confirmDelete = null;
          await knowledge.remove(id);
          this._notice = { tone: 'ok', text: 'Eintrag gelöscht.' };
          this.render();
          break;
        case 'delete-video':
          if (this._confirmDelete !== id) { this._confirmDelete = id; this.render(); break; }
          this._confirmDelete = null;
          await knowledge.removeVideo(id);
          this._notice = { tone: 'ok', text: 'Lernsequenz und zugehörige Erkenntnisse gelöscht.' };
          this.render();
          break;
        case 'open-round': ui.set('openRoundId', id); navigate('runde'); break;
        default: break;
      }
    } catch (err) {
      this._notice = { tone: 'warn', text: err.message };
      this.render();
    }
  }

  _itemHtml(it) {
    const confirm = this._confirmDelete === it.id;
    return `
      <article class="knowledge-card knowledge-card--${esc(it.category)}">
        <div class="knowledge-head">
          <span class="kind kind--${STATUS_TONE[it.status] || 'assume'}">${esc(it.status)}</span>
          <span class="meta">${esc(CATEGORIES[it.category])}</span>
        </div>
        <p>${esc(it.content)}</p>
        <p class="meta">Ursprung: ${esc(ORIGIN[it.origin.type] || it.origin.type)}${it.origin.detail ? ` (${esc(it.origin.detail)})` : ''} · ${esc(fmtDateTime(it.updatedAt))}${it.rules ? ` · ${esc(rulesText(it.rules))}` : ''}</p>
        <p class="meta">Vertrauen: ${esc(it.confidence.level)}${it.confidence.n != null ? ` (n = ${it.confidence.n})` : ''}${it.confidence.basis ? ` – ${esc(it.confidence.basis)}` : ''}${it.edited ? ' · vom Benutzer korrigiert' : ''}</p>
        ${it.refs.rounds.length ? `<p class="meta">Archiv: ${it.refs.rounds.slice(-3).map((r) => `<button type="button" class="link-btn" data-action="open-round" data-id="${esc(r)}">Runde</button>`).join(' ')}${it.refs.rounds.length > 3 ? ` (+${it.refs.rounds.length - 3})` : ''}</p>` : ''}
        ${it.refs.videos.length ? `<p class="meta">Video-Lernsequenz: ${esc(it.refs.videos.join(', '))}</p>` : ''}
        ${it.category === 'source' ? '' : `
          <div class="btn-row">
            <button type="button" class="btn btn--small" data-action="edit" data-id="${esc(it.id)}">Korrigieren</button>
            <button type="button" class="btn btn--small ${confirm ? 'btn--danger' : ''}" data-action="delete" data-id="${esc(it.id)}">${confirm ? 'Wirklich löschen?' : 'Löschen'}</button>
          </div>`}
      </article>`;
  }

  render() {
    const { knowledge } = this.ctx;
    const notice = this._notice ? `<p class="notice notice--${this._notice.tone}" role="status">${this._notice.tone === 'ok' ? ICONS.check : ICONS.warning}<span>${esc(this._notice.text)}</span></p>` : '';
    const counts = Object.fromEntries(Object.keys(CATEGORIES).map((c) => [c, knowledge.byCategory(c).length]));
    const tabs = [['all', 'Alle', knowledge.items.length], ...Object.entries(CATEGORIES).map(([k, v]) => [k, v, k === 'version' ? knowledge.versions.length : counts[k]])];
    let items = this._cat === 'all' ? knowledge.items : knowledge.byCategory(this._cat);
    if (this.editMode) items = items.filter((i) => i.category !== 'source');
    const videos = this._cat === 'video' || this._cat === 'all' ? knowledge.videos : [];
    const versions = this._cat === 'version' ? knowledge.versions : [];
    this.el.querySelector('[data-slot="content"]').innerHTML = `
      ${notice}
      ${knowledge.error ? `<p class="notice notice--warn">${ICONS.warning}<span>${esc(knowledge.error)}</span></p>` : ''}
      <p class="lead">${this.editMode ? 'Falsche Lerninformationen korrigieren oder löschen.' : 'Getrennt nach Beobachtungen, geprüften Erkenntnissen und unbestätigten Hypothesen.'} Das Wissen bleibt auch nach dem Schliessen der App erhalten.</p>
      <div class="tab-scroll">${tabs.map(([k, label, n]) => `<button type="button" class="chip ${this._cat === k ? 'is-active' : ''}" data-action="cat" data-cat="${k}">${esc(label)} <b>${n}</b></button>`).join('')}</div>
      <button type="button" class="btn btn--secondary" data-action="new">+ Eigene Hypothese oder Strategieregel</button>
      ${videos.length ? `<section class="group"><h2 class="group-title">VIDEO-LERNSEQUENZEN</h2>${videos.map((v) => `
        <article class="knowledge-card knowledge-card--video">
          <p><b>${esc(v.source)}</b> · ${v.scenes.length} Szenen · ${esc(fmtDateTime(v.createdAt))}</p>
          <button type="button" class="btn btn--small ${this._confirmDelete === v.id ? 'btn--danger' : ''}" data-action="delete-video" data-id="${esc(v.id)}">${this._confirmDelete === v.id ? 'Wirklich löschen?' : 'Lernsequenz löschen'}</button>
        </article>`).join('')}</section>` : ''}
      ${versions.length ? versions.map((v) => `<article class="knowledge-card"><p><b>Version ${v.number}</b> · ${esc(v.status)} · ${esc(rulesText(v.rules))} · ${Object.keys(v.overrides).length} Abweichungen</p></article>`).join('') : ''}
      <div class="knowledge-list">${items.map((it) => this._itemHtml(it)).join('') || (versions.length || videos.length ? '' : '<p class="empty-note">Noch keine Einträge in diesem Bereich.</p>')}</div>`;
    this._renderSheet();
  }

  _renderSheet() {
    const sheet = this.el.querySelector('[data-slot="sheet"]');
    if (!this._sheet) { sheet.hidden = true; sheet.innerHTML = ''; return; }
    sheet.hidden = false;
    if (this._sheet.type === 'edit') {
      const it = this.ctx.knowledge.get(this._sheet.id);
      if (!it) { this._sheet = null; sheet.hidden = true; return; }
      sheet.innerHTML = `
        <div class="sheet" role="dialog" aria-modal="true" aria-label="Erkenntnis korrigieren">
          <strong class="sheet-title">Erkenntnis korrigieren</strong>
          <label class="field"><span>Inhalt</span><textarea name="content" rows="5" maxlength="2000">${esc(it.content)}</textarea></label>
          <label class="field"><span>Prüfstatus</span><select name="status">${Object.values(STATUS).map((s) => `<option ${s === it.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          <label class="field"><span>Vertrauensniveau</span><select name="confidence">${CONFIDENCE.map((c) => `<option ${c === it.confidence.level ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
          <button type="button" class="btn btn--primary" data-action="save-edit" data-id="${esc(it.id)}">Speichern</button>
          <button type="button" class="btn btn--ghost" data-action="close-sheet">Abbrechen</button>
        </div>`;
      return;
    }
    const kinds = { '': 'Keine (nur Text)', hard: 'Hart', soft: 'Weich', pair: 'Paar' };
    sheet.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Eigene Erkenntnis">
        <strong class="sheet-title">Eigene Hypothese oder Strategieregel</strong>
        <label class="field"><span>Inhalt</span><textarea name="content" rows="3" maxlength="2000" placeholder="z. B. In meinem Casino steht der Dealer auf weicher 17."></textarea></label>
        <p class="hint">Optional: konkrete Strategieregel. Sie wird erst nach mathematischer Prüfung in einen Strategieentwurf übernommen.</p>
        <label class="field"><span>Handart</span><select name="kind">${Object.entries(kinds).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="field"><span>Wert</span><select name="value">${[...new Set([...ROWS.hard, ...ROWS.pair])].sort((a, b) => a - b).map((v) => `<option value="${v}">${v}</option>`).join('')}</select></label>
        <label class="field"><span>Dealerkarte</span><select name="up">${UPCARDS.map((u) => `<option value="${u}">${upLabel(u)}</option>`).join('')}</select></label>
        <label class="field"><span>Aktion</span><select name="code">${['H', 'S', 'D', 'Ds', 'P'].map((c) => `<option value="${c}">${esc(CODE_LABEL[c])}</option>`).join('')}</select></label>
        <p class="hint">Weich: Wert = Gesamtsumme (z. B. A,7 = 18). Paar: Wert = Kartenwert (Ass = 11).</p>
        <button type="button" class="btn btn--primary" data-action="save-new">Speichern</button>
        <button type="button" class="btn btn--ghost" data-action="close-sheet">Abbrechen</button>
      </div>`;
  }
}
