// Yumeko-Lernzentrum (ab 0.10.0) – Grundgerüst.
// Reine Logik ohne DOM -> testbar. Enthält bewusst KEINE KI, keine Lernalgorithmen
// und keine Strategien: Yumeko wird später Schritt für Schritt entwickelt.
//
// - Statistik: Hände aus dem Spielarchiv, die mit aktivem Yumeko-Profil gespielt wurden.
//   Bust (eigene Hand über 21) wird getrennt von "Lose" gezählt.
// - Ein-/Ausschalten: Yumeko-Profil in den Strategieprofilen aktivieren; beim Ausschalten
//   wird das vorher aktive Profil wieder aktiv (gemerkt in "bjassist.lernzentrum").
import { totals } from '../game/settle.js';
import { YUMEKO_ID } from '../strategy/profiles.js';
import { load, save } from '../core/store.js';

export const LERNZENTRUM_KEY = 'lernzentrum';

/** Statistik der mit dem Yumeko-Profil gespielten Hände. */
export function yumekoStats(rounds, profileId = YUMEKO_ID) {
  const s = { hands: 0, win: 0, loss: 0, bust: 0, push: 0 };
  for (const r of rounds || []) {
    if (!r || !r.profile || r.profile.id !== profileId) continue;
    for (const h of r.hands || []) {
      if (h.outcome === 'win') s.win += 1;
      else if (h.outcome === 'push') s.push += 1;
      else if (h.outcome === 'loss' || h.outcome === 'surrender') {
        if (h.cards && h.cards.length && totals(h.cards).bust) s.bust += 1;
        else s.loss += 1;
      } else continue; // offenes Ergebnis zählt (noch) nicht
      s.hands += 1;
    }
  }
  return s;
}

export function percentText(n, total) {
  return total ? `${Math.round((n / total) * 100)} %` : '– %';
}

/** Die vier Bereiche des Lernzentrums (vorerst nur Beschreibung, Inhalt folgt). */
export const AREAS = [
  {
    id: 'karten', title: 'Karten', color: '#60A5FA', tint: 'rgba(96,165,250,0.12)',
    text: 'Hier lernt Yumeko später jede einzelne Karte, jeden Kartenwert und jede mögliche Kartenkombination im Blackjack.',
    points: ['Alle Karten von 2 bis Ass', 'Die Werte der Karten', 'Zahlenkarten, Bildkarten und Ass', 'Alle möglichen Handkombinationen', 'Harte und weiche Hände']
  },
  {
    id: 'table', title: 'AI Table', color: '#34D399', tint: 'rgba(52,211,153,0.12)',
    text: 'Hier spielt Yumeko später virtuell Blackjack – zum Üben und Trainieren.',
    points: ['Kein Echtgeld', 'Simuliertes Geld (Sim-Geld)', 'Virtueller Tisch', 'Spiel gegen einen KI-Dealer']
  },
  {
    id: 'study', title: 'Study', color: '#A78BFA', tint: 'rgba(167,139,250,0.12)',
    text: 'Hier stellst du Yumeko später Inhalte bereit, aus denen sie lernt.',
    points: ['YouTube-Links', 'Videos', 'Dokumente', 'Eventuell weitere Lernquellen']
  },
  {
    id: 'brain', title: 'Brain', color: '#F472B6', tint: 'rgba(244,114,182,0.12)',
    text: 'Hier siehst du später Yumekos Wissen und kannst nachvollziehen, wie weit sie ist.',
    points: ['Sehen, was sie gelernt hat', 'Sehen, was sie gespeichert hat', 'Ihr Wissen einsehen', 'Nachvollziehen, wie weit sie ist']
  }
];

export const PROFILE_PANEL = {
  id: 'profil', title: 'Yumeko Profil', color: '#A78BFA',
  text: 'Schlichte Übersicht über Yumekos aktuellen Stand.',
  points: ['Aktuell verwendete Strategie', 'Kurze Zusammenfassung des Lernstands']
};

/** Yumeko ein-/ausschalten. storage austauschbar (Tests). */
export function toggleYumeko(profiles, storage = { load, save }) {
  if (profiles.yumekoActive) {
    const st = storage.load(LERNZENTRUM_KEY, {}) || {};
    return { active: false, profile: profiles.deactivateYumeko(st.previousProfileId) };
  }
  const previous = profiles.activateYumeko();
  const st = storage.load(LERNZENTRUM_KEY, {}) || {};
  storage.save(LERNZENTRUM_KEY, { ...st, previousProfileId: previous });
  return { active: true, profile: profiles.active };
}
