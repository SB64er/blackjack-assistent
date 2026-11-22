// App-Einstellungen, lokal gespeichert.
import { load, save } from './store.js';
import { Emitter } from './events.js';

export const DEFAULT_SETTINGS = Object.freeze({
  roundMode: 'manuell',        // 'manuell' | 'automatisch'
  speech: true,                // Sprachausgabe (Ansage folgt in späterer Phase)
  demo: true,                  // Demo-Modus mit simulierten Karten
  rules: {
    decks: 6,
    // 0.8.0: Deckanzahl "Unbekannt". Dann rechnet die App mit dem dokumentierten
    // Standardprofil (6 Decks) und kennzeichnet das als Annahme.
    decksUnknown: false,
    soft17: 'steht',           // 'steht' | 'zieht'
    das: true,                 // Verdoppeln nach Split
    // surrender (Aufgeben) gibt es ab 0.6.0 nicht mehr; ein alter Wert bleibt
    // im Speicher unberührt, wird aber nicht mehr verwendet.
    payout: '3:2'              // '3:2' | '6:5'
  },
  camera: {
    fps: 30,                   // 30 = flüssig, 15 = stromsparend
    keepAwake: true            // Bildschirm wach halten, solange die Kamera läuft
  },
  recognition: {
    fps: 4,                    // Auswertungen pro Sekunde (2 = stromsparend)
    showBoxes: true            // erkannte Zeichen im Kamerabild markieren
  }
});

function merge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!extra || typeof extra !== 'object') return out;
  for (const key of Object.keys(base)) {
    if (!(key in extra)) continue;
    const b = base[key];
    const e = extra[key];
    if (b && typeof b === 'object' && !Array.isArray(b)) out[key] = merge(b, e);
    else if (typeof e === typeof b) out[key] = e;
  }
  return out;
}

class Settings extends Emitter {
  constructor() {
    super();
    this.data = merge(DEFAULT_SETTINGS, load('settings', {}));
  }

  get(path) {
    return path.split('.').reduce((obj, k) => (obj == null ? undefined : obj[k]), this.data);
  }

  set(path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let target = this.data;
    for (const k of keys) target = target[k];
    if (target[last] === value) return;
    target[last] = value;
    save('settings', this.data);
    this.emit('change', { path, value });
  }
}

export const settings = new Settings();
