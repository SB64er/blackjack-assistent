// Lernzentrum › AI Table (ab 0.11.0). Design: AITable.dc.html (iPad quer 1180×820).
// Virtueller Trainingstisch mit Sim-Geld (kein Echtgeld). Vorerst leer: kein Training,
// keine simulierten KI-Entscheidungen. Daten kommen aus tableState().
import { View } from './view-base.js';
import { esc } from '../core/dom.js';
import { lzHeader, segmented, bar, emptyBox, DASH } from './lz-common.js';
import { tableState, YUMEKO_READY, NOT_READY_TEXT } from '../lernzentrum/bereiche.js';
import { percentText } from '../lernzentrum/lernzentrum.js';

const PLAY = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>';
const PAUSE = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const STOP = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
const CHEV = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6B7280" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

const off = YUMEKO_READY ? '' : `disabled title="${esc(NOT_READY_TEXT)}"`;
const show = (v) => (v == null || v === '' ? DASH : String(v));

export class TableView extends View {
  mount() {
    this.el.className = 'screen screen-lz lzs lzs-table';
    this.render();
  }

  render() {
    const t = tableState();
    const s = t.stats;
    const slots = (cards, n) => (cards.length
      ? cards.map((c) => `<span class="lzs-tcard">${esc(c)}</span>`).join('')
      : Array.from({ length: n }, () => '<span class="lzs-tcard lzs-tcard--empty" aria-hidden="true"></span>').join(''));
    const stats = [
      ['Hände', s.hands, '#F2F4F7'], ['Wins', s.win, '#6EE7B7'], ['Lose', s.loss, '#FCA5A5'],
      ['Bust', s.bust, '#FDBA74'], ['Gleichstand', s.push, '#93C5FD'], ['Gewinnrate', percentText(s.win, s.hands), '#F2F4F7']
    ];
    const runText = t.running === 'running' ? 'Training läuft' : (t.running === 'paused' ? 'Pausiert' : 'Kein Training');
    const runDot = t.running === 'running' ? '#34D399' : (t.running === 'paused' ? '#FACC15' : '#6B7280');

    this.el.innerHTML = `
      <div class="lz">
        ${lzHeader('table', 'AI Table', 'Training mit Sim-Geld · kein Echtgeld')}
        <div class="lzs-body lzs-row lzs-gap16">
          <div class="lzs-col lzs-grow">
            <section class="lzs-panel lzs-felt" aria-label="Blackjack-Tisch">
              <div class="lzs-seat">
                <span class="lzs-seat-head"><span class="lzs-cap lzs-cap--wide">AI DEALER</span><span class="lzs-pill">${show(t.dealer.total)}</span></span>
                <div class="lzs-tcards">${slots(t.dealer.cards, 2)}</div>
              </div>
              <span class="lzs-result">${t.result ? esc(t.result.text) : 'Noch kein Training gespielt'}</span>
              <div class="lzs-seat">
                <div class="lzs-tcards">${slots(t.player.cards, 2)}</div>
                <span class="lzs-seat-head"><span class="lzs-cap lzs-cap--wide">YUMEKO</span><span class="lzs-pill lzs-pill--green">${show(t.player.label)}</span></span>
              </div>
              <div class="lzs-felt-foot">
                <div class="lzs-money">
                  <span><span class="lzs-muted lzs-small">Credit</span><b>${show(t.credit)}</b></span>
                  <span><span class="lzs-muted lzs-small">Einsatz</span><b>${show(t.bet)}</b></span>
                </div>
                <div class="lzs-actions" role="group" aria-label="Spielzüge von Yumeko">
                  ${['Hit', 'Stand', 'Double', 'Split'].map((a) => `<button type="button" class="lzs-act" ${off}>${a}</button>`).join('')}
                </div>
              </div>
            </section>
            <section class="lzs-panel lzs-controls" aria-label="Trainingssteuerung">
              <div class="lzs-ctrl-row">
                <div class="lzs-ctrl-btns">
                  <button type="button" class="lzs-ctrl lzs-ctrl--start" ${off}>${PLAY}Start</button>
                  <button type="button" class="lzs-ctrl" ${off}>${PAUSE}Pause</button>
                  <button type="button" class="lzs-ctrl" ${off}>${STOP}Stop</button>
                  <span class="lzs-run"><span class="lzs-dot" style="background:${runDot}"></span>${runText}</span>
                </div>
                <div class="lzs-tempo"><span class="lzs-muted">Tempo</span>${segmented(['1×', '5×', '20×', 'Max'].map((x) => ({ id: x, label: x })), null, 'speed', { label: 'Trainingsgeschwindigkeit', disabled: !YUMEKO_READY })}</div>
              </div>
              <div class="lzs-settings">
                ${[['Anzahl Hände', t.settings.hands], ['Kartendecks', t.settings.decks], ['Startkapital', t.settings.capital], ['Regeln', t.settings.rules]]
                  .map(([l, v]) => `<button type="button" class="lzs-setting" ${off}><span class="lzs-setting-text"><span class="lzs-muted lzs-small">${l}</span><span class="lzs-setting-val">${esc(show(v))}</span></span>${CHEV}</button>`).join('')}
              </div>
            </section>
          </div>
          <div class="lzs-col lzs-side-wide">
            <section class="lzs-panel lzs-stack14" aria-label="Statistik">
              <span class="lzs-cap">STATISTIK</span>
              <div class="lzs-stat6">${stats.map(([l, v, c]) => `<div class="lzs-stack2"><span class="lzs-muted lzs-small">${l}</span><span class="lzs-num" style="color:${c}">${esc(v)}</span></div>`).join('')}</div>
              <div class="lzs-spark-wrap">
                <span class="lzs-spark-head"><span>Sim-Geld-Entwicklung</span><span>${t.bankroll.length ? `${t.bankroll[0]} → <b>${t.bankroll[t.bankroll.length - 1]}</b>` : `${DASH} → ${DASH}`}</span></span>
                ${sparkline(t.bankroll)}
              </div>
            </section>
            <section class="lzs-panel lzs-grow lzs-stack12" aria-label="KI-Analyse">
              <div class="lzs-spread">
                <span class="lzs-cap">KI-ANALYSE</span>
                <button type="button" class="lzs-brain-toggle" aria-pressed="${t.saveToBrain}" ${off}><span class="lzs-dot"></span>${t.saveToBrain ? 'Speichert im Brain' : 'Brain-Speicherung aus'}</button>
              </div>
              <div class="lzs-box lzs-stack6 lzs-decision">
                <span class="lzs-spread lzs-muted lzs-small"><span>Aktuelle Entscheidung</span><span>${t.decision ? `Hand ${esc(t.decision.hand)}` : DASH}</span></span>
                <span class="lzs-val lzs-val--sm">${t.decision ? esc(t.decision.title) : DASH}</span>
                <span class="lzs-text-sm">${t.decision ? esc(t.decision.reason) : 'Noch keine Entscheidung. Yumeko spielt erst, wenn sie entwickelt ist.'}</span>
              </div>
              ${t.log.length ? `<div class="lzs-stack6">${t.log.map((l) => `<div class="lzs-log"><span class="lzs-mark ${l.ok ? 'is-ok' : 'is-bad'}">${l.ok ? '✓' : '✗'}</span><span class="lzs-grow">${esc(l.text)}</span><span class="lzs-muted">${esc(l.hand)}</span></div>`).join('')}</div>`
                : emptyBox('Noch keine Spielzüge', 'Hier erscheinen später Yumekos Entscheidungen.', 'lzs-empty--sm')}
              <div class="lzs-stack6 lzs-mt-auto">
                <span class="lzs-spread lzs-text-sm"><span>Lernfortschritt</span><span class="lzs-muted">${t.errors} Fehler · ${t.progress} %</span></span>
                ${bar(t.progress, '#34D399')}
              </div>
            </section>
          </div>
        </div>
      </div>`;
  }
}

function sparkline(vals) {
  const W = 336, H = 72;
  if (!vals || vals.length < 2) {
    return `<svg class="lzs-spark" role="img" aria-label="Noch kein Sim-Geld-Verlauf" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#2A2F37" stroke-dasharray="3 4"/></svg>`;
  }
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const y = (v) => (H - 4 - (v - min) / span * (H - 8)).toFixed(1);
  const pts = vals.map((v, i) => `${(i * W / (vals.length - 1)).toFixed(1)},${y(v)}`).join(' ');
  return `<svg class="lzs-spark" role="img" aria-label="Sim-Geld-Verlauf" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="0" y1="${y(vals[0])}" x2="${W}" y2="${y(vals[0])}" stroke="#2A2F37" stroke-dasharray="3 4"/><polyline points="${pts}" fill="none" stroke="#34D399" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
