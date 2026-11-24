// Lernzentrum › Study (ab 0.11.0). Design: Study.dc.html (iPad quer 1180×820).
// Lernmaterial für Yumeko. Vorerst leer; Hinzufügen und Lernprozess sind deaktiviert,
// bis Yumeko lernen kann. Daten kommen aus studyState().
import { View } from './view-base.js';
import { esc } from '../core/dom.js';
import { lzHeader, segmented, bar, emptyBox, bindActions } from './lz-common.js';
import { studyState, studyStats, STUDY_TYPES, STUDY_FILTERS, YUMEKO_READY, NOT_READY_TEXT } from '../lernzentrum/bereiche.js';

const TYPE_ICONS = {
  yt: '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="4"/><path d="m10 9 5 3-5 3z"/></svg>',
  vid: '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/></svg>',
  doc: '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
  txt: '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/></svg>'
};
const STATUS = {
  done: ['Verarbeitet', 'is-done'],
  busy: ['In Arbeit', 'is-busy'],
  open: ['Offen', '']
};
const off = YUMEKO_READY ? '' : `disabled title="${esc(NOT_READY_TEXT)}"`;
const memo = { add: 'yt', filter: 'all' };

export class StudyView extends View {
  mount() {
    this.el.className = 'screen screen-lz lzs lzs-study';
    bindActions(this, (a, id) => { if (a in memo) { memo[a] = id; this.render(); } });
    this.render();
  }

  render() {
    const st = studyState();
    const n = studyStats(st);
    const lib = st.sources.filter((s) => memo.filter === 'all' || s.status === memo.filter);
    const auto = st.autoLearn;
    const input = {
      yt: `<label class="lzs-field"><span class="lzs-muted lzs-small">YouTube-Link</span><input type="url" class="lzs-input" placeholder="https://youtube.com/…" ${off}></label>`,
      vid: `<div class="lzs-drop"><span>Video auswählen</span><span class="lzs-muted lzs-small">MP4 oder MOV</span></div>`,
      doc: `<div class="lzs-drop"><span>Dokument auswählen</span><span class="lzs-muted lzs-small">PDF, Word oder Text</span></div>`,
      txt: `<label class="lzs-field"><span class="lzs-muted lzs-small">Yumeko etwas beibringen</span><textarea rows="2" class="lzs-input lzs-textarea" placeholder="Text eingeben …" ${off}></textarea></label>`
    }[memo.add];
    const runText = st.running === 'run' ? 'Lernt gerade' : (st.running === 'pause' ? 'Pausiert' : 'Gestoppt');
    const runDot = st.running === 'run' ? '#A78BFA' : (st.running === 'pause' ? '#FACC15' : '#6B7280');

    this.el.innerHTML = `
      <div class="lz">
        ${lzHeader('study', 'Study', 'Lernmaterial für Yumeko', `
          <button type="button" class="lzs-switch" role="switch" aria-checked="${auto}" ${off}>
            Automatisch lernen<span class="lzs-switch-track"><span></span></span>
          </button>`)}
        <section class="lzs-statbar" aria-label="Statistik">
          ${[['Lernquellen', n.sources, '#F2F4F7'], ['Verarbeitet', n.done, '#6EE7B7'], ['Offen', n.open, '#C5CBD3'], ['Erkenntnisse', n.insights, '#DDD6FE']]
            .map(([l, v, c]) => `<div class="lzs-statbar-item"><span class="lzs-muted">${l}</span><span class="lzs-statbar-val" style="color:${c}">${v}</span></div>`).join('')}
        </section>
        <div class="lzs-body lzs-row lzs-gap16">
          <div class="lzs-col lzs-side-wide">
            <section class="lzs-panel lzs-stack12" aria-label="Lernmaterial hinzufügen">
              <span class="lzs-cap">LERNMATERIAL HINZUFÜGEN</span>
              <div class="lzs-addtypes">
                ${STUDY_TYPES.map((t) => `<button type="button" class="lzs-addtype" data-lzs="add" data-id="${t.id}" aria-pressed="${t.id === memo.add}">${TYPE_ICONS[t.id]}${esc(t.label)}</button>`).join('')}
              </div>
              ${input}
              <button type="button" class="lzs-btn" ${off}>Zur Bibliothek hinzufügen</button>
              ${YUMEKO_READY ? '' : `<span class="lzs-muted lzs-small">${esc(NOT_READY_TEXT)}</span>`}
            </section>
            <section class="lzs-panel lzs-grow lzs-stack12" aria-label="Lernprozess">
              <div class="lzs-spread"><span class="lzs-cap">LERNPROZESS</span><span class="lzs-run lzs-small"><span class="lzs-dot" style="background:${runDot}"></span>${runText}</span></div>
              <div class="lzs-stack6">
                <span class="lzs-val lzs-val--sm">${st.current ? esc(st.current.title) : 'Kein Lernmaterial in Arbeit'}</span>
                <span class="lzs-muted lzs-small">${st.current ? esc(`${st.current.kind} · ${st.current.activity}`) : '—'}</span>
                ${bar(st.current ? st.current.progress : 0, '#A78BFA')}
                <span class="lzs-muted lzs-small">${st.current ? st.current.progress : 0} % verarbeitet</span>
              </div>
              <div class="lzs-ctrl3">${['Start', 'Pause', 'Stop'].map((c) => `<button type="button" class="lzs-btn lzs-btn--sm" ${off}>${c}</button>`).join('')}</div>
              <div class="lzs-stack8 lzs-divider">
                <span class="lzs-muted lzs-small">Warteschlange</span>
                ${st.queue.length ? st.queue.map((q, i) => `<span class="lzs-queue"><span class="lzs-queue-n">${i + 1}</span>${esc(q.title)}</span>`).join('') : '<span class="lzs-muted lzs-text-sm">Leer</span>'}
              </div>
            </section>
          </div>
          <div class="lzs-col lzs-grow">
            <section class="lzs-panel lzs-grow-135 lzs-stack10" aria-label="Learning Library">
              <div class="lzs-spread"><span class="lzs-cap">LEARNING LIBRARY</span>${segmented(STUDY_FILTERS, memo.filter, 'filter', { label: 'Filter', cls: 'lzs-seg--sm' })}</div>
              ${lib.length ? `<div class="lzs-list">${lib.map((l) => `<div class="lzs-lib"><span class="lzs-tag">${esc(l.tag)}</span><span class="lzs-lib-text"><span class="lzs-lib-title">${esc(l.title)}</span><span class="lzs-muted lzs-small">${esc(l.meta)}</span></span><span class="lzs-status ${STATUS[l.status][1]}">${STATUS[l.status][0]}</span></div>`).join('')}</div>`
                : emptyBox('Noch kein Lernmaterial', 'Hier erscheinen später YouTube-Links, Videos, Dokumente und Texte, aus denen Yumeko lernt.', 'lzs-grow')}
            </section>
            <section class="lzs-panel lzs-grow lzs-stack10" aria-label="Learning Insights">
              <div class="lzs-spread"><span class="lzs-cap">LEARNING INSIGHTS</span><span class="lzs-muted lzs-small">${n.insights} Erkenntnisse · ${n.inBrain} im Brain</span></div>
              ${st.insights.length ? st.insights.map((i) => `<div class="lzs-insight"><span class="lzs-insight-dot"></span><span class="lzs-lib-text"><span>${esc(i.text)}</span><span class="lzs-muted lzs-small">Quelle: ${esc(i.source)}</span></span><span class="lzs-status ${i.inBrain ? 'is-brain' : 'is-new'}">${i.inBrain ? 'Im Brain' : 'Neu'}</span></div>`).join('')
                : emptyBox('Noch keine Erkenntnisse', 'Yumeko hat noch nichts aus Lernmaterial gelernt.', 'lzs-grow')}
            </section>
          </div>
        </div>
      </div>`;
  }
}
