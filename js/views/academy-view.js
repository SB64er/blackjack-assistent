// Yumeko Academy (Phase 8.7): YouTube-Bibliothek, Wissensbibliothek, Lernstatistik,
// Strategie-Engine (Situationsrechner) und Datenverwaltung.
// Alle Zahlen stammen aus gespeicherten Daten oder aus Berechnungen – nichts ist erfunden.
import { View, subHeader } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { fmtDateTime, downloadJson } from './archive-view.js';
import { VIDEO_STATUS, STEP_ORDER, STEP_TEXT, CLAIM_STATUS } from '../academy/academy-store.js';
import { VERDICT } from '../academy/verify.js';
import { TOPICS } from '../academy/extract.js';
import { videoLink, fmtTime, parseYouTubeUrl } from '../academy/youtube.js';
import { loadServerConfig, saveServerConfig } from '../academy/server-client.js';
import { analyzeHand, ACT_LABEL, exactRulesText, EXACT_ASSUMPTIONS } from '../strategy/exact.js';
import { recurringMistakes, learningProgress } from '../archive/insights.js';
import { storageEstimate, DB_VERSION } from '../core/idb.js';
import { normalizeRules } from '../strategy/standard.js';
import { deckChoice } from '../strategy/table-rules.js';

const TABS = [
  ['videos', 'YouTube-Bibliothek'],
  ['wissen', 'Wissensbibliothek'],
  ['statistik', 'Lernstatistik'],
  ['rechner', 'Strategie-Engine'],
  ['daten', 'Daten & Server']
];
const STATUS_TONE = { waiting: 'assume', running: 'sim', transcript: 'sim', frames: 'sim', strategies: 'sim', verifying: 'sim', verified: 'calc', partial: 'warn', unverifiable: 'assume', error: 'warn' };
const CLAIM_TONE = { confirmed: 'calc', contradicted: 'warn', partial: 'warn', unverifiable: 'assume', unchecked: 'assume' };
const STEP_MARK = { ok: '✓', fail: '✗', skip: '–', run: '…', wait: '○' };
const CARD_OPTS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const FILTERS = [['all', 'Alle'], ['confirmed', 'Bestätigt'], ['unchecked', 'Ungeprüft'], ['conflict', 'Widersprüchlich'], ['contradicted', 'Fehlerhaft'], ['unverifiable', 'Nicht überprüfbar']];

const pctx = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d).replace('.', ',')} %`;
const rate = (x, d = 0) => `${(x * 100).toFixed(d).replace('.', ',')} %`;

export class AcademyView extends View {
  mount() {
    this.el.className = 'screen screen-sub screen-academy';
    this._tab = (this.ctx.ui && this.ctx.ui.academyTab) || 'videos';
    this._notice = null;
    this._open = new Set();
    this._confirm = null;
    this._filter = 'all';
    this._q = '';
    this._sheet = null;
    this._calc = { p1: '10', p2: '6', p3: '', up: '10', peek: true, surrender: 'keine', doubleOn: 'alle', result: null, busy: false };
    this.el.innerHTML = `
      ${subHeader('Yumeko Academy', 'yumeko')}
      <div class="sub-content">
        <div data-slot="notice"></div>
        <div class="tab-scroll" role="tablist" data-slot="tabs"></div>
        <div data-slot="static"></div>
        <div data-slot="body"></div>
      </div>
      <div class="sheet-backdrop" data-slot="sheet" hidden></div>
      <input type="file" accept="application/json,.json" data-slot="file" hidden>`;
    this.el.addEventListener('click', (e) => this._onClick(e));
    this.el.addEventListener('input', (e) => this._onInput(e));
    this.el.addEventListener('change', (e) => this._onChange(e));
    this.el.addEventListener('paste', (e) => {
      if (e.target.name !== 'yt-url') return;
      // Eingefügter Link: Analyse sofort starten (keine weitere Bestätigung).
      setTimeout(() => this._tryAutoStart(e.target), 0);
    });
    this.el.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = this.el.querySelector('input[name="yt-url"]');
      if (input) this._addLink(input.value, input);
    });
    this.el.querySelector('[data-slot="file"]').addEventListener('change', (e) => this._import(e.target.files && e.target.files[0]));
    this.listen(this.ctx.academy, 'change', () => this._renderBody());
    this.listen(this.ctx.settings, 'change', () => this._renderBody());
    if (this.ctx.archive) this.listen(this.ctx.archive, 'change', () => { if (this._tab === 'statistik') this._renderBody(); });
    this.render();
  }

  destroy() {
    super.destroy();
    clearTimeout(this._confirmTimer);
    clearTimeout(this._autoTimer);
  }

  _say(tone, text) { this._notice = { tone, text }; this._renderNotice(); }

  _renderNotice() {
    const n = this._notice;
    this.el.querySelector('[data-slot="notice"]').innerHTML = n
      ? `<p class="notice notice--${n.tone}" role="status">${n.tone === 'ok' ? ICONS.check : ICONS.warning}<span>${esc(n.text)}</span></p>`
      : '';
  }

  _tryAutoStart(input) {
    const p = parseYouTubeUrl(input.value);
    if (p.ok) this._addLink(input.value, input);
  }

  async _addLink(url, input) {
    if (this._adding) return;
    this._adding = true;
    try {
      const r = await this.ctx.academy.addLink(url);
      if (input) input.value = '';
      this._open.add(r.source.id);
      if (r.duplicate) this._say('info', 'Dieses Video ist bereits in der Bibliothek. Mit „Analyse wiederholen“ wird es neu geprüft.');
      else {
        this._say('ok', 'Link erkannt – die Analyse läuft. Der Fortschritt steht beim Video.');
        r.done.then((s) => {
          if (!this._mounted()) return;
          this._say(s.status === 'error' ? 'warn' : 'ok', `Analyse beendet: ${VIDEO_STATUS[s.status]}${s.error ? ` – ${s.error}` : ''}.`);
        }).catch((err) => this._say('warn', err.message));
      }
    } catch (err) {
      this._say('warn', err.message);
    } finally {
      this._adding = false;
      this._renderBody();
    }
  }

  _mounted() { return this.el.isConnected; }

  _onInput(e) {
    const t = e.target;
    if (t.name === 'q') { this._q = t.value; this._renderBody(); }
    if (t.name === 'yt-url') {
      clearTimeout(this._autoTimer);
      // Getippter/eingefügter Link: kurz warten, dann automatisch starten, wenn er gültig ist.
      this._autoTimer = setTimeout(() => { if (this._mounted()) this._tryAutoStart(t); }, 700);
    }
  }

  _onChange(e) {
    const t = e.target;
    if (t.name && t.name.startsWith('calc-')) {
      const k = t.name.slice(5);
      this._calc[k] = t.type === 'checkbox' ? t.checked : t.value;
      if (k === 'peek') this._calc.peek = t.value === 'ja';
    }
  }

  async _import(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const src = data && data.format === 'bjai-academy' ? data : (data && data.academy ? data.academy : null);
      if (!src) throw new Error('Keine Yumeko-Academy-Sicherung.');
      const r = await this.ctx.academy.importData(src);
      this._say('ok', `Import: ${r.added} neu, ${r.merged} zusammengeführt, ${r.skipped} bereits vorhanden, ${r.invalid} ungültig. Vorhandenes wurde nicht überschrieben.`);
    } catch (err) {
      this._say('warn', `Import fehlgeschlagen: ${err.message}`);
    }
    this.el.querySelector('[data-slot="file"]').value = '';
    this._renderBody();
  }

  _twoTap(id) {
    if (this._confirm === id) { this._confirm = null; return true; }
    this._confirm = id;
    clearTimeout(this._confirmTimer);
    this._confirmTimer = setTimeout(() => { this._confirm = null; if (this._mounted()) this._renderBody(); }, 4000);
    this._renderBody();
    return false;
  }

  async _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const { academy } = this.ctx;
    const id = btn.dataset.id;
    try {
      switch (btn.dataset.action) {
        case 'tab':
          this._tab = btn.dataset.tab;
          if (this.ctx.ui) this.ctx.ui.academyTab = this._tab;
          this._notice = null;
          this.render();
          return;
        case 'add': { const input = this.el.querySelector('input[name="yt-url"]'); await this._addLink(input ? input.value : '', input); return; }
        case 'toggle': if (this._open.has(id)) this._open.delete(id); else this._open.add(id); break;
        case 'reanalyze':
          academy.analyze(id).then((s) => this._say(s.status === 'error' ? 'warn' : 'ok', `Analyse beendet: ${VIDEO_STATUS[s.status]}.`)).catch((err) => this._say('warn', err.message));
          this._say('info', 'Analyse wird wiederholt …');
          break;
        case 'delete-video':
          if (!this._twoTap(`v:${id}`)) return;
          await academy.removeSource(id);
          this._say('ok', 'Video und nur daraus stammende Erkenntnisse gelöscht.');
          break;
        case 'transcript':
          this._sheet = { kind: 'transcript', id };
          this._renderSheet();
          return;
        case 'sheet-close': this._sheet = null; this._renderSheet(); return;
        case 'sheet-save': {
          const text = this.el.querySelector('textarea[name="transcript"]').value;
          const sid = this._sheet.id;
          this._sheet = null;
          this._renderSheet();
          this._open.add(sid);
          this._say('info', 'Transkript übernommen – die Analyse läuft.');
          academy.setManualTranscript(sid, text).then((s) => this._say(s.status === 'error' ? 'warn' : 'ok', `Analyse beendet: ${VIDEO_STATUS[s.status]}.`)).catch((err) => this._say('warn', err.message));
          break;
        }
        case 'filter': this._filter = btn.dataset.filter; break;
        case 'recheck':
          this._say('info', 'Mathematische Prüfung läuft …');
          await academy.recheckClaims(id ? [id] : null);
          this._say('ok', id ? 'Erkenntnis erneut geprüft.' : `Alle ${academy.claims.length} Erkenntnisse mit den aktuellen Tischregeln erneut geprüft.`);
          break;
        case 'flag': await academy.flagClaim(id, btn.dataset.on === '1'); break;
        case 'delete-claim':
          if (!this._twoTap(`c:${id}`)) return;
          await academy.removeClaim(id);
          this._say('ok', 'Eintrag gelöscht.');
          break;
        case 'delete-feedback': await academy.removeFeedback(id); break;
        case 'calc': this._runCalc(); return;
        case 'export':
          downloadJson(`yumeko-academy-${new Date().toISOString().slice(0, 10)}.json`, academy.exportData());
          this._say('ok', 'Wissensdatenbank exportiert (Datei bleibt auf deinem Gerät).');
          break;
        case 'import': this.el.querySelector('[data-slot="file"]').click(); return;
        case 'reset':
          if (!this._twoTap('reset')) return;
          await academy.resetAll({ confirmed: true });
          this._say('ok', 'Academy-Wissensdatenbank zurückgesetzt. Spielarchiv, Profile und übriges YUMEKO-Wissen bleiben erhalten.');
          break;
        case 'server-save': {
          const v = this.el.querySelector('input[name="server"]').value;
          const cfg = saveServerConfig({ endpoint: v });
          this._say('ok', cfg.endpoint ? 'Server gespeichert. Neue Links senden ab jetzt nur die Video-ID an diesen Server.' : 'Server entfernt. Es wird nichts mehr gesendet.');
          this.render();
          return;
        }
        default: return;
      }
    } catch (err) {
      this._say('warn', err.message);
    }
    this._renderBody();
  }

  _runCalc() {
    const c = this._calc;
    const player = [c.p1, c.p2, c.p3].filter(Boolean);
    const rules = { ...normalizeRules(this.ctx.settings.get('rules')), peek: c.peek, surrender: c.surrender, doubleOn: c.doubleOn };
    c.busy = true;
    c.result = null;
    this._renderBody();
    // Rechnung nach dem Zeichnen starten (bei unbekannter Deckanzahl bis zu ~3 s).
    setTimeout(() => {
      c.result = analyzeHand({ player, up: c.up, rules });
      c.busy = false;
      if (this._mounted()) this._renderBody();
    }, 30);
  }

  render() {
    this._renderNotice();
    this.el.querySelector('[data-slot="tabs"]').innerHTML = TABS.map(([k, label]) => `<button type="button" role="tab" aria-selected="${this._tab === k}" class="chip ${this._tab === k ? 'is-active' : ''}" data-action="tab" data-tab="${k}">${esc(label)}</button>`).join('');
    const st = this.el.querySelector('[data-slot="static"]');
    if (this._tab === 'videos') {
      st.innerHTML = `
        <form class="yt-form" novalidate>
          <label class="field"><span>YouTube-Link einfügen – die Analyse startet automatisch</span>
            <input type="url" name="yt-url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://www.youtube.com/watch?v=…"></label>
          <button type="submit" class="btn btn--yumeko" data-action="add">Analysieren</button>
        </form>`;
    } else if (this._tab === 'wissen') {
      st.innerHTML = `<label class="field field--search"><span>Wissen durchsuchen</span><input type="search" name="q" value="${esc(this._q)}" placeholder="z. B. 16, Split, Versicherung, Soft 17" autocomplete="off"></label>`;
    } else st.innerHTML = '';
    this._renderBody();
    this._renderSheet();
  }

  _renderBody() {
    const body = this.el.querySelector('[data-slot="body"]');
    if (!body) return;
    const fn = { videos: this._videosHtml, wissen: this._knowledgeHtml, statistik: this._statsHtml, rechner: this._calcHtml, daten: this._dataHtml }[this._tab] || this._videosHtml;
    body.innerHTML = fn.call(this);
    if (this._tab === 'daten') this._fillEstimate();
  }

  _renderSheet() {
    const el = this.el.querySelector('[data-slot="sheet"]');
    if (!this._sheet) { el.hidden = true; el.innerHTML = ''; return; }
    const src = this.ctx.academy.getSource(this._sheet.id);
    el.hidden = false;
    el.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Transkript einfügen">
        <strong class="sheet-title">Transkript einfügen</strong>
        <p class="hint">Bei YouTube unter dem Video „Mehr“ › „Transkript anzeigen“ öffnen, den Text kopieren und hier einfügen. Zeitstempel (z. B. „1:23“) werden übernommen. Der Text bleibt auf diesem Gerät.</p>
        <label class="field"><span>${esc(src ? (src.title || `Video ${src.videoId}`) : 'Video')}</span><textarea name="transcript" rows="10" placeholder="0:00&#10;Always split aces and eights …"></textarea></label>
        <div class="btn-row">
          <button type="button" class="btn btn--ghost" data-action="sheet-close">Abbrechen</button>
          <button type="button" class="btn btn--yumeko" data-action="sheet-save">Übernehmen und analysieren</button>
        </div>
      </div>`;
  }

  // --- A: YouTube-Bibliothek ------------------------------------------------
  _videosHtml() {
    const { academy, knowledge } = this.ctx;
    const server = academy.serverConfigured;
    const list = academy.sources;
    const legacy = knowledge ? knowledge.videos.length : 0;
    return `
      <div class="notice notice--info">${ICONS.warning}<span>${server
        ? 'Yumeko-Server eingerichtet: Für neue Links wird nur die Video-ID an deinen Server gesendet (Titel, Transkript). Mit Server ist die Academy nicht vollständig offline.'
        : 'Kein Yumeko-Server eingerichtet. Ein Browser kann Transkripte und Videobilder von YouTube nicht direkt lesen – Yumeko zeigt deshalb ehrlich „Kein Transkript verfügbar“. Du kannst ein Transkript selbst einfügen oder unter „Daten & Server“ einen eigenen Server eintragen.'}</span></div>
      ${list.length ? `<div class="academy-list">${list.map((s) => this._videoCard(s)).join('')}</div>` : '<p class="empty-note">Noch keine Videos. Füge oben einen YouTube-Link ein.</p>'}
      ${legacy ? `<p class="hint">Dazu ${legacy} Video-Lernsequenz${legacy === 1 ? '' : 'en'} aus „Video lernen“ (Videodatei oder Kamera, seit 0.6.0) – unverändert im YUMEKO-Wissen. <button type="button" class="link-btn" data-nav="video">Video lernen öffnen</button></p>` : ''}`;
  }

  _videoCard(s) {
    const { academy } = this.ctx;
    const open = this._open.has(s.id);
    const claims = academy.claimsOf(s.id);
    const running = academy.active === s.id || academy.queue.some((q) => q.id === s.id);
    const c = s.counts || {};
    return `
      <article class="academy-card academy-card--${esc(s.status)}">
        <button type="button" class="version-head" data-action="toggle" data-id="${esc(s.id)}" aria-expanded="${open}">
          <strong>${esc(s.title || `YouTube-Video ${s.videoId}`)}</strong>
          <span class="kind kind--${STATUS_TONE[s.status] || 'assume'}">${esc(VIDEO_STATUS[s.status])}</span>
        </button>
        <p class="meta">${s.channel ? `${esc(s.channel)} · ` : ''}hinzugefügt ${esc(fmtDateTime(s.addedAt))}${s.lastCheckedAt ? ` · zuletzt analysiert ${esc(fmtDateTime(s.lastCheckedAt))}` : ''}</p>
        ${c.claims ? `<p class="meta">${c.claims} Aussagen: ${c.confirmed || 0} bestätigt · ${c.contradicted || 0} widerlegt · ${c.partial || 0} teilweise · ${c.unverifiable || 0} nicht überprüfbar</p>` : ''}
        ${s.error ? `<p class="text-warn">${esc(s.error)}</p>` : ''}
        <ol class="step-list">${STEP_ORDER.map((k) => `<li class="step-${esc(s.steps[k].state)}"><span class="step-mark" aria-hidden="true">${STEP_MARK[s.steps[k].state]}</span><span><b>${esc(STEP_TEXT[k])}</b>${s.steps[k].note ? `<small>${esc(s.steps[k].note)}</small>` : ''}</span></li>`).join('')}</ol>
        ${open ? `
          ${s.topics.length ? `<p class="meta">Themen: ${s.topics.map((t) => esc(TOPICS[t])).join(', ')}</p>` : ''}
          ${claims.length ? `<ul class="claim-mini">${claims.map((cl) => `<li><span class="kind kind--${CLAIM_TONE[cl.status]}">${esc(CLAIM_STATUS[cl.status])}</span> ${esc(cl.text)}</li>`).join('')}</ul>` : ''}` : ''}
        <div class="btn-row">
          <a class="btn btn--secondary" href="${esc(videoLink(s.videoId))}" target="_blank" rel="noopener noreferrer">Video öffnen</a>
          <button type="button" class="btn btn--secondary" data-action="reanalyze" data-id="${esc(s.id)}" ${running ? 'disabled' : ''}>${running ? 'Analyse läuft …' : 'Analyse wiederholen'}</button>
          <button type="button" class="btn btn--ghost" data-action="transcript" data-id="${esc(s.id)}" ${running ? 'disabled' : ''}>Transkript einfügen</button>
          <button type="button" class="btn btn--ghost" data-action="toggle" data-id="${esc(s.id)}">${open ? 'Weniger' : `Erkannte Strategien (${claims.length})`}</button>
          <button type="button" class="btn ${this._confirm === `v:${s.id}` ? 'btn--danger' : 'btn--ghost'}" data-action="delete-video" data-id="${esc(s.id)}" ${running ? 'disabled' : ''}>${this._confirm === `v:${s.id}` ? 'Wirklich löschen?' : 'Löschen'}</button>
        </div>
      </article>`;
  }

  // --- B: Wissensbibliothek -------------------------------------------------
  _knowledgeHtml() {
    const { academy } = this.ctx;
    const conflicts = academy.conflicts();
    const q = this._q.trim().toLowerCase();
    let list = academy.claims;
    if (this._filter === 'conflict') list = list.filter((c) => conflicts.byClaim.has(c.id));
    else if (this._filter === 'contradicted') list = list.filter((c) => c.flagged || c.status === 'contradicted');
    else if (this._filter === 'unchecked') list = list.filter((c) => c.status === 'unchecked' || c.status === 'partial');
    else if (this._filter !== 'all') list = list.filter((c) => c.status === this._filter);
    if (q) list = list.filter((c) => [c.text, ...(c.verification ? c.verification.details : []), ...c.sources.map((s) => s.excerpt)].join(' ').toLowerCase().includes(q));
    const n = (f) => {
      if (f === 'all') return academy.claims.length;
      if (f === 'conflict') return academy.claims.filter((c) => conflicts.byClaim.has(c.id)).length;
      if (f === 'contradicted') return academy.claims.filter((c) => c.flagged || c.status === 'contradicted').length;
      if (f === 'unchecked') return academy.claims.filter((c) => c.status === 'unchecked' || c.status === 'partial').length;
      return academy.claims.filter((c) => c.status === f).length;
    };
    return `
      <div class="tab-scroll">${FILTERS.map(([k, label]) => `<button type="button" class="chip ${this._filter === k ? 'is-active' : ''}" data-action="filter" data-filter="${k}">${esc(label)} <b>${n(k)}</b></button>`).join('')}</div>
      <p class="hint">Bestätigt heisst: mathematisch nachgerechnet (Rechenmodell und exakte Rechnung mit endlichem Schuh). Ungeprüfte, widerlegte und nur teilweise bestätigte Aussagen verändern die Strategie nie.</p>
      ${academy.claims.length ? `<button type="button" class="btn btn--secondary" data-action="recheck">Alle erneut prüfen (aktuelle Tischregeln)</button>` : ''}
      ${list.length ? `<div class="knowledge-list">${list.map((c) => this._claimCard(c, conflicts)).join('')}</div>` : `<p class="empty-note">${academy.claims.length ? 'Keine Einträge für diesen Filter.' : 'Noch kein Wissen aus Videos. Analysierte Videos füllen diese Bibliothek.'}</p>`}`;
  }

  _claimCard(c, conflicts) {
    const v = c.verification;
    const others = conflicts.byClaim.get(c.id);
    const tone = c.status === 'confirmed' ? 'verified' : 'hypothesis';
    return `
      <article class="knowledge-card knowledge-card--${tone}">
        <div class="knowledge-head">
          <span class="kind kind--${CLAIM_TONE[c.status]}">${esc(v ? VERDICT[v.verdict] : 'Ungeprüft')}</span>
          ${c.flagged ? '<span class="kind kind--warn">als fehlerhaft markiert</span>' : ''}
        </div>
        <p><b>${esc(c.text)}</b></p>
        ${others ? `<p class="text-warn">Widerspricht ${others.size} ${others.size === 1 ? 'anderer Aussage' : 'anderen Aussagen'}: ${[...others].map((id) => { const o = this.ctx.academy.getClaim(id); return o ? esc(o.text) : ''; }).filter(Boolean).join(' · ')}</p>` : ''}
        ${v ? `<ul class="plain-list">${v.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul><p class="meta">${esc(v.method)} Geprüft ${esc(fmtDateTime(v.at))} · Regeln: ${esc(v.rulesText || '')}</p>` : ''}
        <p class="meta">Quellen (${c.sources.length}): ${c.sources.map((s) => {
          const link = s.videoId ? videoLink(s.videoId, s.at) : null;
          return link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(this._sourceName(s.sourceId))}${s.at != null ? ` (${fmtTime(s.at)})` : ''}</a>` : esc(s.sourceId);
        }).join(', ')}</p>
        ${c.sources[0] && c.sources[0].excerpt ? `<p class="hint">„${esc(c.sources[0].excerpt)}“</p>` : ''}
        <div class="btn-row">
          <button type="button" class="btn btn--ghost btn--compact" data-action="recheck" data-id="${esc(c.id)}">Erneut prüfen</button>
          <button type="button" class="btn btn--ghost btn--compact" data-action="flag" data-id="${esc(c.id)}" data-on="${c.flagged ? '0' : '1'}">${c.flagged ? 'Markierung entfernen' : 'Als fehlerhaft markieren'}</button>
          <button type="button" class="btn ${this._confirm === `c:${c.id}` ? 'btn--danger' : 'btn--ghost'} btn--compact" data-action="delete-claim" data-id="${esc(c.id)}">${this._confirm === `c:${c.id}` ? 'Wirklich löschen?' : 'Löschen'}</button>
        </div>
      </article>`;
  }

  _sourceName(id) {
    const s = this.ctx.academy.getSource(id);
    return s ? (s.title || `Video ${s.videoId}`) : 'gelöschtes Video';
  }

  // --- C: Lernstatistik -----------------------------------------------------
  _statsHtml() {
    const { academy, archive, simulations } = this.ctx;
    const s = academy.stats();
    const rounds = archive ? archive.rounds : [];
    const mistakes = recurringMistakes(rounds);
    const prog = learningProgress(rounds);
    const sims = simulations ? simulations.list.slice(0, 3) : [];
    const topics = Object.entries(s.topics).sort((a, b) => b[1] - a[1]);
    return `
      <div class="stat-grid">
        <div class="stat"><b>${s.videos}</b><span>Videos in der Bibliothek</span></div>
        <div class="stat"><b>${s.analyzed}</b><span>analysierte Videos</span></div>
        <div class="stat stat--ok"><b>${s.confirmed}</b><span>bestätigte Strategien</span></div>
        <div class="stat stat--warn"><b>${s.unchecked + s.partial}</b><span>ungeprüfte / teilweise geprüfte Erkenntnisse</span></div>
        <div class="stat stat--warn"><b>${s.contradicted}</b><span>widerlegte Aussagen</span></div>
        <div class="stat"><b>${s.failed}</b><span>fehlgeschlagene Analysen</span></div>
        <div class="stat"><b>${s.noTranscript}</b><span>Videos ohne Transkript</span></div>
        <div class="stat"><b>${s.conflicts}</b><span>Widersprüche zwischen Quellen</span></div>
      </div>
      <p class="hint">Alle Zahlen werden aus deinen gespeicherten Daten berechnet.</p>
      ${topics.length ? `<section class="group"><h2 class="group-title">THEMEN DER VIDEOS</h2><ul class="ev-list">${topics.map(([t, n]) => `<li><span>${esc(TOPICS[t])}</span><b>${n}</b></li>`).join('')}</ul></section>` : ''}
      <section class="group">
        <h2 class="group-title">HÄUFIGE STRATEGIEFEHLER (SPIELARCHIV)</h2>
        ${mistakes.length ? `<ul class="ev-list">${mistakes.slice(0, 8).map((m) => `<li><span>${esc(m.text)}</span><b>${m.count}×</b></li>`).join('')}</ul><p class="hint">Gezählt werden eigene Entscheidungen, die im Rechenmodell mehr als 0,1 % des Einsatzes kosten – mindestens zweimal in derselben Situation.</p>` : `<p class="hint">${rounds.length ? 'Keine wiederkehrenden Fehler im Spielarchiv gefunden.' : 'Noch keine Runden im Spielarchiv.'}</p>`}
      </section>
      <section class="group">
        <h2 class="group-title">LERNFORTSCHRITT</h2>
        ${prog.blocks.length ? `<ul class="ev-list">${prog.blocks.slice(-8).map((b) => `<li><span>Ab ${esc(fmtDateTime(b.from))}: ${b.decisions} Entscheidungen</span><b>${b.mistakes} Fehler (${rate(b.rate)})</b></li>`).join('')}</ul>
          <p class="hint">${prog.trend == null ? `Für einen Trend braucht es mindestens zwei Blöcke à ${prog.blockSize} Entscheidungen.` : (prog.trend < 0 ? `Fehlerquote gesunken (${rate(prog.trend, 1)} vom ersten zum letzten Block).` : (prog.trend > 0 ? `Fehlerquote gestiegen (+${rate(prog.trend, 1)} vom ersten zum letzten Block).` : 'Fehlerquote unverändert.'))} Kleine Stichproben schwanken stark.</p>` : '<p class="hint">Noch keine ausgewerteten Entscheidungen im Spielarchiv.</p>'}
      </section>
      <section class="group">
        <h2 class="group-title">SIMULATIONEN</h2>
        ${sims.length ? `<ul class="ev-list">${sims.map((x) => `<li><span>${esc(fmtDateTime(x.at))}: ${x.results.map((r) => `${esc(r.name)} ${pctx(r.ev, 2)}`).join(', ')}</span><b>${x.rounds.toLocaleString('de-CH')} R.</b></li>`).join('')}</ul><p class="hint">Simulationswerte mit statistischer Unsicherheit – keine Vorhersage künftiger Gewinne.</p>` : '<p class="hint">Noch keine gespeicherten Simulationen (YUMEKO › Strategie-Labor).</p>'}
      </section>
      <section class="group">
        <h2 class="group-title">GEMELDETE FEHLERKENNUNGEN (KAMERA)</h2>
        ${academy.feedback.length ? `<ul class="history-list">${academy.feedback.slice(0, 20).map((f) => `<li><b>${esc(fmtDateTime(f.at))}</b><span>Dealer ${esc(f.dealer.map((c) => c.rank).join(' ') || '–')} · Hand ${esc(f.hands.map((h) => h.map((c) => c.rank).join(' ')).join(' | ') || '–')}${f.uncertain ? ' · als unsicher markiert' : ''}</span><button type="button" class="link-btn" data-action="delete-feedback" data-id="${esc(f.id)}">Meldung löschen</button></li>`).join('')}</ul>` : '<p class="hint">Keine Meldungen. In der Hauptansicht kann eine falsche Kartenerkennung mit „Erkennung melden“ festgehalten werden.</p>'}
      </section>`;
  }

  // --- D: Strategie-Engine ---------------------------------------------------
  _calcHtml() {
    const c = this._calc;
    const table = normalizeRules(this.ctx.settings.get('rules'));
    const sel = (name, value, opts, empty = false) => `<select name="calc-${name}">${empty ? `<option value="" ${!value ? 'selected' : ''}>–</option>` : ''}${opts.map((o) => `<option value="${o}" ${o === value ? 'selected' : ''}>${o === 'A' ? 'Ass' : o}</option>`).join('')}</select>`;
    const r = c.result;
    return `
      <p class="lead">Exakte Erwartungswerte für eine Spielsituation – mit endlichem Schuh, bei dem deine Karten und die Dealerkarte entfernt sind.</p>
      <div class="form-grid">
        <label class="field"><span>Karte 1</span>${sel('p1', c.p1, CARD_OPTS)}</label>
        <label class="field"><span>Karte 2</span>${sel('p2', c.p2, CARD_OPTS)}</label>
        <label class="field"><span>Karte 3 (optional)</span>${sel('p3', c.p3, CARD_OPTS, true)}</label>
        <label class="field"><span>Dealerkarte</span>${sel('up', c.up, CARD_OPTS)}</label>
        <label class="field"><span>Dealer schaut nach Blackjack (Peek)</span><select name="calc-peek"><option value="ja" ${c.peek ? 'selected' : ''}>Ja</option><option value="nein" ${!c.peek ? 'selected' : ''}>Nein (europäisch)</option></select></label>
        <label class="field"><span>Aufgeben (Surrender)</span><select name="calc-surrender"><option value="keine" ${c.surrender === 'keine' ? 'selected' : ''}>Nicht erlaubt</option><option value="spaet" ${c.surrender === 'spaet' ? 'selected' : ''}>Spätes Aufgeben erlaubt</option></select></label>
        <label class="field"><span>Verdoppeln erlaubt auf</span><select name="calc-doubleOn"><option value="alle" ${c.doubleOn === 'alle' ? 'selected' : ''}>alle Startkarten</option><option value="9-11" ${c.doubleOn === '9-11' ? 'selected' : ''}>nur 9–11</option><option value="10-11" ${c.doubleOn === '10-11' ? 'selected' : ''}>nur 10–11</option></select></label>
      </div>
      <p class="hint">Weitere Regeln aus den Einstellungen: ${esc(exactRulesText({ ...table, peek: c.peek, surrender: c.surrender, doubleOn: c.doubleOn }))}. Diese Rechnung ändert die Live-Empfehlung nicht (dort gibt es weiterhin kein Aufgeben).</p>
      <button type="button" class="btn btn--yumeko" data-action="calc" ${c.busy ? 'disabled' : ''}>${c.busy ? 'Berechnung läuft …' : 'Berechnen'}</button>
      ${r ? this._calcResultHtml(r) : ''}
      ${deckChoice(this.ctx.settings.get('rules')) === 'unbekannt' ? '<p class="hint">Deckanzahl unbekannt: zusätzlich werden 1, 2, 4, 6 und 8 Decks gerechnet und verglichen.</p>' : ''}`;
  }

  _calcResultHtml(r) {
    if (!r.ok) return `<p class="notice notice--warn">${ICONS.warning}<span>${esc(r.reason)}</span></p>`;
    const rows = Object.entries(r.evs).sort((a, b) => b[1] - a[1]);
    return `
      <div class="analysis-block">
        <strong>${r.best ? `Beste Aktion: ${esc(ACT_LABEL[r.best])}` : 'Blackjack'} <span class="kind kind--calc">berechnet</span></strong>
        ${rows.length ? `<ul class="ev-list">${rows.map(([a, ev]) => `<li><span>${esc(ACT_LABEL[a])}${a === r.best ? ' ✓' : ''}</span><b>${pctx(ev, 2)}</b></li>`).join('')}</ul>` : ''}
        <ul class="plain-list">${r.explanation.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        ${r.uncertainty.length ? `<p class="text-warn"><b>Unsicherheit:</b></p><ul class="plain-list">${r.uncertainty.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${r.deckComparison ? `<p class="meta">Vergleich Deckanzahl: ${r.deckComparison.rows.map((x) => `${x.decks} D → ${x.best ? esc(ACT_LABEL[x.best]) : '–'}`).join(' · ')}</p>` : ''}
        <p class="hint">Erwartungswert in Prozent des Einsatzes. Annahmen: ${esc(EXACT_ASSUMPTIONS.join(' '))}</p>
      </div>`;
  }

  // --- E: Daten & Server ------------------------------------------------------
  _dataHtml() {
    const { academy } = this.ctx;
    const cfg = loadServerConfig();
    return `
      <section class="group">
        <h2 class="group-title">LOKALE WISSENSDATENBANK</h2>
        <div class="list">
          <div class="row"><span>Speicherort</span><span class="row-value">${academy.kind === 'indexeddb' ? `IndexedDB (Version ${DB_VERSION})` : (academy.kind === 'local' ? 'localStorage (Ausweichlösung, wenig Platz)' : esc(academy.kind || '–'))}</span></div>
          <div class="row"><span>Einträge</span><span class="row-value">${academy.sources.length} Videos · ${academy.claims.length} Erkenntnisse · ${academy.feedback.length} Meldungen</span></div>
          <div class="row"><span>Speicherbelegung (Schätzung des Browsers)</span><span class="row-value" data-slot="estimate">…</span></div>
        </div>
        ${academy.invalid ? `<p class="text-warn">${academy.invalid} unlesbare Einträge wurden nicht geladen (sie bleiben unverändert gespeichert).</p>` : ''}
        <p class="group-help">Alles bleibt auf diesem Gerät. Es gibt keine automatische Cloud-Synchronisierung. Safari kann Website-Daten löschen – deshalb regelmässig exportieren.</p>
        <div class="btn-row">
          <button type="button" class="btn btn--secondary" data-action="export">Wissensdatenbank exportieren</button>
          <button type="button" class="btn btn--secondary" data-action="import">Importieren</button>
          <button type="button" class="btn ${this._confirm === 'reset' ? 'btn--danger' : 'btn--ghost'}" data-action="reset">${this._confirm === 'reset' ? 'Wirklich alles zurücksetzen? Nochmals tippen' : 'Academy zurücksetzen'}</button>
        </div>
        <p class="hint">Zurücksetzen löscht nur Academy-Videos, -Erkenntnisse und Erkennungsmeldungen. Spielarchiv, Profile, Echtgeld-Protokoll und übriges YUMEKO-Wissen bleiben erhalten. Die vollständige Sicherung aller Daten gibt es im Spielarchiv.</p>
      </section>

      <section class="group">
        <h2 class="group-title">YUMEKO-SERVER (OPTIONAL)</h2>
        <p class="group-help">Für Transkripte und Videoinformationen braucht es einen eigenen Server (Anleitung: server/README.md im Projekt). API-Schlüssel liegen nur dort, nie in der App. Nichts Kostenpflichtiges wird aktiviert.</p>
        <label class="field"><span>HTTPS-Adresse deines Servers</span><input type="url" name="server" value="${esc(cfg.endpoint)}" placeholder="https://dein-server.example/yumeko" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <button type="button" class="btn btn--secondary" data-action="server-save">${cfg.endpoint ? 'Adresse speichern / leeren zum Entfernen' : 'Server speichern'}</button>
        <div class="analysis-block">
          <strong>Externe Übertragungen</strong>
          <ul class="plain-list">
            <li>${cfg.endpoint ? `Aktiv seit ${esc(fmtDateTime(cfg.enabledAt))}: ` : 'Derzeit keine. Wenn eingerichtet: '}pro neuem Link wird nur die Video-ID an deinen Server gesendet.</li>
            <li>Nie gesendet: Spielrunden, Echtgeld-Daten, Kamerabilder, angelernte Karten, Einstellungen.</li>
            <li>„Video öffnen“ öffnet YouTube in einem neuen Fenster (dann gelten die Regeln von YouTube).</li>
            <li>Mit eingerichtetem Server arbeitet die Academy nicht vollständig offline. Ohne Server bleibt alles auf dem Gerät.</li>
          </ul>
        </div>
      </section>`;
  }

  async _fillEstimate() {
    const el = this.el.querySelector('[data-slot="estimate"]');
    const e = await storageEstimate();
    if (!el || !el.isConnected) return;
    el.textContent = e ? `${(e.usage / 1048576).toFixed(1).replace('.', ',')} MB von ca. ${(e.quota / 1048576).toFixed(0)} MB` : 'nicht verfügbar';
  }
}
