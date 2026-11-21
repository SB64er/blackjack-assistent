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
    if (this.stream) this.video.play().catch(() => {});
  }

  // WICHTIG: direkt im Klick-Handler aufrufen (Benutzerinteraktion).
  async start() {
    if (this.isRunning) return;
    if (!window.isSecureContext) return this._fail({ name: 'InsecureContext' });
    if (!CameraService.isSupported()) return this._fail({ name: 'Unsupported' });

    const token = ++this._startToken;
    this.error = null;
    this._setState(CameraState.STARTING);

    let stream = null;
    let lastErr = null;
    // Stufenweise: hohe Qualität -> nur Rückkamera -> irgendeine Kamera.
    for (const level of [0, 1, 2]) {
      try {
        // Der erste Aufruf erfolgt synchron im Klick (keine await davor).
        stream = await navigator.mediaDevices.getUserMedia(this._constraints(level));
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
    if (!stream) return this._fail(lastErr);

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
        if (this.state === CameraState.ACTIVE && this.stream && this.stream.getVideoTracks()[0] === track) this._setState(CameraState.INTERRUPTED);
      });
      track.addEventListener('unmute', () => {
        if (this.state === CameraState.INTERRUPTED) this._setState(CameraState.ACTIVE);
      });
    }
    this.video.srcObject = stream;
    this.frameCount = 0;
    this.lastFrameAt = performance.now();
    this._lastTime = -1;
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
      this.frameCount += 1;
      this.lastFrameAt = performance.now();
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

  async _checkFrames() {
    if (!this.stream || document.hidden) return;
    if (this.state !== CameraState.ACTIVE) return;
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
      const s = this.stream;
      this.video.srcObject = null;
      this.video.srcObject = s;
      this._watchFrames();
      this._play();
      this.emit('repair', 1);
    } else if (this._repairStep === 2) {
      // Reparatur 2: Kamera einmal komplett neu anfordern (einfachste Einstellung).
      this.emit('repair', 2);
      const token = ++this._startToken;
      this.stream.getTracks().forEach((tr) => tr.stop());
      this.stream = null;
      try {
        const s = await navigator.mediaDevices.getUserMedia(this._constraints(2));
        if (token !== this._startToken) { s.getTracks().forEach((tr) => tr.stop()); return; }
        this._useStream(s);
        this.constraintLevel = 2;
      } catch (err) {
        if (token === this._startToken) this._fail(err);
      }
    } else {
      this._fail({ name: 'NoFrames' });
    }
  }

  // Kamera vollständig freigeben.
  stop({ resumeLater = false } = {}) {
    this._startToken++;
    this._stopWatchdog();
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
