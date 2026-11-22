// Einzelne archivierte Runde: Details ansehen, Karten/Aktionen/Ergebnis korrigieren,
// Einsatz erfassen, löschen. Jede Korrektur wird protokolliert.
import { View, subHeader } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { RANKS } from '../game/hand.js';
import { OUTCOME_LABEL } from '../game/settle.js';
import { ACTION_TEXT, ACTIONS_NOW, STATUS_TEXT } from '../archive/round-record.js';
import { rulesText } from '../strategy/standard.js';
import { fmtDateTime } from './archive-view.js';

const ROLE = { up: 'offen', hole: '2. Karte', hit: 'gezogen' };

export class RoundView extends View {
  mount() {
    this.el.className = 'screen screen-sub';
    this._sheet = null;
    this._confirmDelete = false;
    this._notice = null;
    this.el.innerHTML = `
      ${subHeader('Runde', 'archiv')}
      <div class="sub-content" data-slot="content"></div>
      <div class="sheet-backdrop" data-slot="sheet" hidden></div>`;
    this.el.addEventListener('click', (e) => this._onClick(e));
    this.el.addEventListener('change', (e) => this._onChange(e));
    this.listen(this.ctx.archive, 'change', () => this.render());
    this.render();
  }

  get round() {
    return this.ctx.archive.get(this.ctx.ui.openRoundId);
  }

  async _save(mutate, note, changes = []) {
    try {
      await this.ctx.archive.update(this.round.id, mutate, note, changes);
      this._notice = { tone: 'ok', text: 'Gespeichert. Die Runde gilt jetzt als manuell bestätigt.' };
    } catch (err) {
      this._notice = { tone: 'warn', text: err.message };
    }
    this._sheet = null;
    this.render();
  }

  _cards(rec, where) {
    return where === 'dealer' ? rec.dealer.cards : rec.hands[Number(where)].cards;
  }

  async _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const rec = this.round;
    if (!rec) return;
    const a = btn.dataset.action;
    switch (a) {
      case 'card': this._sheet = { where: btn.dataset.where, index: Number(btn.dataset.index) }; this.render(); break;
      case 'add-card': this._sheet = { where: btn.dataset.where, index: -1 }; this.render(); break;
      case 'close-sheet': this._sheet = null; this.render(); break;
      case 'pick-rank': {
        const { where, index } = this._sheet;
        const rank = btn.dataset.rank;
        const old = index >= 0 ? this._cards(rec, where)[index].rank : null;
        await this._save((r) => {
          const list = this._cards(r, where);
          if (index >= 0) { list[index].rank = rank; list[index].corrected = true; } else list.push({ rank, score: null, corrected: true });
        }, index >= 0 ? `Karte ${old} → ${rank}` : `Karte ${rank} ergänzt`, index >= 0 ? [{ from: old, to: rank }] : []);
        break;
      }
      case 'remove-card': {
        const { where, index } = this._sheet;
        const old = this._cards(rec, where)[index].rank;
        await this._save((r) => { this._cards(r, where).splice(index, 1); }, `Karte ${old} entfernt`, [{ from: old, to: 'keine' }]);
        break;
      }
      case 'outcome': {
        const h = Number(btn.dataset.hand);
        const o = btn.dataset.outcome;
        await this._save((r) => {
          if (o === 'auto') { r.hands[h].outcomeSource = null; } else { r.hands[h].outcome = o; r.hands[h].outcomeSource = 'manual'; }
        }, o === 'auto' ? `Hand ${h + 1}: Ergebnis automatisch` : `Hand ${h + 1}: ${OUTCOME_LABEL[o]}`);
        break;
      }
      case 'add-split':
        await this._save((r) => { r.hands.push({ cards: [], actions: [], split: true }); r.hands[0].split = true; }, 'Split-Hand ergänzt');
        break;
      case 'delete':
        if (!this._confirmDelete) { this._confirmDelete = true; this.render(); break; }
        await this.ctx.archive.remove(rec.id);
        this.ctx.ui.set('openRoundId', null);
        if (this.ctx.ui.pendingRound === rec.id) this.ctx.ui.set('pendingRound', null);
        this.ctx.navigate('archiv');
        break;
      default: break;
    }
  }

  async _onChange(e) {
    const el = e.target;
    const rec = this.round;
    if (!rec) return;
    if (el.name === 'action') {
      const [h, i] = el.dataset.ref.split(':').map(Number);
      const val = el.value;
      await this._save((r) => { r.hands[h].actions[i].action = val; r.hands[h].actions[i].inferred = false; if (val === 'DOUBLE') r.hands[h].doubled = true; }, `Aktion Hand ${h + 1}: ${ACTION_TEXT[val]}`);
    } else if (el.name === 'bet') {
      const h = Number(el.dataset.hand);
      const v = el.value.trim() === '' ? null : Number(el.value.replace(',', '.'));
      if (v != null && !(v >= 0)) { this._notice = { tone: 'warn', text: 'Bitte einen gültigen Einsatz eingeben.' }; this.render(); return; }
      await this._save((r) => { r.hands[h].bet = v; }, `Einsatz Hand ${h + 1}: ${v ?? '–'}`);
    } else if (el.name === 'notes') {
      await this._save((r) => { r.notes = el.value; }, 'Notiz');
    }
  }

  render() {
    const rec = this.round;
    const content = this.el.querySelector('[data-slot="content"]');
    if (!rec) {
      content.innerHTML = `<p class="notice notice--warn">${ICONS.warning}<span>Runde nicht gefunden.</span></p>`;
      return;
    }
    const notice = this._notice ? `<p class="notice notice--${this._notice.tone}" role="status">${this._notice.tone === 'ok' ? ICONS.check : ICONS.warning}<span>${esc(this._notice.text)}</span></p>` : '';
    const cardBtn = (c, where, i) => `<button type="button" class="mini-card ${c.corrected ? 'is-corrected' : ''} ${c.score != null && c.score < 0.8 ? 'is-unsure' : ''}" data-action="card" data-where="${where}" data-index="${i}" aria-label="Karte ${esc(c.rank)} ändern">${esc(c.rank)}${c.role ? `<small>${ROLE[c.role] || ''}</small>` : ''}</button>`;
    const addBtn = (where) => `<button type="button" class="mini-card mini-card--add" data-action="add-card" data-where="${where}" aria-label="Karte ergänzen">+</button>`;
    const rc = rec.recognition;
    const hands = rec.hands.map((h, hi) => `
      <section class="group">
        <h2 class="group-title">${rec.hands.length > 1 ? `HAND ${hi + 1}${h.split ? ' (SPLIT)' : ''}` : 'DEINE HAND'} · ${h.total ?? '–'}</h2>
        <div class="mini-cards">${h.cards.map((c, i) => cardBtn(c, String(hi), i)).join('')}${addBtn(String(hi))}</div>
        ${h.actions.length ? `
          <div class="action-list">
            ${h.actions.map((a, i) => `
              <label class="action-row">
                <span>${esc(a.cardsBefore.join(' ') || '–')}</span>
                <select name="action" data-ref="${hi}:${i}" ${a.action === 'SURRENDER' ? 'disabled' : ''}>
                  ${(a.action === 'SURRENDER' ? ['SURRENDER'] : ACTIONS_NOW).map((x) => `<option value="${x}" ${x === a.action ? 'selected' : ''}>${ACTION_TEXT[x]}</option>`).join('')}
                </select>
                <span class="hint">${a.recommended ? `Empfohlen: ${esc(ACTION_TEXT[a.recommended] || a.recommended)}` : 'keine Empfehlung'}${a.inferred ? ' · erkannt' : ''}</span>
              </label>`).join('')}
          </div>
          <p class="hint">Die Kamera kann Verdoppeln nicht von Ziehen unterscheiden – bitte bei Bedarf korrigieren.</p>` : '<p class="hint">Keine Aktionen erfasst.</p>'}
        <div class="outcome-pick" role="group" aria-label="Ergebnis">
          ${['win', 'loss', 'push'].map((o) => `<button type="button" class="${h.outcome === o ? 'is-on' : ''} outcome-btn outcome-btn--${o}" data-action="outcome" data-hand="${hi}" data-outcome="${o}">${OUTCOME_LABEL[o]}</button>`).join('')}
          ${h.outcomeSource === 'manual' ? `<button type="button" class="outcome-btn" data-action="outcome" data-hand="${hi}" data-outcome="auto">Automatisch</button>` : ''}
        </div>
        <p class="hint">${h.outcome ? `${esc(h.outcome === 'surrender' ? 'Aufgegeben (alte Daten)' : OUTCOME_LABEL[h.outcome])} · ${h.outcomeSource === 'manual' ? 'manuell bestätigt' : 'automatisch'}` : 'Ergebnis offen'}${h.outcomeReason ? ` – ${esc(h.outcomeReason)}` : ''}${h.net != null ? ` · Netto ${h.net >= 0 ? '+' : ''}${h.net}${h.bet != null ? '' : ' Einsätze'}` : ''}</p>
        <label class="field field--inline"><span>Einsatz (optional)</span><input name="bet" data-hand="${hi}" inputmode="decimal" value="${h.bet ?? ''}" placeholder="z. B. 10"></label>
      </section>`).join('');

    content.innerHTML = `
      ${notice}
      <p class="lead">${esc(fmtDateTime(rec.startedAt))} · <span class="status-chip status-chip--${rec.status}">${esc(STATUS_TEXT[rec.status])}</span></p>
      <p class="meta">${esc(rec.profile ? `Profil: ${rec.profile.name}${rec.profile.version ? ` (v${rec.profile.version})` : ''}` : 'Profil unbekannt')} · ${esc(rulesText(rec.rules))}</p>
      <p class="meta">Erkennung: ${rc && rc.minScore != null ? `geringste Sicherheit ${Math.round(rc.minScore * 100)} %` : '–'}${rc && rc.frames ? ` · ${rc.unsureFrames} von ${rc.frames} Auswertungen unsicher` : ''} · ${rec.confirmation === 'manual' ? 'manuell bestätigt' : 'automatisch erkannt'}</p>
      <section class="group">
        <h2 class="group-title">DEALER · ${rec.dealer.total ?? '–'}${rec.dealer.final ? ' (Endstand)' : ''}</h2>
        <div class="mini-cards">${rec.dealer.cards.map((c, i) => cardBtn(c, 'dealer', i)).join('')}${addBtn('dealer')}</div>
        <p class="hint">Antippen zum Korrigieren. Die verdeckte Karte zählt erst, wenn sie erkannt oder eingetragen ist.</p>
      </section>
      ${hands}
      ${rec.hands.length === 1 ? '<button type="button" class="btn btn--ghost" data-action="add-split">Split-Hand ergänzen</button>' : ''}
      <label class="field"><span>Notiz</span><textarea name="notes" rows="2" maxlength="1000">${esc(rec.notes || '')}</textarea></label>
      ${rec.corrections.length ? `<details class="setup"><summary>Korrekturen (${rec.corrections.length})</summary><ul class="plain-list">${rec.corrections.map((c) => `<li>${esc(fmtDateTime(c.at))}: ${esc(c.note)}</li>`).join('')}</ul></details>` : ''}
      <button type="button" class="btn ${this._confirmDelete ? 'btn--danger' : 'btn--ghost'}" data-action="delete">${this._confirmDelete ? 'Wirklich löschen?' : 'Runde löschen'}</button>`;

    const sheet = this.el.querySelector('[data-slot="sheet"]');
    if (!this._sheet) { sheet.hidden = true; sheet.innerHTML = ''; return; }
    const cur = this._sheet.index >= 0 ? this._cards(rec, this._sheet.where)[this._sheet.index] : null;
    sheet.hidden = false;
    sheet.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Karte wählen">
        <strong class="sheet-title">${cur ? `Karte ${esc(cur.rank)} korrigieren` : 'Karte ergänzen'}</strong>
        <div class="rank-grid">${RANKS.map((r) => `<button type="button" class="rank-btn ${cur && cur.rank === r ? 'is-current' : ''}" data-action="pick-rank" data-rank="${r}">${r}</button>`).join('')}</div>
        ${cur ? '<button type="button" class="btn btn--danger" data-action="remove-card">Karte entfernen</button>' : ''}
        <button type="button" class="btn btn--ghost" data-action="close-sheet">Abbrechen</button>
      </div>`;
  }
}
