// YUMEKO-Chat – datenbasierte Antworten (ohne Sprachmodell).
// Es gibt keine Anbindung an ein Sprachmodell. Die Frage wird einem Thema
// zugeordnet und die Antwort ausschliesslich aus gespeicherten Daten und
// nachvollziehbaren Berechnungen zusammengesetzt. Wenn Daten fehlen, sagt
// YUMEKO das – es werden keine Lernfortschritte, Gewinne oder Fähigkeiten erfunden.
// Reine Logik (ohne DOM) -> testbar.
import { analyzeArchive } from './archive-analysis.js';
import { summarizeRounds } from '../archive/round-record.js';
import { assessRisk, outlook } from '../risk/risk.js';
import { rulesText } from '../strategy/standard.js';

const ACTION_DE = { HIT: 'Ziehen', STAND: 'Stehen', DOUBLE: 'Verdoppeln', SPLIT: 'Splitten' };
const pctTxt = (x, d = 2) => `${(x * 100).toFixed(d).replace('-', '−')} %`;
const money = (x, c) => `${(Math.round(x * 100) / 100).toFixed(2)} ${c}`;
const dateDe = (iso) => { try { return new Date(iso).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; } };

export const CHAT_EXAMPLES = [
  'Was hast du heute gelernt?',
  'Was hast du aus meinem letzten Video erkannt?',
  'Welche Strategie ist mathematisch besser?',
  'Welche Fehler kommen in meinem Archiv häufig vor?',
  'Wie hoch waren meine tatsächlichen Verluste?',
  'Welche Strategieversion verwendest du?',
  'Warum empfiehlst du diese Aktion?',
  'Sollte ich unter diesen Bedingungen überhaupt spielen?'
];

// Reihenfolge = Priorität
const INTENTS = [
  ['play', /(überhaupt|ueberhaupt) spielen|sollte ich .*spielen|soll ich .*spielen|lohnt sich|aufhören|aufhoeren|stopp?\b/i],
  ['why', /warum|wieso|weshalb|begründ|begruend/i],
  ['losses', /verlust|verloren|gewinn|saldo|geld|budget|einsatz|bilanz/i],
  ['video', /video/i],
  ['mistakes', /fehler|falsch/i],
  ['compare', /besser|vergleich|stärker|staerker|welche strategie/i],
  ['version', /version|welche tabelle|welches profil/i],
  ['learned', /gelernt|lernst|neu(es)? |heute|lernstand|fortschritt/i],
  ['help', /hilfe|was kannst|fragen|^\s*\?/i]
];

export function intentOf(question) {
  const q = String(question || '').trim();
  if (!q) return 'help';
  for (const [id, re] of INTENTS) if (re.test(q)) return id;
  return 'unknown';
}

/**
 * @param {string} question
 * @param {object} d – Datenstand:
 *   { now, rules, rounds, knowledge: { items, videos, versions, meta }, profile: { name, type, version },
 *     yumekoStatus, bankroll: { config, stats }, strategy: { ev, label }, simulations: [], lastAdvice }
 * @returns {{ intent, paragraphs: string[], basis: string[] }}
 */
export function answer(question, d) {
  const intent = intentOf(question);
  const fn = HANDLERS[intent] || HANDLERS.unknown;
  const out = fn(d);
  return { intent, paragraphs: out.p, basis: out.basis };
}

const sameDay = (a, b) => a.slice(0, 10) === b.slice(0, 10);

const HANDLERS = {
  learned(d) {
    const now = (d.now || new Date()).toISOString();
    const items = d.knowledge.items.filter((i) => i.category !== 'source');
    const today = items.filter((i) => sameDay(i.updatedAt, now));
    const last = d.knowledge.meta && d.knowledge.meta.lastAnalysis;
    const p = [];
    if (!items.length && !d.rounds.length) {
      p.push('Ich habe noch nichts gelernt: Es gibt keine archivierten Runden, keine Video-Lernsequenzen und keine eigenen Erkenntnisse. Spiele Runden mit der Kamera oder lerne ein Video.');
      return { p, basis: ['Wissensspeicher (leer)', 'Spielarchiv (leer)'] };
    }
    if (today.length) {
      const by = {};
      for (const i of today) by[i.category] = (by[i.category] || 0) + 1;
      const names = { experience: 'Spielerfahrungen', video: 'Videobeobachtungen', rule: 'Strategieregeln', verified: 'geprüfte Erkenntnisse', hypothesis: 'Hypothesen', version: 'Strategieversionen' };
      p.push(`Heute wurden ${today.length} Einträge im Wissensspeicher angelegt oder aktualisiert: ${Object.entries(by).map(([k, n]) => `${n} ${names[k] || k}`).join(', ')}.`);
      const top = today.filter((i) => i.category === 'verified' || i.category === 'hypothesis').slice(0, 3);
      for (const i of top) p.push(`• ${i.content}`);
    } else {
      p.push('Heute ist noch nichts Neues dazugekommen.');
    }
    if (last) p.push(`Letzte Archivanalyse: ${dateDe(last.at)} mit ${last.roundsUsed} von ${last.roundsTotal} Runden und ${last.decisionsUsed} Entscheidungen.`);
    else if (d.rounds.length) p.push(`${d.rounds.length} Runden sind archiviert, aber noch nicht analysiert. Tippe im Lernzentrum auf „Archiv analysieren“.`);
    return { p, basis: ['Wissensspeicher (Datum der Einträge)', 'letzte Archivanalyse'] };
  },

  video(d) {
    const v = d.knowledge.videos[0];
    if (!v) return { p: ['Es gibt noch keine übernommene Video-Lernsequenz. Unter YUMEKO → Video lernen kannst du ein Video abfilmen oder eine Datei wählen.'], basis: ['Video-Lernsequenzen (leer)'] };
    const scenes = v.scenes || [];
    const unsure = scenes.filter((s) => s.unsure && !s.corrected).length;
    const withAction = scenes.filter((s) => s.action).length;
    const checks = d.knowledge.items.filter((i) => i.refs.videos.includes(v.id) && (i.category === 'verified' || i.category === 'hypothesis'));
    const agree = checks.filter((i) => i.category === 'verified').length;
    const p = [`Letzte Lernsequenz: „${v.source}“ vom ${dateDe(v.createdAt)} mit ${scenes.length} Szenen (${unsure} unsicher erkannt, ${withAction} mit zugeordneter Aktion).`];
    if (checks.length) p.push(`${checks.length} gezeigte Entscheidungen wurden mathematisch geprüft: ${agree} stimmen mit dem Rechenmodell überein, ${checks.length - agree} nicht (diese wurden nicht übernommen).`);
    else p.push('Es wurden keine Entscheidungen geprüft, weil keiner Szene eine Aktion zugeordnet wurde.');
    if (v.texts && v.texts.length) p.push(`Erkannte eingeblendete Texte: ${v.texts.slice(0, 3).map((t) => `„${t.text}“`).join(', ')}.`);
    p.push('Gesprochene Erklärungen kann ich nicht auswerten (Transkription ist nicht verfügbar).');
    return { p, basis: ['Video-Lernsequenzen', 'Wissensspeicher (Video-Prüfungen)'] };
  },

  compare(d) {
    const p = [];
    const sims = d.simulations || [];
    const last = sims[0];
    if (d.profileEVs && d.profileEVs.length) {
      const list = [...d.profileEVs].sort((a, b) => b.ev - a.ev);
      p.push(`Exakte Mathematik (${rulesText(d.rules)}, unendliches Deck): ${list.map((x) => `${x.name} ${pctTxt(x.ev, 3)}`).join(', ')}. Höher ist besser; ${list[0].name} liegt vorne.`);
    }
    if (last) {
      const rows = last.results.map((r) => `${r.name} ${pctTxt(r.ev, 2)} ± ${pctTxt(1.96 * r.se, 2)}`).join(', ');
      p.push(`Letzte Simulation (${dateDe(last.at)}, ${last.rounds.toLocaleString('de-CH')} Runden je Strategie, gleiche Mischfolge): ${rows}. Unterschiede innerhalb der Unsicherheit sind nicht aussagekräftig.`);
    } else {
      p.push('Es gibt noch keine gespeicherte Simulation. Im Strategie-Labor kannst du Strategien unter gleichen Bedingungen vergleichen.');
    }
    p.push('Auch die beste Strategie hat bei üblichen Regeln einen negativen Erwartungswert. Keine Gewinngarantie.');
    return { p, basis: ['Rechenmodell (exakt)', 'gespeicherte Simulationen (getrennt von echten Runden)'] };
  },

  mistakes(d) {
    if (!d.rounds.length) return { p: ['Im Archiv sind noch keine Runden. Ohne Daten kann ich keine Fehler nennen.'], basis: ['Spielarchiv (leer)'] };
    const r = analyzeArchive(d.rounds, { generatedAt: (d.now || new Date()).toISOString() });
    const p = [];
    if (!r.mistakes.length) p.push(`In ${r.decisionsUsed} ausgewerteten Entscheidungen gibt es keine Abweichung von der besten Aktion (ab 0,1 % des Einsatzes).`);
    else {
      p.push(`In ${r.decisionsUsed} ausgewerteten Entscheidungen sind ${r.decisionQuality.mistakes} rechnerisch schlechter als die beste Aktion. Häufigste:`);
      for (const m of r.mistakes.slice(0, 5)) p.push(`• ${m.text}: ${m.count}× ${ACTION_DE[m.action]} statt ${ACTION_DE[m.best]} (je −${pctTxt(m.lossEach, 2)} des Einsatzes)`);
    }
    p.push('Verlorene Hände zählen nicht automatisch als Fehler – bewertet wird nur die Entscheidung, nicht der Ausgang.');
    if (r.excluded.incomplete || r.excluded.lowConfidence) p.push(`Nicht ausgewertet: ${r.excluded.incomplete} unvollständige Runden, ${r.excluded.lowConfidence} mit unsicherer Erkennung.`);
    return { p, basis: ['Spielarchiv', 'Rechenmodell (Erwartungswert je Entscheidung)'] };
  },

  losses(d) {
    const b = d.bankroll;
    const p = [];
    if (b && b.config.enabled && b.stats.rounds) {
      const c = b.config.currency;
      const s = b.stats;
      p.push(`Echtgeld-Protokoll: ${s.rounds} Runden, gewonnen ${money(s.won, c)}, verloren ${money(s.lost, c)}, netto ${s.net >= 0 ? '+' : ''}${money(s.net, c)}.`);
      p.push(`Saldo ${money(s.balance, c)}, Rückgang zum höchsten Stand ${money(s.drawdown, c)}, längste Verlustserie ${s.longestLossStreak} Runden, durchschnittlicher Einsatz ${s.avgStake != null ? money(s.avgStake, c) : '–'}.`);
      p.push(`Heute netto ${s.today.net >= 0 ? '+' : ''}${money(s.today.net, c)}${b.config.session ? `, laufende Sitzung ${s.session.net >= 0 ? '+' : ''}${money(s.session.net, c)}` : ''}.`);
    } else if (b && b.config.enabled) {
      p.push('Im Echtgeld-Protokoll sind noch keine Runden mit Einsatz und Auszahlung erfasst.');
    } else {
      p.push('Der Echtgeld-Modus ist nicht aktiviert – es sind keine tatsächlichen Geldbeträge erfasst.');
    }
    const sum = summarizeRounds(d.rounds);
    if (sum.netHands) p.push(`Spielarchiv (in Einsatz-Einheiten): ${sum.win} gewonnen, ${sum.loss} verloren, ${sum.push} Push, netto ${sum.net >= 0 ? '+' : ''}${sum.net.toFixed(1)} Einsätze aus ${sum.netHands} Händen.`);
    return { p, basis: ['Echtgeld-Protokoll (nur eingegebene Beträge)', 'Spielarchiv'] };
  },

  version(d) {
    const p = [];
    const pr = d.profile;
    p.push(`Aktives Profil: ${pr.name}${pr.type === 'yumeko' ? ` mit Strategieversion ${pr.version || 0}${pr.version ? '' : ' (Standardstrategie, noch keine eigene Version)'}` : ''}.`);
    const active = d.knowledge.versions.find((v) => v.status === 'aktiv');
    if (active && active.verification) p.push(`Version ${active.number} (${rulesText(active.rules)}): ${Object.keys(active.overrides).length} Abweichungen zur Standardstrategie, Erwartungswert ${pctTxt(active.verification.evVersion, 3)} (Standard ${pctTxt(active.verification.evStandard, 3)}), bestätigt am ${dateDe(active.confirmedAt)}.`);
    const drafts = d.knowledge.versions.filter((v) => v.status === 'entwurf' || v.status === 'geprüft').length;
    if (drafts) p.push(`${drafts} Entwurf/Entwürfe warten auf Prüfung oder Bestätigung.`);
    return { p, basis: ['Strategieprofile', 'Strategieversionen'] };
  },

  why(d) {
    const a = d.lastAdvice;
    if (!a) return { p: ['Gerade gibt es keine Empfehlung. Sobald die Kamera Spieler- und Dealerkarten erkennt, kann ich die Aktion mit Erwartungswerten begründen.'], basis: ['Live-Erkennung'] };
    return { p: [`${a.situation ? `${a.situation}: ` : ''}${a.label}. ${a.explanation}`], basis: ['Rechenmodell (exakte Erwartungswerte)', `aktive Strategie: ${a.source}`] };
  },

  play(d) {
    const p = [];
    const s = d.strategy;
    if (s) {
      if (s.ev < 0) p.push(`Mathematisch: Unter den eingestellten Regeln (${rulesText(d.rules)}) liegt der Erwartungswert deiner aktiven Strategie bei ${pctTxt(s.ev, 2)} pro Einsatz. Das heisst: Auf lange Sicht verlierst du im Schnitt Geld. Wenn es um echtes Geld geht, rate ich davon ab.`);
      else p.push(`Rechnerischer Erwartungswert ${pctTxt(s.ev, 2)} pro Einsatz – auch das garantiert keinen Gewinn.`);
      const bet = d.bankroll && d.bankroll.stats.avgStake;
      if (bet) {
        const o = outlook(s.ev, bet, 100);
        const c = d.bankroll.config.currency;
        p.push(`Bei deinem durchschnittlichen Einsatz von ${money(bet, c)} wären über 100 Runden im Mittel ${money(o.expected, c)} zu erwarten; mit 95 % Wahrscheinlichkeit liegt das Ergebnis zwischen ${money(o.low, c)} und ${money(o.high, c)}.`);
      }
    }
    if (d.bankroll) {
      const risk = assessRisk({ config: d.bankroll.config, stats: d.bankroll.stats, strategy: null });
      if (risk.level === 'stop') p.push(`Risikoprüfung: STOPP. ${risk.messages.filter((m) => m.tone === 'stop').map((m) => m.text).join(' ')}`);
      else if (risk.level === 'off') p.push('Der Echtgeld-Modus ist aus: Ich kenne weder Budget noch Limits. Lege diese fest, bevor du mit echtem Geld spielst.');
      else for (const m of risk.messages.filter((x) => x.tone === 'warn').slice(0, 3)) p.push(`Risikoprüfung: ${m.text}`);
    }
    p.push('Spiel nur mit Geld, dessen Verlust du dir leisten kannst, und versuche nie, Verluste zurückzugewinnen.');
    return { p, basis: ['Rechenmodell (Erwartungswert)', 'Risikoprüfung (Budget, Limits)'] };
  },

  help() {
    return { p: ['Ich beantworte Fragen aus deinen gespeicherten Daten, zum Beispiel:', ...CHAT_EXAMPLES.map((e) => `• ${e}`), 'Es gibt keine Sprachmodell-Anbindung – Antworten werden aus Archiv, Wissensspeicher, Simulationen und Rechenmodell berechnet.'], basis: [] };
  },

  unknown() {
    return { p: ['Diese Frage kann ich ohne Sprachmodell nicht beantworten. Ich verstehe Fragen zu: Gelerntem, Videos, Strategievergleich, Fehlern im Archiv, Verlusten, Strategieversion, Begründung einer Empfehlung und ob du spielen solltest.'], basis: [] };
  }
};
