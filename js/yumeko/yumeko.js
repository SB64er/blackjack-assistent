// YUMEKO AI – lernender Kern.
//
// Was YUMEKO tatsächlich lernt (nachvollziehbar, aus echten Daten):
//  1. BEOBACHTEN: archivierte Runden und bestätigte Video-Lernsequenzen.
//  2. ANALYSIEREN: Entscheidungsqualität je Spielsituation (Erwartungswert im
//     Rechenmodell), Fehler, widersprüchliche Entscheidungen, Datenqualität,
//     Erkennungsfehler (aus Korrekturen) und auffällige Ergebnisse.
//  3. LERNEN: speichert Erkenntnisse im Wissensspeicher, passt die Kartenprüfung
//     für oft korrigierte Kartenwerte an und erstellt Strategieentwürfe. Ein
//     Entwurf wird mathematisch geprüft und erst nach ausdrücklicher Bestätigung
//     aktiv. Ergebnisse (Glück) ändern die Strategie nie direkt.
import { Emitter } from '../core/events.js';
import { analyzeArchive, decisionEVs } from './archive-analysis.js';
import { CATEGORIES, STATUS } from './knowledge.js';
import { computeStrategy, strategyEV, profilePolicy, MODEL_ASSUMPTIONS } from '../strategy/ev.js';
import { normalizeRules, rulesText, rulesEqual, standardCode, parseKey, cellKey, ROWS, UPCARDS, STANDARD_SOURCE, CODES_BY_KIND, CODE_LABEL, rowLabel, upLabel } from '../strategy/standard.js';
import { codesEquivalent } from '../strategy/research.js';
import { resolveCode } from '../strategy/engine.js';
import { pct } from '../strategy/analysis.js';

export const ADOPT_TOLERANCE = 0.001; // Vorschlag wird nur übernommen, wenn er im Modell höchstens 0,1 % schlechter ist
const ACTION_DE = { HIT: 'Ziehen', STAND: 'Stehen', DOUBLE: 'Verdoppeln', SPLIT: 'Splitten' };

const nowIso = () => new Date().toISOString();

/** Wissenseinträge aus einem Analysebericht (deterministische IDs -> keine Duplikate). */
export function insightsFromReport(report) {
  const out = [];
  const o = report.outcomes;
  const q = report.quality;
  out.push({
    id: 'a:exp:summary',
    category: 'experience',
    content: `${report.roundsUsed} von ${report.roundsTotal} Runden ausgewertet (${report.handsUsed} Hände, ${report.decisionsUsed} Entscheidungen). Netto ${o.net >= 0 ? '+' : ''}${o.net.toFixed(1)} Einsätze${o.ci95 ? `, pro Hand ${pct(o.meanPerHand)} (95-%-Bereich ${pct(o.ci95[0])} bis ${pct(o.ci95[1])})` : ''}. ${o.note}`,
    origin: { type: 'archive', detail: `Archivanalyse ${report.generatedAt}` },
    confidence: { level: q.level, n: report.handsUsed, basis: 'Spielergebnisse (zufallsabhängig)' },
    status: STATUS.observed,
    refs: { rounds: report.roundIds.slice(-200) },
    data: { kind: 'summary' },
    auto: true
  });
  out.push({
    id: 'a:exp:quality',
    category: 'experience',
    content: `Datenqualität ${q.level}: ${Math.round(q.usedShare * 100)} % der Runden nutzbar, ${Math.round(q.manualShare * 100)} % manuell bestätigt${q.avgMinScore != null ? `, durchschnittliche Erkennungssicherheit ${Math.round(q.avgMinScore * 100)} %` : ''}. ${q.reasons.join(' ')}`,
    origin: { type: 'analysis', detail: 'Datenqualität' },
    confidence: { level: 'hoch', n: report.roundsTotal, basis: 'Zählung der Archiveinträge' },
    status: STATUS.observed,
    data: { kind: 'quality' },
    auto: true
  });
  const rulesList = Object.entries(report.byRules).sort((a, b) => b[1].rounds - a[1].rounds);
  if (rulesList.length) {
    out.push({
      id: 'a:rule:played',
      category: 'rule',
      content: `Gespielte Tischregeln: ${rulesList.map(([k, v]) => `${k} (${v.rounds} Runden)`).join('; ')}. YUMEKO entwirft Strategien für die Regeln, die du gerade eingestellt hast.`,
      origin: { type: 'archive', detail: 'Regeln der archivierten Runden' },
      rules: rulesList[0][1].rules,
      confidence: { level: 'hoch', n: report.roundsUsed, basis: 'Zählung' },
      status: STATUS.observed,
      data: { kind: 'rules', byRules: Object.fromEntries(rulesList.map(([k, v]) => [k, v.rounds])) },
      auto: true
    });
  }
  for (const m of report.mistakes.slice(0, 25)) {
    out.push({
      id: `a:ver:${m.situation}|${m.action}`,
      category: 'verified',
      content: `${m.text} (${m.rulesKey}): ${m.count}× ${ACTION_DE[m.action]} gewählt. Rechenmodell: ${ACTION_DE[m.best]} ist um ${pct(m.lossEach, 2)} des Einsatzes pro Hand besser – unabhängig davon, ob diese Hände gewonnen oder verloren wurden. Rechnerischer Verlust: ${m.lossTotal.toFixed(3)} Einsätze.`,
      origin: { type: 'math', detail: 'Exakte Berechnung im Rechenmodell' },
      rules: m.rules,
      confidence: { level: 'hoch', n: m.count, basis: 'Mathematisch berechnet (Modell: unendliches Deck)' },
      status: STATUS.verified,
      refs: { rounds: m.rounds.slice(-100) },
      data: { kind: 'mistake', key: m.key, action: m.action, best: m.best, lossEach: m.lossEach },
      auto: true
    });
  }
  for (const s of report.inconsistent.slice(0, 25)) {
    out.push({
      id: `a:exp:inc:${s.situation}`,
      category: 'experience',
      content: `${s.text} (${s.rulesKey}): unterschiedliche Entscheidungen in gleicher Lage – ${Object.entries(s.actions).map(([a, c]) => `${c}× ${ACTION_DE[a]}`).join(', ')}. Rechnerisch beste Aktion: ${ACTION_DE[s.best]}.`,
      origin: { type: 'archive', detail: 'Vergleich gleicher Spielsituationen' },
      confidence: { level: 'hoch', n: Object.values(s.actions).reduce((a, b) => a + b, 0), basis: 'Zählung' },
      status: STATUS.observed,
      refs: { rounds: s.rounds.slice(-100) },
      data: { kind: 'inconsistent' },
      auto: true
    });
  }
  for (const p of report.patterns.slice(0, 25)) {
    out.push({
      id: `a:hyp:${p.situation}`,
      category: 'hypothesis',
      content: `${p.text} (${p.rulesKey}): Ergebnis mit ${ACTION_DE[p.action]} ${pct(p.meanNet)} pro Hand (95-%-Bereich ${pct(p.ci95[0])} bis ${pct(p.ci95[1])}, ${p.n} Hände), erwartet ${pct(p.expected)}. Mögliche Ursachen: Zufall, Erkennungsfehler, andere Tischregeln. Nicht bestätigt – ändert die Strategie nicht.`,
      origin: { type: 'analysis', detail: 'Vergleich Ergebnis/Erwartung' },
      rules: null,
      confidence: { level: 'niedrig', n: p.n, basis: 'Statistik kleiner Stichproben' },
      status: STATUS.unconfirmed,
      refs: { rounds: p.rounds.slice(-100) },
      data: { kind: 'pattern' },
      auto: true
    });
  }
  for (const [rank, r] of Object.entries(report.recognition.perRank)) {
    if (r.corrected < 2) continue;
    const top = Object.entries(r.to).sort((a, b) => b[1] - a[1])[0];
    out.push({
      id: `a:exp:rank:${rank}`,
      category: 'experience',
      content: `Erkannte Karte „${rank}“ wurde ${r.corrected}× korrigiert (meist zu „${top[0]}“). YUMEKO prüft „${rank}“ deshalb künftig ${extraChecks(r.corrected)}× zusätzlich, bevor die Karte bestätigt wird.`,
      origin: { type: 'archive', detail: 'Korrekturen im Archiv' },
      confidence: { level: r.corrected >= 10 ? 'hoch' : 'mittel', n: r.corrected, basis: 'Zählung der Korrekturen' },
      status: STATUS.observed,
      data: { kind: 'recognition', rank },
      auto: true
    });
  }
  return out;
}

export function extraChecks(corrected) {
  if (corrected >= 10) return 2;
  if (corrected >= 3) return 1;
  return 0;
}

/** Quellen, die YUMEKO immer kennt. */
export function sourceItems() {
  return [{
    id: 'src:standard',
    category: 'source',
    content: `${STANDARD_SOURCE.title} – ${STANDARD_SOURCE.url} (abgerufen ${STANDARD_SOURCE.retrievedAt}). Referenz der Standardstrategie (ohne Aufgeben).`,
    origin: { type: 'source', detail: 'Eingebaute Quelle' },
    confidence: { level: 'hoch', basis: 'Etablierte Basisstrategie' },
    status: STATUS.verified,
    data: { url: STANDARD_SOURCE.url },
    auto: true
  }, {
    id: 'src:model',
    category: 'source',
    content: `Rechenmodell der App (exakte Erwartungswerte). Annahmen: ${MODEL_ASSUMPTIONS.join(' ')}`,
    origin: { type: 'math', detail: 'js/strategy/ev.js' },
    confidence: { level: 'hoch', basis: 'Mathematische Herleitung, durch Tests mit der Standardstrategie abgeglichen' },
    status: STATUS.verified,
    data: {},
    auto: true
  }];
}

function cellCodes(rules) {
  const out = {};
  for (const kind of Object.keys(ROWS)) for (const v of ROWS[kind]) for (const u of UPCARDS) {
    if (kind !== 'pair' && v === 21) continue;
    out[cellKey(kind, v, u)] = { kind, v, u };
  }
  return out;
}

/**
 * Strategieentwurf: Rechenmodell + bestätigte Lerninformationen, die die
 * mathematische Prüfung bestehen. Reine Funktion.
 */
export function buildDraft({ rules, items = [], number, prev = null, at = nowIso() }) {
  const r = normalizeRules(rules);
  const calc = computeStrategy(r);
  const overrides = {};
  const cells = cellCodes(r);
  for (const [key, c] of Object.entries(cells)) {
    const code = calc.cells[key].code;
    if (!codesEquivalent(code, standardCode(c.kind, c.v, c.u, r), r, key)) overrides[key] = code;
  }
  const adopted = [];
  const rejected = [];
  const candidates = items.filter((i) => i.data && i.data.cell && i.data.cell.key && i.data.cell.code
    && [STATUS.userConfirmed, STATUS.verified].includes(i.status)
    && (!i.rules || rulesEqual(i.rules, r)));
  for (const it of candidates) {
    const { key, code } = it.data.cell;
    const k = parseKey(key);
    if (!k || !CODES_BY_KIND[k.kind].includes(code)) { rejected.push({ id: it.id, key, code, reason: 'Ungültige Zelle oder Aktion.' }); continue; }
    const cell = calc.cells[key];
    const allowed = { double: true, split: k.kind === 'pair', das: r.das };
    const act = resolveCode(code, allowed) || 'HIT';
    const ev = cell.evs[act];
    const loss = ev == null ? Infinity : cell.evs[cell.best] - ev;
    if (loss <= ADOPT_TOLERANCE) {
      if (codesEquivalent(code, standardCode(k.kind, k.value, k.up, r), r, key)) delete overrides[key];
      else overrides[key] = code;
      adopted.push({ id: it.id, key, code, loss, reason: loss < 1e-9 ? 'entspricht dem Rechenmodell' : `innerhalb der Toleranz (${pct(loss, 2)} schlechter im Modell mit unendlichem Deck)` });
    } else {
      rejected.push({ id: it.id, key, code, loss, reason: `im Rechenmodell ${pct(loss, 2)} des Einsatzes schlechter als ${ACTION_DE[cell.best]}` });
    }
  }
  const changes = [];
  const prevO = prev ? prev.overrides : {};
  for (const key of new Set([...Object.keys(prevO), ...Object.keys(overrides)])) {
    if ((prevO[key] || null) !== (overrides[key] || null)) changes.push({ key, from: prevO[key] || 'Standard', to: overrides[key] || 'Standard' });
  }
  return {
    id: `v_${number}_${Date.parse(at).toString(36)}`,
    number,
    rules: r,
    overrides,
    createdAt: at,
    status: 'entwurf',
    basis: {
      method: 'Exakte Erwartungswerte (Rechenmodell) für die eingestellten Tischregeln, ergänzt um bestätigte Lerninformationen, die die Prüfung bestehen.',
      adopted,
      rejected,
      changes
    },
    verification: null,
    confirmedAt: null
  };
}

/** Mathematische Prüfung einer Strategieversion gegen Referenzen. Reine Funktion. */
export function verifyVersion(v) {
  const r = normalizeRules(v.rules);
  const calc = computeStrategy(r);
  const evVersion = strategyEV(r, profilePolicy(v.overrides, r, r)).ev;
  const evStandard = strategyEV(r, profilePolicy(null, r, r)).ev;
  const evModel = strategyEV(r).ev;
  const cells = [];
  const problems = [];
  for (const [key, code] of Object.entries(v.overrides)) {
    const k = parseKey(key);
    if (!k || !CODES_BY_KIND[k.kind].includes(code)) { problems.push(`${key}: ungültiger Eintrag`); continue; }
    const cell = calc.cells[key];
    const act = resolveCode(code, { double: true, split: k.kind === 'pair', das: r.das }) || 'HIT';
    const loss = cell.evs[cell.best] - cell.evs[act];
    cells.push({ key, label: `${rowLabel(k.kind, k.value)} gegen ${upLabel(k.up)}`, code, codeLabel: CODE_LABEL[code], standard: standardCode(k.kind, k.value, k.up, r), loss });
    if (loss > ADOPT_TOLERANCE) problems.push(`${rowLabel(k.kind, k.value)} gegen ${upLabel(k.up)}: ${pct(loss, 2)} schlechter als die beste Aktion`);
  }
  if (evVersion < evStandard - 1e-9) problems.push(`Gesamterwartungswert (${pct(evVersion, 3)}) liegt unter der Standardstrategie (${pct(evStandard, 3)}).`);
  return {
    ok: problems.length === 0,
    at: nowIso(),
    evVersion,
    evStandard,
    evModel,
    vsStandard: evVersion - evStandard,
    cells,
    problems,
    method: 'Erwartungswert pro Einsatz im Rechenmodell (unendliches Deck, Dealer-Peek, ein Split, kein Aufgeben) – exakt berechnet, keine Schätzung.',
    note: 'Auch eine bessere Strategie behält einen Hausvorteil. Keine Gewinngarantie.'
  };
}

export class Yumeko extends Emitter {
  constructor({ archive, knowledge, profiles, settings }) {
    super();
    this.archive = archive;
    this.knowledge = knowledge;
    this.profiles = profiles;
    this.settings = settings;
    this.busy = null;
    this.lastReport = null;
    knowledge.ready().then(async () => {
      if (!knowledge.error) await knowledge.upsertMany(sourceItems(), { fromAnalysis: true });
    }).catch(() => {});
    const re = () => this.emit('change');
    archive.on('change', re);
    knowledge.on('change', re);
    profiles.on('change', re);
  }

  /** Lernstatus – ausschliesslich aus vorhandenen Daten. */
  status() {
    const a = this.archive;
    const k = this.knowledge;
    const last = k.meta.lastAnalysis || null;
    const analyzedSet = new Set(last ? last.roundIds || [] : []);
    const fresh = a.rounds.filter((r) => !analyzedSet.has(r.id)).length;
    const active = k.versions.find((v) => v.status === 'aktiv') || null;
    const y = this.profiles.get('yumeko');
    const issues = [];
    if (a.error) issues.push(a.error);
    if (k.error) issues.push(k.error);
    if (a.kind === 'local') issues.push('IndexedDB nicht verfügbar – Daten liegen im kleineren localStorage. Bitte regelmässig exportieren.');
    issues.push('Video: Sprachtranskription ist nicht verfügbar; Texterkennung (OCR) nur auf Geräten mit eingebautem Texterkenner im Browser.');
    issues.push('YUMEKO-Chat: keine Sprachmodell-Anbindung – Antworten werden aus deinen Daten berechnet.');
    let phase;
    if (!a.rounds.length && !k.videos.length) phase = 'Wartet auf Daten – spiele Runden mit Kamera oder lerne ein Video.';
    else if (!last) phase = 'Beobachtet – noch keine Analyse durchgeführt.';
    else if (fresh) phase = `Beobachtet – ${fresh} neue ${fresh === 1 ? 'Runde' : 'Runden'} seit der letzten Analyse.`;
    else phase = 'Analysiert – alle archivierten Runden sind ausgewertet.';
    return {
      phase,
      roundsArchived: a.rounds.length,
      roundsAnalyzed: last ? last.roundsUsed : 0,
      roundsSeen: last ? (last.roundIds || []).length : 0,
      fresh,
      verified: k.items.filter((i) => i.status === STATUS.verified || i.status === STATUS.userConfirmed).filter((i) => i.category !== 'source').length,
      unverified: k.items.filter((i) => i.status === STATUS.unconfirmed || i.status === STATUS.contradicted).length,
      videos: k.videos.length,
      strategyVersion: y ? y.data.strategyVersion || 0 : 0,
      activeVersion: active,
      drafts: k.versions.filter((v) => v.status === 'entwurf' || v.status === 'geprüft').length,
      lastAnalysisAt: last ? last.at : null,
      issues
    };
  }

  /** Zusätzliche Kartenprüfungen pro Kartenwert (aus Korrekturen gelernt). */
  confirmFor(rank) {
    const per = (this.knowledge.meta.recognition && this.knowledge.meta.recognition.perRank) || {};
    return per[rank] ? extraChecks(per[rank].corrected) : 0;
  }

  async analyzeArchive() {
    await Promise.all([this.archive.ready(), this.knowledge.ready()]);
    this.busy = 'analyse';
    this.emit('change');
    try {
      const report = analyzeArchive(this.archive.rounds);
      const items = insightsFromReport(report);
      await this.knowledge.upsertMany(items, { fromAnalysis: true });
      await this.knowledge.pruneAuto('a:', new Set(items.map((i) => i.id)));
      await this.knowledge.saveMeta({
        lastAnalysis: {
          at: report.generatedAt,
          version: report.version,
          roundsTotal: report.roundsTotal,
          roundsUsed: report.roundsUsed,
          handsUsed: report.handsUsed,
          decisionsUsed: report.decisionsUsed,
          roundIds: report.roundIds,
          quality: report.quality.level,
          mistakes: report.mistakes.length,
          evLossTotal: report.decisionQuality.evLossTotal
        },
        recognition: { perRank: report.recognition.perRank }
      });
      await this.knowledge.logHistory('analyse', `Archiv analysiert: ${report.roundsUsed} von ${report.roundsTotal} Runden, ${report.decisionsUsed} Entscheidungen, ${report.mistakes.length} Fehlertypen, ${items.length} Erkenntnisse.`);
      this.lastReport = report;
      return report;
    } finally {
      this.busy = null;
      this.emit('change');
    }
  }

  /** Neuen Strategieentwurf für die aktuellen Tischregeln erstellen (noch nicht aktiv). */
  async draft() {
    await this.knowledge.ready();
    const number = (this.knowledge.versions[0] ? this.knowledge.versions[0].number : 0) + 1;
    const prev = this.knowledge.versions.find((v) => v.status === 'aktiv') || null;
    const d = buildDraft({ rules: this.settings.get('rules'), items: this.knowledge.items, number, prev });
    await this.knowledge.putVersion(d);
    return d;
  }

  async verify(id) {
    const v = this.knowledge.versions.find((x) => x.id === id);
    if (!v) throw new Error('Version nicht gefunden.');
    const verification = verifyVersion(v);
    return this.knowledge.putVersion({ ...v, verification, status: verification.ok ? 'geprüft' : 'abgelehnt' });
  }

  /** Erst nach Prüfung UND ausdrücklicher Bestätigung aktiv. */
  async confirm(id) {
    const v = this.knowledge.versions.find((x) => x.id === id);
    if (!v) throw new Error('Version nicht gefunden.');
    if (!v.verification || !v.verification.ok) throw new Error('Die Version muss zuerst die mathematische Prüfung bestehen.');
    const confirmed = { ...v, status: 'aktiv', confirmedAt: nowIso() };
    this.profiles.applyYumekoVersion(confirmed);
    for (const other of this.knowledge.versions.filter((x) => x.status === 'aktiv' && x.id !== id)) {
      await this.knowledge.putVersion({ ...other, status: 'ersetzt' });
    }
    await this.knowledge.putVersion(confirmed);
    await this.knowledge.upsert({
      id: `version:${confirmed.number}`,
      category: 'version',
      content: `Strategieversion ${confirmed.number} aktiviert (${rulesText(confirmed.rules)}): ${Object.keys(confirmed.overrides).length} Abweichungen zur Standardstrategie, Erwartungswert ${pct(confirmed.verification.evVersion, 3)} (Standard ${pct(confirmed.verification.evStandard, 3)}).`,
      origin: { type: 'user', detail: 'Vom Benutzer bestätigt' },
      rules: confirmed.rules,
      confidence: { level: 'hoch', basis: 'Mathematisch geprüft' },
      status: STATUS.userConfirmed,
      data: { versionId: confirmed.id },
      auto: false
    });
    return confirmed;
  }

  /**
   * Bestätigte Video-Lernsequenz einlernen: Beobachtungen speichern und
   * gezeigte Entscheidungen mathematisch prüfen.
   */
  async learnFromSequence(seq) {
    await this.knowledge.addVideo(seq);
    const rules = normalizeRules(this.settings.get('rules'));
    const items = [];
    seq.scenes.forEach((sc, i) => {
      const dealer = sc.cards.filter((c) => c.role === 'dealer');
      const player = sc.cards.filter((c) => c.role === 'player');
      const base = {
        origin: { type: 'video', detail: `${seq.source} · ${fmtTime(sc.t0)}–${fmtTime(sc.t1)}` },
        rules,
        refs: { videos: [seq.id] },
        auto: false
      };
      items.push({
        ...base,
        id: `video:${seq.id}:${i}`,
        category: 'video',
        content: `Szene ${i + 1} (${fmtTime(sc.t0)}): Dealer ${dealer.map((c) => c.rank).join(' ') || '–'}, Spieler ${player.map((c) => c.rank).join(' ') || '–'}${sc.action ? `, gezeigte Aktion: ${ACTION_DE[sc.action]}${sc.actionSuggested ? ' (aus Kartenänderung abgeleitet)' : ''}` : ''}.`,
        confidence: { level: sc.corrected ? 'mittel' : (sc.unsure ? 'niedrig' : 'mittel'), n: 1, basis: sc.corrected ? 'Erkennung, vom Benutzer korrigiert' : 'Kartenerkennung, vom Benutzer übernommen' },
        status: STATUS.userConfirmed,
        data: { scene: sc }
      });
      if (sc.action && dealer.length && player.length >= 2) {
        const check = checkShownDecision(player.map((c) => c.rank), dealer[0].rank, sc.action, rules);
        if (check) {
          items.push({
            ...base,
            id: `video:${seq.id}:${i}:check`,
            category: check.agrees ? 'verified' : 'hypothesis',
            content: `Video zeigt ${check.text}: ${ACTION_DE[sc.action]}. ${check.agrees ? 'Stimmt mit dem Rechenmodell überein.' : `Rechenmodell: ${ACTION_DE[check.best]} ist um ${pct(check.loss, 2)} des Einsatzes besser. Nicht übernommen.`}`,
            confidence: { level: 'hoch', n: 1, basis: 'Mathematische Prüfung' },
            status: check.agrees ? STATUS.verified : STATUS.contradicted,
            data: { cell: check.key ? { key: check.key, code: check.code } : null, best: check.best, loss: check.loss }
          });
        }
      }
    });
    (seq.texts || []).slice(0, 20).forEach((tx, i) => {
      items.push({
        id: `video:${seq.id}:text:${i}`,
        category: 'video',
        content: `Eingeblendeter Text bei ${fmtTime(tx.t)}: „${tx.text}“ (lokale Texterkennung, ungeprüft).`,
        origin: { type: 'video', detail: seq.source },
        rules,
        refs: { videos: [seq.id] },
        confidence: { level: 'niedrig', n: 1, basis: 'Texterkennung des Browsers' },
        status: STATUS.observed,
        auto: false
      });
    });
    await this.knowledge.upsertMany(items);
    return items;
  }
}

function fmtTime(sec) {
  if (!(sec >= 0)) return '–';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Gezeigte Entscheidung mit dem Rechenmodell prüfen. */
export function checkShownDecision(playerRanks, upRank, action, rules) {
  const d = decisionEVs(playerRanks, upRank, rules, false);
  if (!d || d.evs[action] == null) return null;
  const loss = d.evs[d.best] - d.evs[action];
  const code = { HIT: 'H', STAND: 'S', DOUBLE: 'D', SPLIT: 'P' }[action];
  const isCell = d.count === 2;
  return {
    text: `${d.kind === 'pair' ? `Paar ${d.value === 11 ? 'Asse' : d.value}` : `${d.soft ? 'Weich' : 'Hart'} ${d.t}`} gegen ${d.up === 11 ? 'Ass' : d.up}`,
    agrees: loss <= ADOPT_TOLERANCE,
    best: d.best,
    loss,
    key: isCell ? d.key : null,
    code: isCell ? code : null
  };
}

export { CATEGORIES };
