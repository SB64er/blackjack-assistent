// Mathematische Prüfung erkannter Aussagen (Phase 8.2/8.5). Reine Logik -> testbar.
//
// Jede Spielaussage ("16 gegen 10: Ziehen") wird zweifach nachgerechnet:
//  1. Rechenmodell mit unendlich vielen Decks (ev.js) – Grundlage üblicher Strategietabellen.
//  2. Exakte Engine mit endlichem Schuh (exact.js) für eine typische Kartenkombination
//     (z. B. Hart 16 = 10+6) bei der eingestellten Deckanzahl; bei unbekannter Deckanzahl
//     zusätzlich bei 1 und 8 Decks.
// Ergebnis: bestätigt, widerlegt, teilweise (hängt von Decks/Karten ab) oder nicht überprüfbar.
// Ungeprüfte oder widerlegte Aussagen verändern die Strategie nie (siehe academy-store.js).
import { modelFor, strategyEV, profilePolicy } from '../strategy/ev.js';
import { analyzeHand, insuranceEV, dealerBustChance, ACT_LABEL } from '../strategy/exact.js';
import { normalizeRules, UNKNOWN_DECK_PROFILE } from '../strategy/standard.js';
import { claimText } from './extract.js';

export const TOLERANCE = 0.0005;          // bis 0,05 % des Einsatzes gelten zwei Aktionen als gleichwertig
export const BUST_TOLERANCE = 0.025;      // ±2,5 Prozentpunkte für genannte Überkauf-Wahrscheinlichkeiten
export const EDGE_TOLERANCE = 0.003;      // ±0,3 Prozentpunkte für einen genannten Hausvorteil

export const VERDICT = {
  confirmed: 'Mathematisch bestätigt',
  contradicted: 'Mathematisch widerlegt',
  partial: 'Teilweise bestätigt',
  unverifiable: 'Nicht überprüfbar'
};

const HARD_COMBOS = { 5: [2, 3], 6: [2, 4], 7: [2, 5], 8: [3, 5], 9: [4, 5], 10: [4, 6], 11: [5, 6], 20: [10, 10], 21: [10, 5, 6] };

/** Typische Kartenkombination einer Tabellenzelle (für die exakte Rechnung). */
export function representativeCards(kind, value) {
  if (kind === 'pair') return [value, value];
  if (kind === 'soft') return value === 21 ? [11, 5, 5] : [11, value - 11];
  return HARD_COMBOS[value] || [10, value - 10];
}

function modelEVs(cell, rules, withSurrender) {
  const m = modelFor(cell.up, rules);
  const evs = { ...m.cellEVs(cell.kind, cell.value) };
  if (cell.kind !== 'pair' && cell.value === 21) delete evs.DOUBLE;
  if (withSurrender) evs.SURRENDER = -0.5;
  return evs;
}

function judge(evs, action, negated) {
  const best = Object.keys(evs).reduce((a, b) => (evs[b] > evs[a] + 1e-12 ? b : a));
  if (evs[action] == null) return { best, loss: null, ok: negated, note: `${ACT_LABEL[action]} ist hier nicht möglich.` };
  const loss = evs[best] - evs[action];
  const equal = loss <= TOLERANCE;
  return { best, loss, ok: negated ? !equal : equal };
}

const deckSet = (r) => (r.decksUnknown ? [1, UNKNOWN_DECK_PROFILE, 8] : [r.decks]);

/** Eine Zelle prüfen. */
export function verifyCell(cell, action, negated, rules) {
  const r = normalizeRules(rules);
  const surrender = action === 'SURRENDER';
  const inf = judge(modelEVs(cell, r, surrender), action, negated);
  const finite = [];
  for (const d of deckSet(r)) {
    const a = analyzeHand({ player: representativeCards(cell.kind, cell.value), up: cell.up, rules: { ...r, decks: d, decksUnknown: false, surrender: surrender ? 'spaet' : 'keine' }, compareDecks: false });
    if (!a.ok || !a.best) continue;
    const evs = { ...a.evs };
    if (cell.kind !== 'pair') delete evs.SPLIT;
    finite.push({ decks: d, ...judge(evs, action, negated) });
  }
  const all = [inf, ...finite];
  const okCount = all.filter((x) => x.ok).length;
  const verdict = okCount === all.length ? 'confirmed' : (okCount === 0 ? 'contradicted' : 'partial');
  return { cell, verdict, infinite: inf, finite };
}

const num = (x, d = 1) => x.toFixed(d).replace('.', ',');
const decksDe = (n) => `${n} ${n === 1 ? 'Deck' : 'Decks'}`;

const tick = () => new Promise((res) => setTimeout(res, 0));

/**
 * Aussage prüfen. rules: Tischregeln der App (inkl. decksUnknown).
 * @returns {Promise<{ verdict, text, method, details[], cells?, at, rules }>}
 */
export async function verifyClaim(claim, rules, { yieldEvery = 4 } = {}) {
  const r = normalizeRules(rules);
  const at = new Date().toISOString();
  const base = { at, rules: r, text: claimText(claim) };
  if (claim.type === 'play') {
    const cells = [];
    let i = 0;
    for (const c of claim.cells) {
      cells.push(verifyCell(c, claim.action, !!claim.negated, r));
      if (++i % yieldEvery === 0) await tick();
    }
    const counts = { confirmed: 0, contradicted: 0, partial: 0 };
    for (const c of cells) counts[c.verdict] += 1;
    let verdict = 'partial';
    if (counts.confirmed === cells.length) verdict = 'confirmed';
    else if (counts.contradicted === cells.length) verdict = 'contradicted';
    const details = [];
    const bad = cells.filter((c) => c.verdict !== 'confirmed');
    for (const c of bad.slice(0, 6)) {
      const u = c.cell.up === 11 ? 'Ass' : c.cell.up;
      const f = c.finite.map((x) => `${x.decks} D: besser ${ACT_LABEL[x.best]}${x.loss != null && x.loss > 0 ? ` (−${num(x.loss * 100, 2)} %)` : ''}`).join(', ');
      details.push(`Gegen ${u}: Rechenmodell ${ACT_LABEL[c.infinite.best]}${c.infinite.loss > 0 ? ` (Aussage −${num(c.infinite.loss * 100, 2)} %)` : ''}; ${f}.`);
    }
    if (bad.length > 6) details.push(`… und ${bad.length - 6} weitere Fälle.`);
    if (verdict === 'confirmed') details.push(`${cells.length} ${cells.length === 1 ? 'Fall' : 'Fälle'} geprüft: die genannte Aktion ist jeweils die beste (Toleranz ${num(TOLERANCE * 100, 2)} %).`);
    if (claim.action === 'SURRENDER') details.push('Geprüft unter der Annahme, dass spätes Aufgeben erlaubt ist. Die Live-Empfehlung der App bietet Aufgeben nicht an.');
    if (r.decksUnknown) details.push(`Deckanzahl unbekannt: geprüft mit 1, ${UNKNOWN_DECK_PROFILE} und 8 Decks.`);
    return { ...base, verdict, cells: cells.map(compactCell), counts, details, method: 'Erwartungswerte: Rechenmodell (unendliches Deck) und exakte Rechnung mit endlichem Schuh für eine typische Kartenkombination.' };
  }
  if (claim.type === 'insurance') {
    const decks = r.decks;
    const e = insuranceEV({ player: [10, 7], decks });
    return {
      ...base,
      verdict: e.ev < 0 ? 'confirmed' : 'contradicted',
      details: [`Versicherung gegen Ass (${decksDe(decks)}, Spieler 10+7): Erwartungswert ${num(e.ev * 100)} % pro versicherter Einheit (Zehnerwert-Wahrscheinlichkeit ${num(e.pTen * 100)} %).`, 'Ohne Kartenzählen ist die Versicherung auf Dauer ein Verlustgeschäft.'],
      method: 'Exakte Wahrscheinlichkeit einer Zehnerwert-Karte als verdeckte Dealerkarte.'
    };
  }
  if (claim.type === 'probability' && claim.metric === 'dealerBust') {
    const b = dealerBustChance(claim.up, { ...r, decks: r.decks });
    const uncond = b.bust * (1 - b.pBJ);
    const diff = Math.min(Math.abs(claim.value - b.bust), Math.abs(claim.value - uncond));
    return {
      ...base,
      verdict: diff <= BUST_TOLERANCE ? 'confirmed' : 'contradicted',
      details: [`Berechnet (${decksDe(r.decks)}${r.decksUnknown ? ' – Annahme' : ''}, ${r.soft17 === 'zieht' ? 'H17' : 'S17'}): ${num(b.bust * 100)} %${b.pBJ ? ` ohne Dealer-Blackjack, ${num(uncond * 100)} % insgesamt` : ''}. Genannt: ${num(claim.value * 100)} % (Toleranz ±${num(BUST_TOLERANCE * 100)} Prozentpunkte).`],
      method: 'Exakte Verteilung der Dealer-Endwerte mit endlichem Schuh.'
    };
  }
  if (claim.type === 'houseEdge') {
    const ev = strategyEV(r, profilePolicy(null, r, r)).ev;
    const edge = -ev;
    const ok = Math.abs(edge - claim.value) <= EDGE_TOLERANCE;
    return {
      ...base,
      verdict: ok ? 'confirmed' : 'partial',
      details: [`Berechnet für deine Tischregeln (Rechenmodell, Standardstrategie): ${num(edge * 100, 2)} %. Genannt: ${num(claim.value * 100, 2)} %.`, 'Der Hausvorteil hängt stark von den Tischregeln ab, die im Video oft nicht vollständig genannt werden.'],
      method: 'Gesamterwartungswert der Standardstrategie im Rechenmodell.'
    };
  }
  if (claim.type === 'rule') {
    const mine = claim.rule === 'decks' ? (r.decksUnknown ? null : r.decks) : r[claim.rule];
    const same = mine != null && mine === claim.value;
    return {
      ...base,
      verdict: 'unverifiable',
      details: [
        'Tischregel aus dem Video – eine Regel lässt sich nicht mathematisch beweisen, sie gilt nur für den gezeigten Tisch.',
        claim.rule === 'surrender' ? 'Deine Einstellungen bieten kein Aufgeben an (seit 0.6.0).' : (mine == null ? 'In deinen Einstellungen ist dieser Wert unbekannt.' : `Deine Einstellung: ${same ? 'stimmt überein' : 'weicht ab'}.`)
      ],
      method: 'Keine Berechnung (Regelinformation).'
    };
  }
  return { ...base, verdict: 'unverifiable', details: ['Diese Aussage lässt sich nicht berechnen.'], method: 'Keine Berechnung.' };
}

function compactCell(c) {
  return {
    kind: c.cell.kind, value: c.cell.value, up: c.cell.up, verdict: c.verdict,
    best: c.infinite.best, loss: c.infinite.loss,
    finite: c.finite.map((x) => ({ decks: x.decks, best: x.best, loss: x.loss }))
  };
}
