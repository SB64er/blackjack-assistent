// YUMEKO-Chat: Fragen an YUMEKO – Antworten ausschliesslich aus gespeicherten
// Daten und Berechnungen (keine Sprachmodell-Anbindung).
import { View, subHeader } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { answer, CHAT_EXAMPLES } from '../yumeko/chat.js';
import { activeStrategyEVCached, strategyAdvice } from '../yumeko/decision.js';
import { load, save } from '../core/store.js';

const KEY = 'yumekoChat';
const MAX = 40;

export class ChatView extends View {
  mount() {
    this.el.className = 'screen screen-sub';
    let stored = [];
    try { stored = load(KEY, []); } catch { stored = []; }
    this.messages = Array.isArray(stored) ? stored.filter((m) => m && typeof m.text === 'string').slice(-MAX) : [];
    this.el.innerHTML = `
      ${subHeader('YUMEKO – Chat', 'yumeko')}
      <div class="sub-content">
        <p class="notice notice--info">${ICONS.warning}<span>Keine Sprachmodell-Anbindung: YUMEKO beantwortet Fragen aus deinem Archiv, Wissensspeicher, Echtgeld-Protokoll, Simulationen und dem Rechenmodell. Fehlen Daten, sagt sie es.</span></p>
        <div class="chat-log" data-slot="log" aria-live="polite"></div>
        <div class="tab-scroll">${CHAT_EXAMPLES.map((q) => `<button type="button" class="chip" data-action="ask" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
        <form class="chat-form" data-ref="form">
          <input name="q" type="text" placeholder="Frag YUMEKO …" autocomplete="off" maxlength="300">
          <button type="submit" class="btn btn--yumeko">Fragen</button>
        </form>
        <button type="button" class="btn btn--ghost" data-action="clear">Verlauf leeren</button>
      </div>`;
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      if (b.dataset.action === 'ask') this.ask(b.dataset.q);
      if (b.dataset.action === 'clear') { this.messages = []; this._persist(); this.renderLog(); }
    });
    this.el.querySelector('[data-ref="form"]').addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = this.el.querySelector('input[name="q"]');
      const q = inp.value.trim();
      if (q) { this.ask(q); inp.value = ''; }
    });
    this.renderLog();
  }

  _persist() {
    try { save(KEY, this.messages.slice(-MAX)); } catch { /* egal */ }
  }

  /** Aktueller Datenstand für die Antwort (nur echte Daten). */
  snapshot() {
    const { settings, archive, knowledge, profiles, yumeko, bankroll, simulations, ui } = this.ctx;
    const rules = settings.get('rules');
    const st = profiles.strategyFor();
    const p = profiles.active;
    let lastAdvice = null;
    if (ui && ui.lastSituation) {
      const s = ui.lastSituation;
      lastAdvice = strategyAdvice({ cards: s.cards, up: s.up, rules, overrides: st.overrides, strategyRules: st.strategyRules, afterSplit: s.afterSplit, profileName: p.name, version: p.type === 'yumeko' ? p.data.strategyVersion : null });
    }
    return {
      now: new Date(),
      rules,
      rounds: archive.rounds,
      knowledge: { items: knowledge.items, videos: knowledge.videos, versions: knowledge.versions, meta: knowledge.meta },
      profile: { name: p.name, type: p.type, version: p.data && p.data.strategyVersion },
      yumekoStatus: yumeko.status(),
      bankroll: bankroll ? { config: bankroll.config, stats: bankroll.stats() } : null,
      strategy: activeStrategyEVCached({ rules, overrides: st.overrides, strategyRules: st.strategyRules }),
      profileEVs: profiles.list().map((x) => { const s2 = profiles.strategyFor(x); return { name: x.name, ev: activeStrategyEVCached({ rules, overrides: s2.overrides, strategyRules: s2.strategyRules }).ev }; }),
      simulations: simulations ? simulations.list : [],
      lastAdvice
    };
  }

  ask(q) {
    this.messages.push({ from: 'user', text: q, at: new Date().toISOString() });
    let res;
    try {
      res = answer(q, this.snapshot());
    } catch (err) {
      res = { paragraphs: [`Fehler beim Berechnen der Antwort: ${err.message}`], basis: [] };
    }
    this.messages.push({ from: 'yumeko', text: res.paragraphs.join('\n'), basis: res.basis, at: new Date().toISOString() });
    this.messages = this.messages.slice(-MAX);
    this._persist();
    this.renderLog();
  }

  renderLog() {
    const log = this.el.querySelector('[data-slot="log"]');
    log.innerHTML = this.messages.length
      ? this.messages.map((m) => `
        <div class="chat-msg chat-msg--${m.from === 'user' ? 'user' : 'yumeko'}">
          ${m.from === 'user' ? '' : '<span class="chat-who">◆ YUMEKO</span>'}
          ${m.text.split('\n').map((l) => `<p>${esc(l)}</p>`).join('')}
          ${m.basis && m.basis.length ? `<small class="chat-basis">Grundlage: ${esc(m.basis.join(' · '))}</small>` : ''}
        </div>`).join('')
      : '<p class="empty-note">Stell eine Frage oder tippe auf ein Beispiel.</p>';
    const last = log.lastElementChild;
    if (last && last.scrollIntoView && this.messages.length) last.scrollIntoView({ block: 'nearest' });
  }
}
