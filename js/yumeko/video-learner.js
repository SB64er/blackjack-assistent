// YUMEKO – Video lernen.
// Quelle: das bestehende Kamerabild (KEINE zweite Kameraverbindung) oder eine
// Videodatei vom iPad (wird nur lokal abgespielt, nie hochgeladen).
// Ablauf: Einzelbilder auswerten -> sichtbare Karten erkennen (mit den angelernten
// Mustern) -> Szenenwechsel mit Zeitstempeln erkennen -> der Benutzer prüft,
// korrigiert und übernimmt die Lernsequenz bewusst.
//
// Ehrlich gekennzeichnet:
//  - Kartenerkennung: verfügbar, soweit die angelernten Muster passen (Bildschirm-
//    aufnahmen sind oft schlechter erkennbar -> Unsicheres wird markiert).
//  - Texterkennung (OCR), Sprachtranskription, KI-Interpretation: noch nicht
//    verfügbar. Es werden keine Texte oder Transkripte erfunden.
import { valueClass, rankValue } from '../game/hand.js';

export const VIDEO_FEATURES = [
  { id: 'cards', label: 'Spielkarten im Bild erkennen', status: 'verfügbar', note: 'Nutzt deine angelernten Kartenmuster. Bei Videos auf einem Bildschirm kann die Erkennung unsicherer sein.' },
  { id: 'scenes', label: 'Szenenwechsel mit Zeitstempeln', status: 'verfügbar', note: 'Neue Szene, sobald sich die sichtbaren Karten stabil ändern.' },
  { id: 'correct', label: 'Erkennungen korrigieren und Aktion zuordnen', status: 'verfügbar', note: 'Kartenwert, Dealer/Spieler und gezeigte Aktion von Hand festlegen.' },
  { id: 'file', label: 'Videodatei vom iPad importieren', status: 'verfügbar', note: 'Die Datei bleibt auf dem Gerät und wird nicht hochgeladen.' },
  { id: 'actions', label: 'Spielaktionen aus Kartenänderungen vorschlagen', status: 'verfügbar', note: 'Neue Spielerkarte = Ziehen, neue Dealerkarten bei gleicher Spielerhand = Stehen. Nur Vorschlag – bitte prüfen (Verdoppeln/Split sind nicht sicher erkennbar).' },
  { id: 'ocr', label: 'Eingeblendete Texte lesen (OCR)', status: 'Noch nicht verfügbar', note: 'Safari auf dem iPad bietet keinen lokalen Texterkenner. Wird automatisch genutzt, falls der Browser einen eingebauten Texterkenner (TextDetector) hat – ohne Upload.' },
  { id: 'speech', label: 'Gesprochene Erklärungen transkribieren', status: 'Noch nicht verfügbar', note: 'Der Ton eines Videos kann im Browser nicht lokal in Text umgewandelt werden.' },
  { id: 'ai', label: 'KI-Interpretation strategischer Zusammenhänge', status: 'Noch nicht verfügbar', note: 'Bräuchte einen eigenen Server mit KI-Dienst. Kamerabilder würden nur nach ausdrücklicher Zustimmung gesendet – derzeit wird nichts gesendet.' }
];

export const UNSURE_SCORE = 0.8;

/** Ist ein lokaler Texterkenner im Browser vorhanden? (Shape Detection API, kein Upload) */
export function textDetectorAvailable(g = globalThis) {
  return typeof g.TextDetector === 'function';
}

/** Funktionsliste mit dem tatsächlichen Stand dieses Geräts. */
export function videoFeatures(g = globalThis) {
  return VIDEO_FEATURES.map((f) => (f.id === 'ocr' && textDetectorAvailable(g)
    ? { ...f, status: 'verfügbar', note: 'Lokaler Texterkenner dieses Browsers (ohne Upload). Erkannte Texte werden zur Prüfung angezeigt.' }
    : f));
}

/** Welche Videoformate kann dieser Browser abspielen (und damit auswerten)? */
export function supportedVideoFormats(video) {
  if (!video || typeof video.canPlayType !== 'function') return [];
  const list = [['MP4 (H.264)', 'video/mp4; codecs="avc1.42E01E"'], ['MOV (iPhone/iPad)', 'video/quicktime'], ['MP4 (HEVC)', 'video/mp4; codecs="hvc1"'], ['WebM', 'video/webm']];
  return list.filter(([, t]) => video.canPlayType(t)).map(([n]) => n);
}

const ranks = (cards, role) => cards.filter((c) => c.role === role).map((c) => c.rank);
function isExtension(a, b) {
  // b enthält alle Karten von a (Wertklassen) und genau eine mehr
  if (b.length !== a.length + 1) return false;
  const rest = b.map(valueClass);
  for (const r of a.map(valueClass)) {
    const i = rest.indexOf(r);
    if (i < 0) return false;
    rest.splice(i, 1);
  }
  return true;
}
const sameSet = (a, b) => a.length === b.length && a.map(valueClass).sort().join() === b.map(valueClass).sort().join();
const handTotal = (list) => {
  let t = 0; let aces = 0;
  for (const r of list) { const v = rankValue(r); t += v; if (v === 11) aces += 1; }
  while (t > 21 && aces) { t -= 10; aces -= 1; }
  return t;
};

/**
 * Spielaktionen aus der Abfolge der Szenen VORSCHLAGEN (nie stillschweigend festlegen):
 *  - nächste Szene hat genau eine Spielerkarte mehr, Dealer unverändert -> Ziehen
 *  - Spielerhand unverändert, Dealer bekommt Karten                    -> Stehen
 * Vorhandene (vom Benutzer gewählte) Aktionen bleiben unverändert. Reine Logik.
 */
export function inferActions(scenes) {
  for (let i = 0; i < scenes.length - 1; i++) {
    const a = scenes[i];
    const b = scenes[i + 1];
    if (a.action) continue;
    const pa = ranks(a.cards, 'player');
    const pb = ranks(b.cards, 'player');
    const da = ranks(a.cards, 'dealer');
    const db = ranks(b.cards, 'dealer');
    if (pa.length < 2 || !da.length || handTotal(pa) >= 21) continue;
    let act = null;
    if (isExtension(pa, pb) && sameSet(da, db)) act = 'HIT';
    else if (sameSet(pa, pb) && db.length > da.length) act = 'STAND';
    if (act) { a.action = act; a.actionSuggested = true; }
  }
  return scenes;
}

const sig = (cards) => cards.map((c) => valueClass(c.rank)).sort().join('.');

/** Erkennt stabile Szenen in einer Folge von Bildauswertungen. Reine Logik. */
export class SceneDetector {
  constructor({ stableFrames = 2, maxScenes = 200 } = {}) {
    this.stableFrames = stableFrames;
    this.maxScenes = maxScenes;
    this.scenes = [];
    this._cand = null;     // { sig, t0, count, cards }
    this._current = null;  // laufende Szene
  }

  /**
   * @param {Array<{rank, score, box}>} cards – erkannte Karten eines Bildes
   * @param {number} t – Zeit in Sekunden (Videozeit bzw. seit Beginn)
   */
  push(cards, t) {
    const list = (cards || []).filter((c) => c && c.rank);
    const s = sig(list);
    if (!list.length) {
      this._close(t);
      this._cand = null;
      return null;
    }
    if (this._current && this._current.sig === s) {
      this._current.t1 = t;
      this._current.cards = mapCards(list);
      this._cand = null;
      return null;
    }
    if (!this._cand || this._cand.sig !== s) this._cand = { sig: s, t0: t, count: 0 };
    this._cand.count += 1;
    if (this._cand.count >= this.stableFrames) {
      this._close(t);
      if (this.scenes.length >= this.maxScenes) return null;
      this._current = { sig: s, t0: this._cand.t0, t1: t, cards: mapCards(list) };
      this.scenes.push(this._current);
      this._cand = null;
      return this._current;
    }
    return null;
  }

  _close(t) {
    if (this._current) { this._current.t1 = Math.max(this._current.t1, t); this._current = null; }
  }

  finish(t) {
    this._close(t);
    return this.scenes.map((sc) => ({
      t0: sc.t0,
      t1: sc.t1,
      cards: sc.cards,
      unsure: sc.cards.some((c) => c.unsure),
      action: null,
      corrected: false
    }));
  }
}

function mapCards(list) {
  return list.map((c) => {
    const b = c.box || { x: 0, y: 0, w: 0, h: 0 };
    const y = b.y + b.h / 2;
    return {
      rank: c.rank,
      score: typeof c.score === 'number' ? c.score : null,
      unsure: typeof c.score === 'number' ? c.score < UNSURE_SCORE : true,
      x: b.x + b.w / 2,
      y,
      role: y < 0.5 ? 'dealer' : 'player' // Vorschlag – vom Benutzer änderbar
    };
  }).sort((a, b) => (a.role === b.role ? a.x - b.x : (a.role === 'dealer' ? -1 : 1)));
}

/** Für die Videoerkennung: Muster ohne Grössenbezug zum Casino-Kamerabild. */
export function scaleFreeTemplates(items) {
  return items.map((t) => ({ ...t, hRel: null }));
}

export function newSequenceId() {
  return `vid_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
