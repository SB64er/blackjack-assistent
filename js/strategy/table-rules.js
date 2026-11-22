// Tischregeln mit unvollständigen Informationen (Phase 8.8, 0.8.0).
// Reine Logik (ohne DOM) -> testbar.
//
// Entschieden (Benutzer):
//  - Deckanzahl kann "Unbekannt" sein. Die letzte Auswahl wird lokal gespeichert
//    (bjassist.settings → rules.decks / rules.decksUnknown) und bleibt nach Neustart erhalten.
//  - Bei "Unbekannt" wird mit einem dokumentierten Standardprofil gerechnet
//    (UNKNOWN_DECK_PROFILE = 6 Decks) und das sichtbar als Annahme gekennzeichnet.
//
// NOCH OFFEN (Benutzerentscheidung ausstehend) – hier nur technisch vorbereitet:
//  - Automatikmodus für weitere unbekannte Tischregeln (Dealer Soft 17, DAS, Auszahlung).
//  - Empfehlungsvariante bei unbekannten Regeln: "Empfehlung mit Unsicherheitshinweis"
//    oder "Vergleich mehrerer Regelvarianten".
//  Keine dieser Varianten ist aktiv: UNKNOWN_RULES_MODE_DEFAULT = null. Die bestehenden
//  Tischregel-Einstellungen bleiben unverändert und gelten weiterhin als eingestellt.
import { normalizeRules, UNKNOWN_DECK_PROFILE, decksText } from './standard.js';

export { UNKNOWN_DECK_PROFILE };

// Auswahl in den Einstellungen (Reihenfolge wie angezeigt).
export const DECK_CHOICES = Object.freeze(['unbekannt', 1, 2, 4, 6, 8]);
export const DECK_VARIANTS = Object.freeze([1, 2, 4, 6, 8]);

/** Aktuelle Auswahl aus den gespeicherten Tischregeln: 'unbekannt' oder Zahl. */
export function deckChoice(rules) {
  const r = rules || {};
  if (r.decksUnknown === true) return 'unbekannt';
  return DECK_VARIANTS.includes(r.decks) ? r.decks : normalizeRules(r).decks;
}

/**
 * Welche Einstellungen für eine Auswahl gespeichert werden.
 * "Unbekannt": decksUnknown = true, decks = Standardprofil (damit alle bestehenden
 * Berechnungen ohne Sonderfall mit dem dokumentierten Profil rechnen).
 */
export function deckChoicePatch(choice) {
  if (choice === 'unbekannt') return { decks: UNKNOWN_DECK_PROFILE, decksUnknown: true };
  const n = Number(choice);
  if (!DECK_VARIANTS.includes(n)) throw new Error(`Ungültige Deckanzahl: ${choice}`);
  return { decks: n, decksUnknown: false };
}

export function deckChoiceText(choice) {
  if (choice === 'unbekannt') return 'Unbekannt';
  return `${choice} ${Number(choice) === 1 ? 'Deck' : 'Decks'}`;
}

// --- Vorbereitung für weitere unbekannte Regeln (nicht aktiviert) -------------

// Regeln, die einzeln als "bekannt" oder "unbekannt" geführt werden können.
export const RULE_FIELDS = Object.freeze({
  decks: { label: 'Deckanzahl', variants: DECK_VARIANTS },
  soft17: { label: 'Dealer bei Soft 17', variants: ['steht', 'zieht'] },
  das: { label: 'Verdoppeln nach Split', variants: [true, false] },
  payout: { label: 'Blackjack zahlt', variants: ['3:2', '6:5'] }
});

// Mögliche Verhaltensweisen bei unbekannten Regeln – Entscheidung offen.
export const UNKNOWN_RULES_MODES = Object.freeze({
  uncertainty: 'Empfehlung mit Unsicherheitshinweis',
  compare: 'Vergleich mehrerer Regelvarianten'
});
export const UNKNOWN_RULES_MODE_DEFAULT = null; // bewusst keine Festlegung ohne Benutzerentscheidung

/**
 * Welche Regeln sind bekannt, welche angenommen? Heute ist nur die Deckanzahl als
 * "unbekannt" einstellbar; die anderen Regeln gelten als eingestellt (bekannt).
 * @returns {{ rules, known: {field: bool}, unknown: string[], assumptions: string[] }}
 */
export function ruleKnowledge(rules) {
  const r = normalizeRules(rules);
  const known = { decks: !r.decksUnknown, soft17: true, das: true, payout: true };
  const unknown = Object.keys(known).filter((k) => !known[k]);
  const assumptions = [];
  if (r.decksUnknown) {
    assumptions.push(`Deckanzahl unbekannt: gerechnet wird mit dem Standardprofil ${UNKNOWN_DECK_PROFILE} Decks. Das ist eine Annahme, keine Erkennung.`);
  }
  return { rules: r, known, unknown, assumptions, decksLabel: decksText(r) };
}

/**
 * Regelvarianten für unbekannte Felder aufzählen (für einen späteren Vergleich).
 * Bekannte Felder bleiben fest. Begrenzung, damit Berechnungen bezahlbar bleiben.
 */
export function ruleVariants(rules, unknownFields = null, max = 40) {
  const base = normalizeRules(rules);
  const fields = (unknownFields || ruleKnowledge(base).unknown).filter((f) => RULE_FIELDS[f]);
  let list = [{ ...base, decksUnknown: undefined }];
  for (const f of fields) {
    const next = [];
    for (const v of list) for (const val of RULE_FIELDS[f].variants) next.push({ ...v, [f]: val });
    list = next;
  }
  return list.slice(0, max).map((v) => { const x = { ...v }; delete x.decksUnknown; return normalizeRules(x); });
}

/**
 * Vergleich einer Entscheidung über mehrere Regelvarianten (vorbereitet, nicht als Standard aktiv).
 * evaluate(rulesVariant) -> { best, evs } ; liefert, ob alle Varianten dieselbe Aktion ergeben.
 */
export function compareAcrossVariants(variants, evaluate) {
  const rows = variants.map((v) => ({ rules: v, ...evaluate(v) }));
  const bests = new Set(rows.map((r) => r.best).filter(Boolean));
  return { rows, agree: bests.size <= 1, actions: [...bests] };
}
