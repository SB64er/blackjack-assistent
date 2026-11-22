// YUMEKO → Video lernen.
// Kamera: nutzt die BESTEHENDE Kameraverbindung (keine zweite getUserMedia-Anfrage).
// Videodatei: wird lokal abgespielt und ausgewertet, nie hochgeladen.
// Die Live-Erkennung der Spielrunden ist währenddessen angehalten, damit aus
// Lehrvideos keine Archivrunden entstehen.
import { View, subHeader, cameraButton, playbackButton } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { CameraState } from '../camera/camera-service.js';
import { analyzeRegion } from '../recognition/analyzer.js';
import { RANKS } from '../game/hand.js';
import { SceneDetector, videoFeatures, scaleFreeTemplates, newSequenceId, UNSURE_SCORE, inferActions, textDetectorAvailable, supportedVideoFormats } from '../yumeko/video-learner.js';

const MAX_SIDE = 960;
const SAMPLE_MS = 500;      // Kamera: 2 Bilder pro Sekunde
const SEEK_STEP = 0.5;      // Datei: alle 0,5 Sekunden
const ACTIONS = [['', 'Aktion unbekannt'], ['HIT', 'Ziehen'], ['STAND', 'Stehen'], ['DOUBLE', 'Verdoppeln'], ['SPLIT', 'Splitten']];

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function overlap(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.max(1e-9, Math.min(a.w * a.h, b.w * b.h));
}

export class VideoView extends View {
  get hostsCamera() {
    return this.source === 'camera';
  }

  mount() {
    const { camera, recognition } = this.ctx;
    this.source = 'camera';
    this.scenes = [];
    this.recording = false;
    this.scanning = false;
    this.progress = 0;
    this.fileName = null;
    this._notice = null;
    this._sheet = null;
    this._canvas = document.createElement('canvas');
    this._c2d = this._canvas.getContext('2d', { willReadFrequently: true });
    recognition.pause('video');
    this.el.className = 'screen screen-sub';
    this.el.innerHTML = `
      ${subHeader('YUMEKO – Video lernen', 'yumeko')}
      <div class="sub-content">
        <p class="lead">Spiele ein Blackjack-Lehrvideo auf einem anderen Bildschirm ab und halte ihn vor die Kamera – oder wähle eine Videodatei vom iPad. YUMEKO erkennt sichtbare Karten und Szenenwechsel. Du prüfst, korrigierst und übernimmst die Lernsequenz.</p>
        <div class="segmented" role="group" aria-label="Quelle" data-slot="source"></div>
        <div class="camera-stage video-stage" data-slot="stage">
          <div class="stage-placeholder" data-slot="placeholder"><strong>Kameravorschau</strong><span>Kamera starten, um ein Video abzufilmen.</span></div>
          <div class="stage-play" data-slot="play"></div>
        </div>
        <video class="file-video" data-slot="file-video" playsinline muted controls hidden></video>
        <div data-slot="controls"></div>
        <div data-slot="scenes"></div>
        <section class="group">
          <h2 class="group-title">FUNKTIONEN</h2>
          <ul class="feature-list">${videoFeatures().map((f) => `<li class="${f.status === 'verfügbar' ? 'is-ok' : 'is-missing'}"><b>${esc(f.label)}</b><span class="feature-status">${esc(f.status)}</span><small>${esc(f.note)}</small></li>`).join('')}</ul>
          <p class="hint" data-slot="formats"></p>
          <p class="hint">Datenschutz: Bilder werden nur im Arbeitsspeicher ausgewertet – nicht gespeichert und an niemanden gesendet. Gespeichert werden nur die übernommenen Kartenwerte und Zeitstempel.</p>
        </section>
      </div>
      <div class="sheet-backdrop" data-slot="sheet" hidden></div>
      <input type="file" accept="video/*" data-slot="file" hidden>`;
    this.stage = this.el.querySelector('[data-slot="stage"]');
    this.fileVideo = this.el.querySelector('[data-slot="file-video"]');
    const fmts = supportedVideoFormats(this.fileVideo);
    this.el.querySelector('[data-slot="formats"]').textContent = `Unterstützte Videoformate in diesem Browser: ${fmts.length ? fmts.join(', ') : 'unbekannt'}. Ausgewertet wird, was der Browser abspielen kann.`;
    this.texts = [];
    this._textAt = -10;
    camera.attach(this.stage);
    this.el.addEventListener('click', (e) => this._onClick(e));
    this.el.addEventListener('change', (e) => this._onChange(e));
    this.el.querySelector('[data-slot="file"]').addEventListener('change', (e) => this._loadFile(e.target.files && e.target.files[0]));
    const u = () => this.render();
    this.listen(camera, 'state', u);
    this.listen(camera, 'playback', u);
    this.listen(this.ctx.templates, 'change', u);
    this.render();
  }

  destroy() {
    super.destroy();
    this._stopRecording();
    this.scanning = false;
    if (this._fileUrl) URL.revokeObjectURL(this._fileUrl);
    this.ctx.recognition.resume();
  }

  _say(tone, text) { this._notice = { tone, text }; }

  // --- Bildauswertung -------------------------------------------------------
  _analyze(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return [];
    const scale = Math.min(1, MAX_SIDE / Math.max(vw, vh));
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    if (this._canvas.width !== w || this._canvas.height !== h) { this._canvas.width = w; this._canvas.height = h; }
    this._c2d.drawImage(video, 0, 0, w, h);
    const img = this._c2d.getImageData(0, 0, w, h);
    const res = analyzeRegion(img.data, w, h, { sx: 0, sy: 0, scale, frameW: vw, frameH: vh }, scaleFreeTemplates(this.ctx.templates.items));
    const cards = res.cards.map((c) => ({ rank: c.rank, score: c.score, box: c.box }));
    this._detectText();
    // Unsichere Treffer ebenfalls aufnehmen (gekennzeichnet), wenn sie keine sichere Karte überdecken.
    for (const c of res.candidates) {
      if (!c.match || c.match.status !== 'unsure' || !c.match.rank || c.match.rank === 'X') continue;
      const box = { x: c.x, y: c.y, w: c.w, h: c.h };
      if (cards.some((k) => overlap(k.box, box) > 0.3)) continue;
      cards.push({ rank: c.match.rank, score: Math.min(c.match.score, UNSURE_SCORE - 0.01), box });
    }
    return cards;
  }

  // Eingeblendete Texte – nur mit lokalem Texterkenner des Browsers (kein Upload), höchstens alle 2 s.
  _detectText() {
    if (!textDetectorAvailable() || this._textBusy) return;
    const t = this._timeNow ? this._timeNow() : 0;
    if (t - this._textAt < 2) return;
    this._textAt = t;
    this._textBusy = true;
    try {
      if (!this._textDetector) this._textDetector = new globalThis.TextDetector();
      this._textDetector.detect(this._canvas).then((found) => {
        for (const f of found || []) {
          const text = String(f.rawValue || '').trim();
          if (text.length >= 2 && !this.texts.some((x) => x.text === text)) this.texts.push({ t, text: text.slice(0, 200) });
        }
      }).catch(() => {}).finally(() => { this._textBusy = false; });
    } catch { this._textBusy = false; }
  }

  _startRecording() {
    const { camera } = this.ctx;
    if (camera.state !== CameraState.ACTIVE) { this._say('warn', 'Bitte zuerst die Kamera starten.'); this.render(); return; }
    this.detector = new SceneDetector();
    this.recording = true;
    this.texts = [];
    this._t0 = performance.now();
    this._timeNow = () => (performance.now() - this._t0) / 1000;
    this._timer = setInterval(() => {
      if (document.hidden || camera.state !== CameraState.ACTIVE) return;
      const t = (performance.now() - this._t0) / 1000;
      try { if (this.detector.push(this._analyze(camera.video), t)) this.render(); } catch (err) { console.warn('[video] Auswertung', err); }
    }, SAMPLE_MS);
    this.render();
  }

  _stopRecording() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this.recording && this.detector) {
      this.scenes = inferActions(this.detector.finish((performance.now() - this._t0) / 1000));
      this.sourceLabel = 'Kamera (abgefilmtes Video)';
    }
    this.recording = false;
  }

  _loadFile(file) {
    if (!file) return;
    if (this._fileUrl) URL.revokeObjectURL(this._fileUrl);
    this._fileUrl = URL.createObjectURL(file);
    this.fileName = file.name;
    this.fileVideo.src = this._fileUrl;
    this.fileVideo.hidden = false;
    this.scenes = [];
    this._say('ok', `„${file.name}“ geladen. Die Datei bleibt auf diesem Gerät.`);
    this.render();
  }

  async _scanFile() {
    const v = this.fileVideo;
    if (!v.src) return;
    if (!(v.duration > 0)) await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 4000); });
    if (!(v.duration > 0) || !Number.isFinite(v.duration)) { this._say('warn', 'Die Videolänge ist unbekannt – Auswertung nicht möglich.'); this.render(); return; }
    v.pause();
    this.scanning = true;
    this.texts = [];
    this._textAt = -10;
    this._timeNow = () => v.currentTime;
    const det = new SceneDetector();
    const seek = (t) => new Promise((resolve) => {
      const done = () => { v.removeEventListener('seeked', done); resolve(); };
      v.addEventListener('seeked', done);
      v.currentTime = t;
      setTimeout(done, 3000);
    });
    for (let t = 0; t <= v.duration && this.scanning; t += SEEK_STEP) {
      await seek(t);
      try { det.push(this._analyze(v), t); } catch (err) { console.warn('[video] Auswertung', err); }
      this.progress = t / v.duration;
      if (Math.round(t / SEEK_STEP) % 6 === 0) this._renderControls();
    }
    this.scenes = inferActions(det.finish(v.duration));
    this.sourceLabel = `Videodatei: ${this.fileName}`;
    this.scanning = false;
    this._say(this.scenes.length ? 'ok' : 'warn', this.scenes.length ? `${this.scenes.length} Szenen erkannt. Bitte prüfen und korrigieren.` : 'Keine Karten erkannt. Passen die angelernten Muster zu diesem Video?');
    this.render();
  }

  // --- Bedienung ---------------------------------------------------------------
  async _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const { camera, yumeko } = this.ctx;
    const a = btn.dataset.action;
    const si = Number(btn.dataset.scene);
    const ci = Number(btn.dataset.card);
    switch (a) {
      case 'source':
        this._stopRecording();
        this.scanning = false;
        this.source = btn.dataset.source;
        if (this.source === 'camera') camera.attach(this.stage); else camera.dock();
        this.render();
        break;
      case 'rec-start': this._startRecording(); break;
      case 'rec-stop': this._stopRecording(); this._say(this.scenes.length ? 'ok' : 'warn', this.scenes.length ? `${this.scenes.length} Szenen erkannt. Bitte prüfen und korrigieren.` : 'Keine Karten erkannt.'); this.render(); break;
      case 'pick-file': this.el.querySelector('[data-slot="file"]').click(); break;
      case 'scan-file': this._scanFile(); this.render(); break;
      case 'scan-stop': this.scanning = false; break;
      case 'role': {
        const c = this.scenes[si].cards[ci];
        c.role = c.role === 'dealer' ? 'player' : 'dealer';
        this.scenes[si].corrected = true;
        this.render();
        break;
      }
      case 'rank': this._sheet = { si, ci }; this.render(); break;
      case 'add-card': this._sheet = { si, ci: -1 }; this.render(); break;
      case 'pick-rank': {
        const { si: s, ci: c } = this._sheet;
        const sc = this.scenes[s];
        if (c >= 0) { sc.cards[c].rank = btn.dataset.rank; sc.cards[c].unsure = false; sc.cards[c].corrected = true; } else sc.cards.push({ rank: btn.dataset.rank, score: null, unsure: false, corrected: true, role: 'player', x: 1, y: 1 });
        sc.corrected = true;
        sc.unsure = sc.cards.some((x) => x.unsure);
        this._sheet = null;
        this.render();
        break;
      }
      case 'remove-card': {
        const { si: s, ci: c } = this._sheet;
        this.scenes[s].cards.splice(c, 1);
        this.scenes[s].corrected = true;
        this._sheet = null;
        this.render();
        break;
      }
      case 'close-sheet': this._sheet = null; this.render(); break;
      case 'drop-scene': this.scenes.splice(si, 1); this.render(); break;
      case 'adopt': {
        const chosen = this.scenes.filter((s) => s.cards.length);
        if (!chosen.length) { this._say('warn', 'Keine Szene mit Karten zum Übernehmen.'); this.render(); break; }
        const seq = {
          id: newSequenceId(),
          source: this.sourceLabel || 'Video',
          createdAt: new Date().toISOString(),
          texts: (this.texts || []).slice(0, 50),
          scenes: chosen.map((s) => ({ t0: s.t0, t1: s.t1, action: s.action || null, actionSuggested: !!s.actionSuggested, unsure: s.cards.some((c) => c.unsure), corrected: !!s.corrected, cards: s.cards.map((c) => ({ rank: c.rank, role: c.role, unsure: !!c.unsure, corrected: !!c.corrected, score: c.score })) }))
        };
        try {
          const items = await yumeko.learnFromSequence(seq);
          const checks = items.filter((i) => i.id.endsWith(':check'));
          this._say('ok', `Lernsequenz übernommen: ${seq.scenes.length} Szenen gespeichert, ${checks.length} gezeigte Entscheidungen mathematisch geprüft (${checks.filter((i) => i.category === 'verified').length} bestätigt, ${checks.filter((i) => i.category !== 'verified').length} widersprechen dem Rechenmodell).`);
          this.scenes = [];
        } catch (err) {
          this._say('warn', `Übernehmen fehlgeschlagen: ${err.message}`);
        }
        this.render();
        break;
      }
      default: break;
    }
  }

  _onChange(e) {
    const el = e.target;
    if (el.name === 'scene-action') {
      const sc = this.scenes[Number(el.dataset.scene)];
      sc.action = el.value || null;
      sc.actionSuggested = false;
    }
  }

  // --- Anzeige -------------------------------------------------------------------
  _renderControls() {
    const { camera, templates } = this.ctx;
    const slot = this.el.querySelector('[data-slot="controls"]');
    const notice = this._notice ? `<p class="notice notice--${this._notice.tone}" role="status">${this._notice.tone === 'ok' ? ICONS.check : ICONS.warning}<span>${esc(this._notice.text)}</span></p>` : '';
    const noTpl = !templates.items.length;
    let html = notice;
    if (noTpl) html += `<p class="notice notice--warn">${ICONS.warning}<span>Noch keine Karten angelernt – ohne Muster kann YUMEKO keine Karten erkennen. <button type="button" class="link-btn" data-nav="anlernen">Karten anlernen</button></span></p>`;
    if (this.source === 'camera') {
      html += `<div class="btn-row">
        ${this.recording ? '' : cameraButton(camera)}
        ${this.recording
          ? '<button type="button" class="btn btn--danger" data-action="rec-stop">Aufnahme beenden</button>'
          : `<button type="button" class="btn btn--yumeko" data-action="rec-start" ${camera.state === CameraState.ACTIVE && !noTpl ? '' : 'disabled'}>Lernaufnahme starten</button>`}
      </div>
      ${this.recording ? `<p class="hint"><span class="spinner"></span> Läuft – ${this.detector ? this.detector.scenes.length : 0} Szenen bisher. Halte den Bildschirm ruhig vor die Kamera.</p>` : '<p class="hint">Nutzt die bestehende Kamera. Die Spielrunden-Erkennung ist in dieser Ansicht angehalten.</p>'}`;
    } else {
      html += `<div class="btn-row">
        <button type="button" class="btn btn--secondary" data-action="pick-file" ${this.scanning ? 'disabled' : ''}>Videodatei wählen</button>
        ${this.scanning
          ? '<button type="button" class="btn btn--danger" data-action="scan-stop">Auswertung anhalten</button>'
          : `<button type="button" class="btn btn--yumeko" data-action="scan-file" ${this.fileName && !noTpl ? '' : 'disabled'}>Video auswerten</button>`}
      </div>
      ${this.scanning ? `<p class="hint"><span class="spinner"></span> Werte aus … ${Math.round(this.progress * 100)} %</p>` : `<p class="hint">${this.fileName ? `Datei: ${esc(this.fileName)}` : 'Noch keine Datei gewählt.'} Ausgewertet wird alle ${SEEK_STEP} Sekunden ein Bild.</p>`}`;
    }
    slot.innerHTML = html;
  }

  render() {
    const { camera } = this.ctx;
    this.el.querySelector('[data-slot="source"]').innerHTML = [['camera', 'Kamera'], ['file', 'Videodatei']]
      .map(([k, l]) => `<button type="button" data-action="source" data-source="${k}" aria-pressed="${this.source === k}">${l}</button>`).join('');
    this.stage.hidden = this.source !== 'camera';
    this.fileVideo.hidden = this.source !== 'file' || !this.fileName;
    this.el.querySelector('[data-slot="placeholder"]').hidden = camera.isRunning;
    this.el.querySelector('[data-slot="play"]').innerHTML = playbackButton(camera);
    if (this.source === 'camera' && camera.isRunning && camera.video.parentNode !== this.stage) camera.attach(this.stage);
    this._renderControls();

    const scenes = this.scenes.map((s, si) => `
      <article class="scene-card ${s.unsure ? 'is-unsure' : ''}">
        <div class="scene-head">
          <b>Szene ${si + 1}</b><span class="meta">${fmt(s.t0)}–${fmt(s.t1)}</span>
          ${s.cards.some((c) => c.unsure) ? '<span class="kind kind--warn">unsicher erkannt</span>' : ''}
          ${s.corrected ? '<span class="kind kind--ai">korrigiert</span>' : ''}
          <button type="button" class="btn btn--small" data-action="drop-scene" data-scene="${si}">Verwerfen</button>
        </div>
        <div class="scene-cards">
          ${s.cards.map((c, ci) => `
            <span class="scene-card-item ${c.unsure ? 'is-unsure' : ''}">
              <button type="button" class="mini-card" data-action="rank" data-scene="${si}" data-card="${ci}" aria-label="Kartenwert ${esc(c.rank)} korrigieren">${esc(c.rank)}</button>
              <button type="button" class="role-btn role-btn--${c.role}" data-action="role" data-scene="${si}" data-card="${ci}">${c.role === 'dealer' ? 'Dealer' : 'Spieler'}</button>
            </span>`).join('')}
          <button type="button" class="mini-card mini-card--add" data-action="add-card" data-scene="${si}" aria-label="Karte ergänzen">+</button>
        </div>
        <label class="field field--inline"><span>Gezeigte Aktion${s.actionSuggested ? ' <small class="kind kind--assume">Vorschlag</small>' : ''}</span>
          <select name="scene-action" data-scene="${si}">${ACTIONS.map(([v, l]) => `<option value="${v}" ${(s.action || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </label>
      </article>`).join('');
    this.el.querySelector('[data-slot="scenes"]').innerHTML = this.scenes.length ? `
      <section class="group">
        <h2 class="group-title">ERKANNTE SZENEN</h2>
        <p class="group-help">Kartenwert antippen zum Korrigieren, „Dealer/Spieler“ antippen zum Wechseln. Gezeigte Aktion wählen, falls im Video zu sehen. Erst „Lernsequenz übernehmen“ speichert etwas.</p>
        ${scenes}
        ${this.texts && this.texts.length ? `<p class="hint"><b>Erkannte Texte (lokal):</b> ${this.texts.slice(0, 10).map((x) => `${fmt(x.t)} „${esc(x.text)}“`).join(' · ')}</p>` : ''}
        <button type="button" class="btn btn--yumeko" data-action="adopt">Lernsequenz übernehmen</button>
      </section>` : '';

    const sheet = this.el.querySelector('[data-slot="sheet"]');
    if (!this._sheet) { sheet.hidden = true; sheet.innerHTML = ''; return; }
    const cur = this._sheet.ci >= 0 ? this.scenes[this._sheet.si].cards[this._sheet.ci] : null;
    sheet.hidden = false;
    sheet.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Kartenwert">
        <strong class="sheet-title">${cur ? `Karte ${esc(cur.rank)} korrigieren` : 'Karte ergänzen'}</strong>
        <div class="rank-grid">${RANKS.map((r) => `<button type="button" class="rank-btn ${cur && cur.rank === r ? 'is-current' : ''}" data-action="pick-rank" data-rank="${r}">${r}</button>`).join('')}</div>
        ${cur ? '<button type="button" class="btn btn--danger" data-action="remove-card">Karte entfernen</button>' : ''}
        <button type="button" class="btn btn--ghost" data-action="close-sheet">Abbrechen</button>
      </div>`;
  }
}
