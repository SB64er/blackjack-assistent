// Testmodus: verfolgt die 7 Prüfschritte von Phase 2.
// Der Fortschritt wird lokal gespeichert, damit nach dem Schliessen und
// erneuten Öffnen der App geprüft werden kann, ob die Kalibrierung bleibt.
import { Emitter } from '../core/events.js';
import { load, save, remove } from '../core/store.js';
import { CameraState } from '../camera/camera-service.js';

const KEY = 'testmode';
const LAUNCH_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const EMPTY = {
  cameraStarted: false,
  monitorConfirmed: false,
  dealerMarked: false,
  playerMarked: false,
  savedAt: null,
  savedLaunchId: null
};

export class TestTracker extends Emitter {
  constructor({ camera, calibration }) {
    super();
    this.camera = camera;
    this.calibration = calibration;
    this.launchId = LAUNCH_ID;
    this.data = { ...EMPTY, ...load(KEY, {}) };

    camera.on('state', (s) => {
      if (s === CameraState.ACTIVE) this._set({ cameraStarted: true });
      else this.emit('change');
    });
    calibration.on('region-edited', ({ id }) => {
      if (id === 'dealerUp' || id === 'dealerHole') this._set({ dealerMarked: true });
      if (id === 'player') this._set({ playerMarked: true });
    });
    calibration.on('saved', (c) => this._set({ savedAt: c.savedAt, savedLaunchId: this.launchId }));
    calibration.on('reset', () => this._set({ savedAt: null, savedLaunchId: null }));
  }

  _set(patch) {
    Object.assign(this.data, patch);
    save(KEY, this.data);
    this.emit('change');
  }

  confirmMonitor() {
    this._set({ monitorConfirmed: true });
  }

  reset() {
    remove(KEY);
    this.data = { ...EMPTY };
    this.emit('change');
  }

  steps() {
    const d = this.data;
    const reopened = !!d.savedLaunchId && d.savedLaunchId !== this.launchId;
    const startup = this.calibration.loadedAtStartup;
    const persisted = reopened && !!startup && startup.savedAt === d.savedAt;
    const cameraOn = this.camera.state === CameraState.ACTIVE;

    return [
      { n: 1, title: 'Kamera starten', done: d.cameraStarted, hint: cameraOn ? 'Kamera läuft.' : 'Tippe unten auf „Kamera starten“.' },
      { n: 2, title: 'PC-Monitor im Kamerabild sehen', done: d.monitorConfirmed, hint: 'Richte das iPhone aus und bestätige.', action: d.monitorConfirmed ? null : 'confirm-monitor' },
      { n: 3, title: 'Dealerkarte markieren (A1/A2)', done: d.dealerMarked, hint: '„Kalibrieren“ tippen und Bereich A1 auf die offene Dealerkarte ziehen.' },
      { n: 4, title: 'Eigene Karten markieren (B)', done: d.playerMarked, hint: 'Bereich B über deine Karten legen – mit Platz für weitere Karten.' },
      { n: 5, title: 'Bereiche speichern', done: !!d.savedAt, hint: '„Kalibrierung speichern“ tippen.' },
      { n: 6, title: 'App schliessen und neu öffnen', done: reopened, hint: 'App im App-Umschalter ganz schliessen, dann über das Home-Bildschirm-Symbol öffnen.' },
      {
        n: 7,
        title: 'Kalibrierung noch vorhanden?',
        done: persisted,
        failed: reopened && !persisted,
        hint: persisted
          ? 'Kalibrierung wurde beim Start automatisch geladen.'
          : (reopened ? 'Nach dem Neustart wurde keine passende Kalibrierung gefunden.' : 'Wird nach dem Neustart automatisch geprüft.')
      }
    ];
  }
}
