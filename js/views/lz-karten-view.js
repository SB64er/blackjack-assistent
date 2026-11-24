// Lernzentrum › Karten (ab 0.11.0). Design: Karten.dc.html (iPad quer 1180×820).
// Zeigt feste Blackjack-Regeln. Lernstände kommen aus kartenProgress() und sind vorerst 0.
import { View } from './view-base.js';
import { esc } from '../core/dom.js';
import { lzHeader, segmented, cardFace, bar, bindActions, DASH } from './lz-common.js';
import { KARTEN_TABS, LEVELS, kartenProgress, YUMEKO_READY, NOT_READY_TEXT } from '../lernzentrum/bereiche.js';
import { RANKS, UPCARDS, DECK_OPTIONS, cardInfo, handGroups, handInfo, MATRIX_ROWS, HAND_TYPES, deckStats } from '../lernzentrum/karten-wissen.js';

const BLUE = '#60A5FA';
const LEVEL_COLORS = ['#4B5563', '#FB923C', '#FB923C', '#34D399'];
const LEVEL_TEXT = ['Neu', 'In Arbeit', 'In Arbeit', 'Sicher'];
// Auswahl bleibt erhalten, solange die App offen ist (kein Speichern nötig).
const memo = { tab: 'cards', decks: null, card: 'A', filter: 'all', hand: 'S18', up: '6', cell: 'h16:10' };

export class KartenView extends View {
  mount() {
    this.el.className = 'screen screen-lz lzs lzs-karten';
    if (memo.decks == null) {
      const r = this.ctx.settings.get('rules') || {};
      memo.decks = DECK_OPTIONS.includes(r.decks) && !r.decksUnknown ? r.decks : 6;
    }
    bindActions(this, (a, id) => {
      if (a === 'decks') memo.decks = Number(id);
      else if (a in memo) memo[a] = id;
      this.render();
    });
    this.render();
  }

  render() {
    const p = kartenProgress();
    const decks = memo.decks;
    const cur = KARTEN_TABS.find((t) => t.id === memo.tab) || KARTEN_TABS[0];
    const right = `<span class="lzs-muted">Kartendecks</span>${segmented(DECK_OPTIONS.map((n) => ({ id: String(n), label: String(n) })), String(decks), 'decks', { label: 'Anzahl Kartendecks', cls: 'lzs-seg--lg' })}`;
    this.el.innerHTML = `
      <div class="lz">
        ${lzHeader('karten', 'Karten', 'Lernzentrum · Karten und Spielsituationen', right)}
        <div class="lzs-body lzs-row">
          <nav class="lzs-side lzs-tabs" aria-label="Unterbereiche">
            ${KARTEN_TABS.map((t) => `
              <button type="button" class="lzs-tab" data-lzs="tab" data-id="${t.id}" aria-current="${t.id === cur.id ? 'page' : 'false'}">
                <span class="lzs-tab-line"><span class="lzs-tab-label">${esc(t.label)}</span><span class="lzs-tab-pct">${p.tabs[t.id]}%</span></span>
                ${bar(p.tabs[t.id], BLUE)}
              </button>`).join('')}
            <div class="lzs-box lzs-progress">
              <span class="lzs-cap">LERNSTAND KARTEN</span>
              <span class="lzs-big-line"><span class="lzs-big">${p.total} %</span><span class="lzs-muted">gesamt</span></span>
              <button type="button" class="lzs-btn" disabled title="${esc(NOT_READY_TEXT)}">Lernen starten</button>
            </div>
          </nav>
          <main class="lzs-panel lzs-main">
            <div class="lzs-main-head">
              <div class="lzs-main-title"><h2 class="lzs-h2">${esc(cur.label)}</h2><span class="lzs-muted lzs-sub">${esc(cur.sub)}</span></div>
              <span class="lzs-muted lzs-nowrap">${decks} ${decks === 1 ? 'Deck' : 'Decks'} · ${52 * decks} Karten</span>
            </div>
            ${this[`_${cur.id}`](p, decks)}
          </main>
        </div>
      </div>`;
  }

  _cards(p, decks) {
    const sel = cardInfo(memo.card, decks);
    const lv = p.cards[memo.card] || 0;
    return `
      <div class="lzs-cardgrid">
        ${RANKS.map((r) => {
          const c = cardInfo(r, decks);
          return `<button type="button" class="lzs-bigcard" data-lzs="card" data-id="${r}" aria-pressed="${r === memo.card}" aria-label="${esc(c.name)}">
            <span class="lzs-bigcard-rank">${esc(r)}</span><span class="lzs-bigcard-val">Wert ${esc(c.short)}</span>
            <span class="lzs-bigcard-dot" style="background:${LEVEL_COLORS[p.cards[r] || 0]}"></span></button>`;
        }).join('')}
      </div>
      <div class="lzs-box lzs-facts4">
        ${fact('KARTE', sel.name, sel.kind)}
        ${fact('KARTENWERT', sel.value, sel.valueNote)}
        ${fact('IM KARTENSCHUH', `${sel.count}×`, `je ${decks}× ♠ ♥ ♦ ♣`)}
        ${fact('LERNSTATUS', LEVEL_TEXT[lv], YUMEKO_READY ? '' : 'noch nicht gelernt', LEVEL_COLORS[lv] === '#4B5563' ? '#9AA3AE' : LEVEL_COLORS[lv])}
      </div>`;
  }

  _player(p) {
    const h = handInfo(memo.hand, memo.filter);
    return `
      ${segmented([{ id: 'all', label: 'Alle' }, { id: 'two', label: '2 Karten' }, { id: 'more', label: '3+ Karten' }], memo.filter, 'filter', { label: 'Anzahl Karten', cls: 'lzs-self-start' })}
      <div class="lzs-groups">
        ${handGroups().map((g) => `
          <div class="lzs-group"><span class="lzs-group-label">${esc(g.label)}</span>
            <div class="lzs-chips">${g.items.map((it) => `<button type="button" class="lzs-chip lzs-lv${p.hands[it.id] || 0}" data-lzs="hand" data-id="${it.id}" aria-pressed="${it.id === memo.hand}">${esc(it.label)}</button>`).join('')}</div>
          </div>`).join('')}
      </div>
      <div class="lzs-box lzs-hand">
        <div class="lzs-hand-info"><span class="lzs-cap">SPIELERHAND</span><span class="lzs-val lzs-val--lg">${esc(h.title)}</span><span class="lzs-muted lzs-note">${esc(h.note)}</span></div>
        <div class="lzs-hand-ex"><span class="lzs-cap">BEISPIELE</span>
          <div class="lzs-examples">${h.examples.length ? h.examples.map((ex) => `<div class="lzs-ex">${ex.map((r) => cardFace(r, 'sm')).join('')}</div>`).join('') : `<span class="lzs-muted">Mit dieser Kartenzahl nicht möglich.</span>`}</div>
        </div>
      </div>`;
  }

  _dealer(p) {
    const rules = this.ctx.settings.get('rules') || {};
    const outcome = p.dealer && p.dealer[memo.up];
    const rows = ['17', '18', '19', '20', '21', 'Bust'].map((l) => {
      const v = outcome ? outcome[l === 'Bust' ? 'bust' : l] : null;
      const bust = l === 'Bust';
      return `<div class="lzs-orow"><span class="lzs-olabel" style="color:${bust ? '#FDBA74' : '#F2F4F7'}">${l}</span>
        <span class="lzs-otrack"><span style="width:${v == null ? 0 : Math.min(100, v * 2)}%;background:${bust ? '#FB923C' : 'rgba(96,165,250,0.55)'}"></span></span>
        <span class="lzs-opct">${v == null ? DASH : `~${v} %`}</span></div>`;
    }).join('');
    return `
      <div class="lzs-stack8"><span class="lzs-cap">OFFENE DEALERKARTE</span>
        <div class="lzs-upgrid">${UPCARDS.map((u) => `<button type="button" class="lzs-upcard" data-lzs="up" data-id="${u}" aria-pressed="${u === memo.up}">${u}</button>`).join('')}</div>
      </div>
      <div class="lzs-fill lzs-row lzs-gap16">
        <div class="lzs-box lzs-grow lzs-stack12">
          <span class="lzs-cap">MÖGLICHE ENDHÄNDE DES DEALERS · OFFEN ${memo.up === 'A' ? 'ASS' : memo.up}</span>
          ${rows}
          ${outcome ? '' : '<span class="lzs-muted lzs-foot">Wahrscheinlichkeiten erscheinen, sobald Yumeko sie gelernt hat.</span>'}
        </div>
        <div class="lzs-box lzs-dealer-rules">
          <span class="lzs-cap">DEALER-REGELN</span>
          <span class="lzs-text">Zieht bis mindestens 17.<br>${rules.soft17 === 'zieht' ? 'Zieht auf Soft 17.' : 'Steht auf Soft 17.'}</span>
          <span class="lzs-cap">HÄNDE MIT</span>
          <span class="lzs-text">2 bis 7 Karten</span>
          <span class="lzs-muted lzs-foot lzs-small">Gemäss deinen Tischregeln in den Einstellungen.</span>
        </div>
      </div>`;
  }

  _matrix(p) {
    let info = '';
    const rows = MATRIX_ROWS.map((r) => `
      <div class="lzs-mrow"><span class="lzs-mlabel" style="color:${r.kind === 's' ? '#C4B5FD' : '#C5CBD3'}">${esc(r.label)}</span>
        ${UPCARDS.map((c) => {
          const key = `${r.id}:${c}`;
          const lv = p.matrix[key] || 0;
          if (key === memo.cell) info = `${r.label} gegen Dealer ${c === 'A' ? 'Ass' : c} · Status: ${LEVELS[lv]}`;
          return `<button type="button" class="lzs-cell lzs-cl${lv}" data-lzs="cell" data-id="${key}" aria-pressed="${key === memo.cell}" aria-label="${esc(r.label)} gegen ${c}"></button>`;
        }).join('')}
      </div>`).join('');
    return `
      <div class="lzs-matrix">
        <div class="lzs-mrow lzs-mhead"><span class="lzs-mlabel"></span>${UPCARDS.map((c) => `<span class="lzs-mcol">${c}</span>`).join('')}</div>
        ${rows}
      </div>
      <div class="lzs-legend-row">
        <span class="lzs-text-sm">${esc(info)}</span>
        <span class="lzs-legend">${LEVELS.map((l, i) => `<span><i class="lzs-cl${i}"></i>${l}</span>`).join('')}</span>
      </div>`;
  }

  _types(p) {
    return `
      <div class="lzs-types">
        ${HAND_TYPES.map((t) => `
          <div class="lzs-box lzs-type">
            <span class="lzs-type-head"><span class="lzs-type-title" style="color:${t.color}">${esc(t.title)}</span><span class="lzs-muted lzs-small">${p.typeCounts[t.id]} gelernt</span></span>
            <span class="lzs-text-sm">${esc(t.text)}</span>
            <div class="lzs-ex lzs-mt-auto">${t.example.map((r) => cardFace(r, 'xs')).join('')}</div>
          </div>`).join('')}
        <div class="lzs-type lzs-type--dashed">
          <span class="lzs-type-mix">Mischformen</span>
          <span class="lzs-muted lzs-text-sm">Eine Hand kann ihren Typ ändern, z. B. Soft 17 wird nach einer 9 zu Hart 16.</span>
        </div>
      </div>`;
  }

  _decks(p, decks) {
    const s = deckStats(decks);
    const shoe = [
      ['Zahlenkarten 2–9', s.low, 32, 'rgba(96,165,250,0.55)'],
      ['Zehnerwerte', s.tens, 16, BLUE],
      ['Asse', s.aces, 4, '#C4B5FD']
    ];
    return `
      <div class="lzs-deckstats">
        ${[['KARTEN', s.total, `${decks} ${decks === 1 ? 'Deck' : 'Decks'} im Schuh`], ['ASSE', s.aces, 'Wert 1 oder 11'], ['ZEHNERWERTE', s.tens, '10, J, Q, K'], ['BLACKJACK', s.blackjack, 'Chance auf A + Zehnerwert']]
          .map(([l, v, n]) => `<div class="lzs-box lzs-stack6"><span class="lzs-cap">${l}</span><span class="lzs-val lzs-val--xl">${esc(v)}</span><span class="lzs-muted lzs-small">${esc(n)}</span></div>`).join('')}
      </div>
      <div class="lzs-box lzs-fill lzs-stack12">
        <span class="lzs-cap">ZUSAMMENSETZUNG DES KARTENSCHUHS</span>
        ${shoe.map(([l, v, w, c]) => `<div class="lzs-orow"><span class="lzs-shoe-label">${l}</span><span class="lzs-otrack"><span style="width:${Math.round(w / 52 * 100)}%;background:${c}"></span></span><span class="lzs-shoe-val">${v} Karten</span></div>`).join('')}
        <span class="lzs-muted lzs-foot">Yumeko lernt später jede Situation mit 1, 2, 4, 6 und 8 Decks. Die Deckzahl oben gilt nur für diese Seite – deine Tischregeln bleiben unverändert.</span>
      </div>`;
  }
}

function fact(cap, value, note, color) {
  return `<div class="lzs-stack6"><span class="lzs-cap">${cap}</span><span class="lzs-val"${color ? ` style="color:${color}"` : ''}>${esc(value)}</span><span class="lzs-muted lzs-small">${esc(note)}</span></div>`;
}
