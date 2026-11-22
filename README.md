# Blackjack Assistent – PWA (Phase 1–4, Version 0.4.0)

Reine Web-App ohne Build-Schritt: HTML, CSS und JavaScript-Module.
Alle Daten (Einstellungen, Kalibrierung) bleiben lokal auf dem Gerät.

## Struktur

```
index.html               App-Hülle, iOS-PWA-Meta-Tags
manifest.webmanifest     Web App Manifest (Name, Icons, Vollbild)
sw.js                    Service Worker (offline; speichert nur App-Dateien)
icons/                   App-Symbole (180, 192, 512, maskable)
css/app.css              Design (dunkel, minimalistisch)
js/app.js                Einstieg + Navigation OHNE URL-Änderung (data-nav), Kamera-Start per Tipp
js/core/                 Speicher, Ereignisse, Einstellungen, DOM-Hilfen,
                         display (Home-Bildschirm-App, Vollbild), updates (Service Worker, Update-Hinweis)
js/camera/               CameraService – getUserMedia (Stufen-Fallback), Start/Stopp, Fehler,
                         Frame-Wächter mit Selbstreparatur, Fortsetzen, Dock, Wake-Lock;
                         camera-diagnostics – Diagnose zum Kopieren
js/calibration/          geometry (reine Mathematik), store (Speichern/Laden),
                         model (Zustand), editor (Rechtecke per Finger)
js/test/                 Testmodus-Checkliste (7 Schritte)
js/views/                Ansichten: Haupt, Einstellungen, Kamera, Test
js/demo/                 Simulierte Spielzustände (Demo-Modus)
js/game/hand.js          Kartenwerte, Soft/Hart/Paar/Blackjack
js/recognition/          vision (Bildverarbeitung), analyzer (Vorlagenvergleich),
                         template-store (angelernte Muster + Zustimmung),
                         round-tracker (Glättung, neue Runde, gezogene Karte),
                         recognition-service (Live-Auswertung), detection-overlay
tests/                   Logik-Tests (npm test) und Browser-Test (npm run test:browser)
package.json             nur für die Tests – die App selbst braucht keinen Build
```

## Kalibrierungsdaten

Gespeichert in `localStorage` unter `bjassist.calibration`:

```json
{
  "version": 1,
  "savedAt": "2026-11-21T22:18:39Z",
  "frame": { "width": 1920, "height": 1080, "aspect": 1.778, "orientation": "landscape" },
  "regions": {
    "dealerUp":   { "x": 0.38, "y": 0.12, "w": 0.10, "h": 0.22 },
    "dealerHole": { "x": 0.50, "y": 0.12, "w": 0.10, "h": 0.22 },
    "player":     { "x": 0.28, "y": 0.56, "w": 0.34, "h": 0.28 },
    "split":      { "x": 0.64, "y": 0.56, "w": 0.30, "h": 0.28 }
  },
  "splitEnabled": false
}
```

Koordinaten sind relativ (0–1) zum echten Kamerabild, nicht zum Bildschirm.
Passen Ausrichtung oder Seitenverhältnis des aktuellen Bildes nicht zur Kalibrierung,
wird sie pausiert (gelbe Warnung), aber nie verändert.

## Neue Version veröffentlichen

Bei **jeder** Änderung an App-Dateien die Version an drei Stellen gleich erhöhen:
`VERSION` in `sw.js`, `APP_VERSION` in `js/core/version.js` und `version` in `package.json`.
Neue Dateien in `ASSETS` (sw.js) eintragen. `npm test` prüft beides.

Seit Phase 4 kommen die App-Dateien aus dem Offline-Speicher. Installierte Apps sehen
eine neue Version als Hinweis „Neue Version verfügbar“ und laden sie erst nach Tipp auf
„Aktualisieren“ – nie mitten in einer Runde. Kalibrierung, Einstellungen und angelernte
Karten bleiben dabei erhalten.

## Tests

```
npm test               # Logik: Geometrie, Hand, Runden, Muster, Version, Offline-Dateiliste
npm run test:browser   # Chromium in iPad-/iPhone-Grössen (benötigt Playwright)
```

## Voraussetzungen

- iOS / iPadOS 16.4 oder neuer, Safari (iPadOS 26: mindestens 26.1)
- Aufruf über **HTTPS** (sonst kein Kamerazugriff)

## Kartenerkennung (Phase 3)

Lokal, ohne Server und ohne KI-Modell:

1. Aus jedem kalibrierten Bereich wird nur der Ausschnitt im Arbeitsspeicher gelesen.
2. Kartenweiss = hell und farbarm; Zeichen = dunkle Flächen, die rundum von Kartenweiss umgeben sind.
3. Rangzeichen werden auf 20×28 Punkte normiert und mit angelernten Mustern verglichen.
   Zusätzlich muss der Aufbau der Kartenecke passen (kleineres Farbsymbol direkt darunter) –
   so werden Farbsymbole in der Kartenmitte und gedrehte Ecken ausgeschlossen.
4. Ein Ergebnis gilt erst, wenn es in 2 Bildern hintereinander gleich ist. Bei Zweifel:
   gelbe Warnung „Kartenerkennung unsicher“.

Angelernte Muster: `localStorage` → `bjassist.templates` (nur nach Zustimmung; keine Fotos).

## iOS/iPadOS-Besonderheiten (Home-Bildschirm-App)

- Keine Hash-/URL-Navigation: stoppt dort sonst die Kamera (WebKit-Bug 215884).
- Kamerafreigabe gilt nur bis zum Schliessen der App (WebKit-Bug 327237) – Start per Tipp.
- Video kann schwarz bleiben (WebKit-Bugs 252465/300115) – Wächter repariert oder meldet es.
- iPadOS 26.0 drehte das Kamerabild falsch (WebKit-Bug 299591, behoben in 26.1).

## Phase 4 (Version 0.4.0)

**Kamera (iPad-Web-App):** Bisher konnte der Start in der Home-Bildschirm-App ohne
Fehlermeldung hängen bleiben („Kamera startet …“) oder das Bild blieb schwarz.
- Zeitlimit für die Kamerafreigabe (10 s) – danach klare Meldung „Kamera antwortet nicht“.
- Nach 3,5 s kann der Start per Tipp erneut versucht werden.
- Blockiert iOS die Wiedergabe, erscheint „Kamerabild anzeigen – hier tippen“.
- Selbstreparatur bei komplett schwarzem Bild und bei dauerhaft „unterbrochener“ Kamera.
- Knopf „Kamera neu starten“, erweiterte Diagnose (Wiedergabe, Startdauer, Reparaturen,
  Helligkeit, Anzeige, Offline-Version).

**iPad-Layout:** Querformat mit Karten links und Empfehlung rechts, Hochformat mit grösseren
Karten und zweispaltiger Bedienung; Kamerabild im echten Seitenverhältnis.

**Vollbild & Home-Bildschirm:** Vollbild-Knopf im Browser (iPad-Safari), Abstand zur
Statusleiste in der Home-Bildschirm-App, Installationshinweis in den Einstellungen.

**Touch:** Kein Doppeltipp-Zoom, keine Textauswahl/Kontextmenüs auf Bedienelementen,
sichtbare Rückmeldung beim Tippen, grössere Ziele und Kalibrierungsgriffe.

**Service Worker:** Offline-Start aus dem Cache, Update-Hinweis mit „Aktualisieren“,
Update-Suche beim Öffnen und alle 30 Minuten, nur eigene alte Caches werden gelöscht.

Gespeicherte Daten (`bjassist.settings`, `bjassist.calibration`, `bjassist.templates`,
`bjassist.testmode`) sind unverändert – nichts muss neu eingerichtet werden.
