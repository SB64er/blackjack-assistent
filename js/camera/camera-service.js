// Kamera-Dienst: Zugriff auf die Rückkamera über getUserMedia.
//
// Datenschutz: Das Bild bleibt im Gerät (kein Upload, keine Aufnahme).
// stop() beendet alle Tracks -> Kamera vollständig freigegeben.
//
// iOS/iPadOS-Besonderheiten (Home-Bildschirm-App), die hier abgefangen werden:
// - Start nur durch direkten Tipp (start() wird synchron im Klick aufgerufen).
// - Keine URL-/Hash-Navigation während die Kamera läuft (stoppt sonst den
//   Stream, WebKit-Bug 215884) – die App navigiert deshalb ohne URL-Änderung.
// - Video liefert manchmal kein Bild (WebKit-Bugs 252465 / 300115):
//   Wächter erkennt fehlende Frames und versucht eine Reparatur.
// - Nach Rückkehr aus dem Hintergrund kann ein neuer Start ohne Tipp
//   scheitern -> Zustand "pausiert", Button "Kamera fortsetzen".
// - Das Video-Element wird nie aus dem Dokument entfernt (Dock).
// - Phase 4: getUserMedia kann in Home-Bildschirm-Apps (v. a. iPad) ohne
//   Fehlermeldung hängen bleiben -> Zeitlimit + "erneut versuchen" per Tipp.
// - Phase 4: Wiedergabe kann ohne Fehlermeldung blockiert sein (schwarzes
//   Bild) -> nächster Tipp irgendwo startet die Wiedergabe (playBlocked).
// - Phase 4: Spur bleibt "stumm" (unterbrochen) -> automatisch neu anfordern.

import { Emitter } from '../core/events.js';

export const CameraState = Object.freeze({
  OFF: 'off',
  STARTING: 'starting',
  ACTIVE: 'active',
  PAUSED: 'paused',            // im Hintergrund gestoppt – Fortsetzen möglich
  INTERRUPTED: 'interrupted',  // z. B. Anruf, Kontrollzentrum
  ERROR: 'error'
});

export const CAMERA_STATE_LABEL = {
  off: 'Kamera aus',
  starting: 'Kamera startet …',
  active: 'Kamera aktiv',
  paused: 'Kamera pausiert',
  interrupted: 'Kamera unterbrochen',
  error: 'Kamerafehler'
};

const NO_FRAME_TIMEOUT_MS = 4000;
const START_TIMEOUT_MS = 10000;     // getUserMedia hängt -> Fehler statt ewig "startet"
const START_SLOW_MS = 3500;         // ab hier darf der Benutzer neu antippen
const INTERRUPTED_REPAIR_MS = 8000; // so lange "stumm" bei sichtbarer App -> neu anfordern
const BLACK_REPAIR_MS = 5000;       // so lange komplett schwarz -> Video neu verbinden

// Promise mit Zeitlimit. Kommt der Stream zu spät, wird er sofort freigegeben.
function withTimeout(promise, ms) {
  let timer;
  let timedOut = false;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => { timedOut = true; reject({ name: 'Timeout', message: `keine Antwort nach ${ms / 1000} s` }); }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        if (timedOut) { try { v.getTracks().forEach((t) => t.stop()); } catch { /* egal */ } return; }
        resolve(v);
      },
      (e) => { clearTimeout(timer); if (!timedOut) reject(e); }
    );
  });
}

export function isStandalone() {
  try {
    return navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches;
  } catch {
    return false;
  }
}

export function isIPad() {
  const ua = navigator.userAgent || '';
  return /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export class CameraService extends Emitter {
  constructor({ fps = 30, keepAwake = true } = {}) {
    super();
    this.state = CameraState.OFF;
    this.stream = null;
    this.error = null;
    this.lastErrorRaw = null;
    this.fps = fps;
    this.keepAwake = keepAwake;
    this.frameCount = 0;
    this.lastFrameAt = 0;
    this.constraintLevel = null;
    this._wakeLock = null;
    this._resumeOnVisible = false;
    this._startToken = 0;
    this._watchdog = null;
    this._repairStep = 0;
    this._lastTime = -1;
    this.playBlocked = false;    // Wiedergabe vom System blockiert -> Tipp nötig
    this.startingSlow = false;   // Start dauert ungewöhnlich lange
    this.startedAt = 0;
    this.startDurationMs = null;
    this.repairs = 0;
    this.brightness = null;      // mittlere Helligkeit 0–255 (Diagnose)
    this._interruptedAt = 0;
    this._blackSince = 0;
    this._slowTimer = null;
    this._probe = null;

    const v = document.createElement('video');
    v.className = 'camera-video';
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('muted', '');
    v.setAttribute('autoplay', '');
    v.setAttribute('aria-label', 'Live-Kamerabild');
    v.muted = true;
    v.playsInline = true;
    v.disablePictureInPicture = true;
    this.video = v;

    // Dock: hält das Video immer im Dokument, wenn keine Ansicht es zeigt.
    this.dockEl = document.createElement('div');
    this.dockEl.className = 'camera-dock';
    this.dockEl.hidden = true;
    this.dockEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.dockEl);
    this.dockEl.appendChild(v);

    const emitDims = () => this.emit('dimensions', this.dimensions());
    v.addEventListener('loadedmetadata', emitDims);
    v.addEventListener('resize', emitDims);
    v.addEventListener('playing', () => {
      emitDims();
      if (this.playBlocked) { this.playBlocked = false; this.emit('playback', true); }
    });
    // Läuft das Video, obwohl es pausiert wurde (z. B. durch Umhängen)? Neu starten.
    v.addEventListener('pause', () => {
      if (this.stream && this.state === CameraState.ACTIVE && !document.hidden) this._play();
    });

    document.addEventListener('visibilitychange', () => this._onVisibilityChange());
    window.addEventListener('pagehide', () => this.stop());
  }

  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  get isRunning() {
    return this.state === CameraState.ACTIVE || this.state === CameraState.STARTING || this.state === CameraState.INTERRUPTED;
  }

  get canResume() {
    return this.state === CameraState.PAUSED;
  }

  dimensions() {
    const { videoWidth: width, videoHeight: height } = this.video;
    return width && height && this.stream ? { width, height } : null;
  }

  info() {
    const track = this.stream && this.stream.getVideoTracks()[0];
    if (!track) return null;
    const s = track.getSettings ? track.getSettings() : {};
    const dims = this.dimensions();
    return {
      width: dims ? dims.width : s.width,
      height: dims ? dims.height : s.height,
      frameRate: s.frameRate ? Math.round(s.frameRate) : this.fps,
      facingMode: s.facingMode || 'unbekannt',
      label: track.label || ''
    };
  }

  // Video in einen Container einer Ansicht hängen.
  attach(container) {
    if (this.video.parentNode !== container) container.appendChild(this.video);
    this.dockEl.hidden = true;
    this._play();
  }

  // Video zurück ins Dock (bleibt im Dokument und läuft weiter).
  dock() {
    if (this.video.parentNode !== this.dockEl) this.dockEl.appendChild(this.video);
    this.dockEl.hidden = !this.isRunning;
    this._play();
  }

  _play() {
    if (!this.stream) return;
    const p = this.video.play();
    if (p && p.catch) {
      p.catch((err) => {
        // NotAllowedError: iOS verlangt einen Tipp für die Wiedergabe.
        // Ohne diese Erkennung bliebe das Bild schwarz – ohne Fehlermeldung.
        if (err && err.name === 'NotAllowedError' && this.stream && !this.playBlocked) {
          this.playBlocked = true;
          this.emit('playback', false);
        }
      });
    }
  }

  // Im Tipp aufrufen: blockierte Wiedergabe freigeben (zählt als Benutzeraktion).
  unblockPlayback() {
    if (!this.stream || !this.video.paused) return false;
    this.video.play().then(() => {
      if (this.playBlocked) { this.playBlocked = false; this.emit('playback', true); }
    }).catch(() => {});
    return true;
  }

  // Kamera komplett neu starten – direkt im Tipp aufrufen.
  restart() {
    this.stop();
    return this.start();
  }

  // WICHTIG: direkt im Klick-Handler aufrufen (Benutzerinteraktion).
  // force: auch während eines hängenden Starts neu beginnen.
  async start({ force = false } = {}) {
    if (this.isRunning && !(force && this.state === CameraState.STARTING)) return;
    if (!window.isSecureContext) return this._fail({ name: 'InsecureContext' });
    if (!CameraService.isSupported()) return this._fail({ name: 'Unsupported' });

    const token = ++this._startToken;
    this.error = null;
    this.playBlocked = false;
    this.startingSlow = false;
    this.startedAt = performance.now();
    this.startDurationMs = null;
    clearTimeout(this._slowTimer);
    this._slowTimer = setTimeout(() => {
      if (token === this._startToken && this.state === CameraState.STARTING) {
        this.startingSlow = true;
        this.emit('state', this.state);
      }
    }, START_SLOW_MS);
    this._setState(CameraState.STARTING);

    let stream = null;
    let lastErr = null;
    // Stufenweise: hohe Qualität -> nur Rückkamera -> irgendeine Kamera.
    for (const level of [0, 1, 2]) {
      try {
        // Der erste Aufruf erfolgt synchron im Klick (keine await davor).
        stream = await withTimeout(navigator.mediaDevices.getUserMedia(this._constraints(level)), START_TIMEOUT_MS);
        this.constraintLevel = level;
        break;
      } catch (err) {
        lastErr = err;
        const retry = err && (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError' || err.name === 'NotReadableError' || err.name === 'AbortError');
        if (!retry || token !== this._startToken) break;
      }
    }

    if (token !== this._startToken) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      return;
    }
    clearTimeout(this._slowTimer);
    this.startingSlow = false;
    if (!stream) return this._fail(lastErr);

    this.startDurationMs = Math.round(performance.now() - this.startedAt);
    this._useStream(stream);
    this._setState(CameraState.ACTIVE);
    this.emit('dimensions', this.dimensions());
    this._requestWakeLock();
    this._startWatchdog();
    // Bildrate nachträglich begrenzen (spart Energie; nicht überall unterstützt).
    this.setFrameRate(this.fps);
  }

  _useStream(stream) {
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.addEventListener('ended', () => this._onTrackEnded(track));
      track.addEventListener('mute', () => {
        if (this.state === CameraState.ACTIVE && this.stream && this.stream.getVideoTracks()[0] === track) {
          this._interruptedAt = performance.now();
          this._setState(CameraState.INTERRUPTED);
        }
      });
      track.addEventListener('unmute', () => {
        if (this.state === CameraState.INTERRUPTED) this._setState(CameraState.ACTIVE);
      });
    }
    this.video.srcObject = stream;
    this.frameCount = 0;
    this.lastFrameAt = performance.now();
    this._lastTime = -1;
    this._blackSince = 0;
    this.brightness = null;
    this._watchFrames();
    this._play();
    if (this.video.parentNode === this.dockEl) this.dockEl.hidden = false;
  }

  // Frames zählen (zeigt, ob wirklich Bilder ankommen).
  _watchFrames() {
    const v = this.video;
    if (typeof v.requestVideoFrameCallback !== 'function') return;
    const stream = this.stream;
    const onFrame = () => {
      if (this.stream !== stream) return;
      // Frames ohne Bildgrösse zählen nicht (iOS meldet sonst "läuft" bei schwarzem Bild).
      if (v.videoWidth > 0) {
        this.frameCount += 1;
        this.lastFrameAt = performance.now();
      }
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._repairStep = 0;
    this._watchdog = setInterval(() => this._checkFrames(), 1000);
  }

  _stopWatchdog() {
    if (this._watchdog) clearInterval(this._watchdog);
    this._watchdog = null;
  }

  // Mittlere Helligkeit eines winzigen Ausschnitts (nur im Arbeitsspeicher).
  _measureBrightness() {
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) return null;
    try {
      if (!this._probe) {
        const canvas = document.createElement('canvas');
        canvas.width = 16; canvas.height = 9;
        this._probe = canvas.getContext('2d', { willReadFrequently: true });
      }
      this._probe.drawImage(v, 0, 0, 16, 9);
      const d = this._probe.getImageData(0, 0, 16, 9).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return Math.round(sum / (d.length / 4) / 3);
    } catch {
      return null;
    }
  }

  async _checkFrames() {
    if (!this.stream || document.hidden) return;
    // Spur bleibt stumm, obwohl die App sichtbar ist -> Kamera neu anfordern.
    if (this.state === CameraState.INTERRUPTED) {
      if (this._interruptedAt && performance.now() - this._interruptedAt > INTERRUPTED_REPAIR_MS) {
        this._interruptedAt = performance.now();
        this._reacquire();
      }
      return;
    }
    if (this.state !== CameraState.ACTIVE) return;
    if (this.video.paused && !this.playBlocked) this._play();

    // Komplett schwarzes Bild (bekannter iOS-Fehler): einmal Video neu verbinden.
    const b = this._measureBrightness();
    this.brightness = b;
    if (b != null && b < 3 && !this.playBlocked) {
      if (!this._blackSince) this._blackSince = performance.now();
      else if (performance.now() - this._blackSince > BLACK_REPAIR_MS) {
        this._blackSince = performance.now() + 60000; // höchstens einmal pro Minute
        this._reattach();
        this.emit('repair', 1);
      }
    } else if (b != null && b >= 3) {
      this._blackSince = 0;
    }

    // Fallback ohne requestVideoFrameCallback: currentTime beobachten.
    const t = this.video.currentTime;
    if (t !== this._lastTime && this.video.videoWidth > 0) {
      this._lastTime = t;
      if (typeof this.video.requestVideoFrameCallback !== 'function') {
        this.frameCount += 1;
        this.lastFrameAt = performance.now();
      }
    }
    const age = performance.now() - this.lastFrameAt;
    if (age < NO_FRAME_TIMEOUT_MS) {
      this._repairStep = 0;
      return;
    }
    this.lastFrameAt = performance.now(); // nächste Prüfung erst nach weiterem Timeout
    this._repairStep += 1;
    if (this._repairStep === 1) {
      // Reparatur 1: Stream neu ans Video hängen.
      this._reattach();
      this.emit('repair', 1);
    } else if (this._repairStep === 2) {
      // Reparatur 2: Kamera einmal komplett neu anfordern (einfachste Einstellung).
      this.emit('repair', 2);
      await this._reacquire();
    } else {
      this._fail({ name: 'NoFrames' });
    }
  }

  _reattach() {
    const s = this.stream;
    if (!s) return;
    this.repairs += 1;
    this.video.srcObject = null;
    this.video.srcObject = s;
    this._watchFrames();
    this._play();
  }

  async _reacquire() {
    if (!this.stream) return;
    this.repairs += 1;
    const token = ++this._startToken;
    this.stream.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
    try {
      const s = await withTimeout(navigator.mediaDevices.getUserMedia(this._constraints(this.constraintLevel ?? 2)), START_TIMEOUT_MS);
      if (token !== this._startToken) { s.getTracks().forEach((tr) => tr.stop()); return; }
      this._useStream(s);
      this._interruptedAt = 0;
      this._setState(CameraState.ACTIVE);
      this.emit('dimensions', this.dimensions());
    } catch (err) {
      if (token === this._startToken) this._fail(err);
    }
  }

  // Kamera vollständig freigeben.
  stop({ resumeLater = false } = {}) {
    this._startToken++;
    this._stopWatchdog();
    clearTimeout(this._slowTimer);
    this.startingSlow = false;
    this.playBlocked = false;
    this._interruptedAt = 0;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try { this.video.pause(); } catch { /* egal */ }
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    this._releaseWakeLock();
    this._resumeOnVisible = resumeLater;
    this.dockEl.hidden = true;
    if (resumeLater) this._setState(CameraState.PAUSED);
    else if (this.state !== CameraState.ERROR) this._setState(CameraState.OFF);
    this.emit('dimensions', null);
  }

  async setFrameRate(fps) {
    this.fps = fps;
    const track = this.stream && this.stream.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ frameRate: { ideal: fps, max: fps } });
    } catch {
      /* nicht jede Kamera unterstützt jede Bildrate */
    }
    this.emit('info', this.info());
  }

  setKeepAwake(on) {
    this.keepAwake = on;
    if (on && this.state === CameraState.ACTIVE) this._requestWakeLock();
    if (!on) this._releaseWakeLock();
  }

  _constraints(level) {
    if (level === 0) {
      return {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: this.fps }
        }
      };
    }
    if (level === 1) return { audio: false, video: { facingMode: { ideal: 'environment' } } };
    return { audio: false, video: true };
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  _fail(err) {
    this.lastErrorRaw = err ? { name: err.name || 'Unknown', message: err.message || '' } : null;
    this.stop();
    this.error = describeCameraError(err);
    this._setState(CameraState.ERROR);
  }

  _onTrackEnded(track) {
    if (!this.stream || this.stream.getVideoTracks()[0] !== track) return;
    if (document.hidden) {
      this.stop({ resumeLater: true });
      return;
    }
    this._fail({ name: 'Ended' });
  }

  _onVisibilityChange() {
    if (document.hidden) {
      if (this.isRunning) this.stop({ resumeLater: true });
      return;
    }
    if (this._resumeOnVisible) {
      this._resumeOnVisible = false;
      // Versuch ohne Tipp. Klappt das nicht (iPadOS verlangt evtl. eine neue
      // Freigabe), bleibt die App im Zustand "pausiert" mit Fortsetzen-Button.
      this._autoResume();
    } else if (this.state === CameraState.ACTIVE) {
      this._requestWakeLock();
    }
  }

  async _autoResume() {
    await this.start();
    if (this.state === CameraState.ERROR && this.error && this.error.code !== 'InsecureContext') {
      this.error = null;
      this._setState(CameraState.PAUSED);
    }
  }

  async _requestWakeLock() {
    if (!this.keepAwake || this._wakeLock || !('wakeLock' in navigator)) return;
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
    } catch {
      this._wakeLock = null;
    }
  }

  _releaseWakeLock() {
    if (this._wakeLock) {
      this._wakeLock.release().catch(() => {});
      this._wakeLock = null;
    }
  }
}

export function describeCameraError(err) {
  const name = (err && err.name) || 'Unknown';
  const homeScreen = isStandalone();
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return {
        code: name,
        title: 'Kamerazugriff verweigert',
        message: homeScreen
          ? 'iPadOS/iOS fragt in Home-Bildschirm-Apps bei jedem Start neu. Tippe auf „Kamera starten“ und dann auf „Erlauben“. Kommt keine Abfrage: Einstellungen › Apps › Safari › Kamera auf „Fragen“ oder „Erlauben“ stellen und die App ganz schliessen und neu öffnen.'
          : 'Tippe auf „aA“ in der Adressleiste › Website-Einstellungen › Kamera › „Erlauben“. Oder: Einstellungen › Apps › Safari › Kamera › „Fragen“/„Erlauben“.'
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { code: name, title: 'Keine Kamera gefunden', message: 'Auf diesem Gerät wurde keine nutzbare Kamera gefunden.' };
    case 'NotReadableError':
    case 'TrackStartError':
      return { code: name, title: 'Kamera ist belegt', message: 'Eine andere App verwendet gerade die Kamera (z. B. FaceTime oder die Kamera-App). Schliesse sie und versuche es erneut.' };
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return { code: name, title: 'Kameraeinstellung nicht unterstützt', message: 'Keine der Kameraeinstellungen wird unterstützt. Bitte erneut versuchen.' };
    case 'AbortError':
      return { code: name, title: 'Kamerastart abgebrochen', message: 'Der Start wurde vom System abgebrochen. Bitte erneut versuchen.' };
    case 'InsecureContext':
      return { code: name, title: 'Kamera nur über HTTPS', message: 'Öffne die App über ihre https://-Adresse. Über http:// erlaubt Safari keinen Kamerazugriff.' };
    case 'Unsupported':
      return {
        code: name,
        title: 'Kamera hier nicht verfügbar',
        message: homeScreen
          ? 'In dieser Home-Bildschirm-App stellt iPadOS keine Kamera bereit. Öffne die Adresse stattdessen direkt in Safari (siehe „Ausweichlösung“ unten).'
          : 'Dieser Browser unterstützt keinen Kamerazugriff. Verwende Safari ab iOS/iPadOS 16.4.'
      };
    case 'Ended':
      return { code: name, title: 'Kamera unterbrochen', message: 'Das System hat die Kamera beendet (z. B. durch einen Anruf oder eine andere App). Tippe auf „Kamera starten“.' };
    case 'Timeout':
      return {
        code: name,
        title: 'Kamera antwortet nicht',
        message: homeScreen
          ? 'iPadOS/iOS hat die Kamera nicht freigegeben (keine Antwort). Tippe auf „Kamera starten“. Hilft das nicht: App im App-Umschalter ganz schliessen und neu öffnen – oder die Ausweichlösung über Safari nutzen.'
          : 'Der Browser hat die Kamera nicht freigegeben (keine Antwort). Tippe erneut auf „Kamera starten“ oder lade die Seite neu.'
      };
    case 'NoFrames':
      return {
        code: name,
        title: 'Kamera liefert kein Bild',
        message: homeScreen
          ? 'Bekannter Fehler von iPadOS/iOS in Home-Bildschirm-Apps: Die Kamera läuft, das Bild kommt aber nicht an. Schliesse die App im App-Umschalter ganz und öffne sie neu. Hilft das nicht, nutze die Ausweichlösung über Safari.'
          : 'Die Kamera liefert keine Bilder. Kamera stoppen und erneut starten.'
      };
    default:
      return { code: name, title: 'Kamera konnte nicht starten', message: `Unerwarteter Fehler (${name}). Bitte erneut versuchen.` };
  }
}
