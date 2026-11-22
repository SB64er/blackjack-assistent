# Blackjack Assistent – PWA (Phase 1–6, Version 0.6.0)

Reine Web-App ohne Build-Schritt: HTML, CSS und JavaScript-Module.
Alle Daten (Einstellungen, Kalibrierung, Spielarchiv, YUMEKO-Wissen) bleiben lokal auf dem Gerät.

## Struktur

```
index.html               App-Hülle, iOS-PWA-Meta-Tags
manifest.webmanifest     Web App Manifest (Name, Icons, Vollbild)
sw.js                    Service Worker (offline; speichert nur App-Dateien)
icons/                   App-Symbole (180, 192, 512, maskable)
css/app.css              Design (dunkel, minimalistisch)
js/app.js                Einstieg + Navigation OHNE URL-Änderung (data-nav), Kamera-Start per Tipp
js/core/                 Speicher, Ereignisse, Einstellungen, DOM-Hilfen, idb (IndexedDB + Ersatzspeicher),
                         display (Home-Bildschirm-App, Vollbild), updates (Service Worker, Update-Hinweis)
js/camera/               CameraService – getUserMedia (Stufen-Fallback), Start/Stopp, Fehler,
                         Frame-Wächter mit Selbstreparatur, Fortsetzen, Dock, Wake-Lock;
                         camera-diagnostics – Diagnose zum Kopieren
js/calibration/          geometry (reine Mathematik), store (Speichern/Laden),
                         model (Zustand), editor (Rechtecke per Finger)
js/test/                 Testmodus-Checkliste (7 Schritte)
js/views/                Ansichten: Haupt, Einstellungen, Kamera, Test, Strategieprofile, Profil-Editor,
                         Spielarchiv, Runde, YUMEKO-Lernzentrum, Wissen, Video lernen
js/demo/                 Simulierte Spielzustände (Demo-Modus)
js/game/                 hand (Kartenwerte), card-tracker (Mehrfachbestätigung, keine Doppelzählung),
                         round-state (Live-Runde, verdeckte Karte, Split, Rundenende), settle (Ergebnis W/L/Push)
js/archive/              round-record (Datensatz, Prüfung, Filter), archive-store (IndexedDB, Export/Import)
js/yumeko/               knowledge (Wissensspeicher), archive-analysis (Analyse), yumeko (Versionen, Prüfung),
                         video-learner (Szenenwechsel, Video-Lernsequenzen)
js/strategy/             standard (Basisstrategie 4–8 Decks), engine (Entscheidung), profiles (Profilspeicher),
                         ev (Rechenmodell), analysis, simulate (reproduzierbare Simulation), research (KI-Strategie)
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
  "version": 2,
  "savedAt": "2026-11-22T22:18:39Z",
  "frame": { "width": 1920, "height": 1080, "aspect": 1.778, "orientation": "landscape" },
  "regions": {
    "dealer":     { "x": 0.38, "y": 0.12, "w": 0.22, "h": 0.22 },
    "player":     { "x": 0.28, "y": 0.56, "w": 0.34, "h": 0.28 },
    "split":      { "x": 0.64, "y": 0.56, "w": 0.30, "h": 0.28 }
  },
  "splitEnabled": false
}
```

Koordinaten sind relativ (0–1) zum echten Kamerabild, nicht zum Bildschirm.
Passen Ausrichtung oder Seitenverhältnis des aktuellen Bildes nicht zur Kalibrierung,
wird sie pausiert (gelbe Warnung), aber nie verändert.

Seit Phase 6 gibt es **ein** Dealer-Feld (A). Eine alte Kalibrierung (Version 1 mit
`dealerUp` und `dealerHole`) wird beim ersten Start automatisch umgewandelt: Das neue
Dealer-Feld umfasst beide alten Felder. Die alte Fassung bleibt unter
`bjassist.calibration.v1backup` und im Feld `legacy` erhalten.

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
npm test               # Logik: Geometrie, Hand, Runden, Muster, Version, Offline-Dateiliste,
                       # Strategie, Profile, Migration, Rechenmodell, Simulation, KI-Recherche
npm run test:browser   # Chromium in iPad-/iPhone-Grössen (benötigt Playwright), inkl. Profile
                       # und Betrieb unter /blackjack-assistent/ (wie GitHub Pages),
                       # Phase 6: Live-Runde, Archiv, Korrektur, Export, YUMEKO, Video, Überlauf
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

## Phase 5 (Version 0.5.0) – Strategieprofile

Erreichbar über das Profil-Schild in der Hauptansicht oder Einstellungen → Strategieprofile.

**Profile.** Jedes Profil hat ID, Name, Beschreibung, Typ (Standard / Benutzerdefiniert / KI),
eigene Regeln (oder „folgt den Tischregeln“), geänderte Zellen, Strategiedaten sowie Erstellungs-
und Änderungsdatum. Anlegen, bearbeiten, umbenennen, duplizieren, löschen (zwei Tipps), aktivieren.
Genau ein Profil ist aktiv; Wechsel wirkt sofort ohne Neuladen. Das aktive Profil lässt sich erst
löschen, wenn ein anderes aktiv ist. Das Profil „Standard“ ist fest und nicht veränderbar.

**Speicher.** `localStorage` → `bjassist.strategyProfiles`:
`{ version: 1, rev, activeId, profiles: [...], invalid: [...] }`. Beim ersten Start mit Daten aus
0.4.0 wird das Standardprofil angelegt; alle übrigen Daten bleiben unverändert. Ungültige Einträge
werden nicht gelöscht, sondern unter `invalid` aufbewahrt. `rev` verhindert, dass ein anderer Tab
Änderungen unbemerkt überschreibt. Ein neueres Speicherformat wird nur gelesen, nie überschrieben.

**Strategie-Engine** (`js/strategy/engine.js`). Hart, Weich, Paare gegen Dealerkarte; Aktionen
ZIEHEN, STEHEN, VERDOPPELN, SPLITTEN, AUFGEBEN (nur mit Regel „spätes Aufgeben“). Nicht erlaubte
Aktionen werden ersetzt (z. B. Verdoppeln mit 3 Karten → Ziehen bzw. Stehen bei „Ds“, kein Teilen
nach einem Split, kein Verdoppeln nach Split ohne DAS). Zellen ohne Profilwert → Standardstrategie.
Mit dem Profil „Standard“ sind alle Empfehlungen identisch mit 0.4.0 (Test). Weicht ein Profil ab,
zeigt die Hauptansicht „weicht von Standard ab“.

Quelle der Standardstrategie: *Blackjack Basic Strategy Chart (4–8 Decks)*, Wizard of Odds,
https://wizardofodds.com/games/blackjack/strategy/4-decks/ (abgerufen 2026-11-22).

**Rechenmodell** (`ev.js`, Ergebnisart „berechnet“). Exakte Erwartungswerte pro Zelle mit unendlich
vielen Decks, Dealer schaut bei Ass/10 nach Blackjack, ein Split (kein erneutes Teilen), geteilte
Asse je eine Karte, Aufgeben = −0,5. Das Modell bestätigt die Standardtabelle bis auf zwei knappe
Grenzfälle (Soft 13 gegen 5, Soft 15 gegen 4), die bei endlichen Decks zur Standardtabelle kippen.
Alle Annahmen werden in der App angezeigt.

**Simulation** (`simulate.js`, Ergebnisart „Simulation“). Endlicher Schuh, 75 % Penetration,
Zufallsgenerator mulberry32 mit festem Startwert (20261122) → gleiche Eingabe = gleiches Ergebnis.
Angezeigt werden Runden, Startwert, Erwartungswert und 95-%-Konfidenzintervall.

**Analyse.** Erwartungswert des Profils, der Standardstrategie und des Modellbesten, Abweichungen zur
Standardstrategie mit Kosten je Zelle, Regelabhängigkeit und Unsicherheit. Ergebnisse sind
gekennzeichnet als *berechnet*, *Simulation*, *KI-Vorschlag* oder *Annahme (nicht überprüft)*.
Es wird nie behauptet, eine Strategie sei optimal.

**KI-Strategie.** Berechnet für die gewählten Regeln die Strategie mit dem Rechenmodell (offline) und
speichert sie als eigenes Profil (Typ KI, violett markiert) mit Methode, Annahmen, Grenzen und
Abweichungen. Gespeicherte Profile funktionieren offline.

*Echte Online-Recherche* ist vorbereitet, aber **nicht eingerichtet** – und die App sagt das offen.
Dafür ist ein eigener Server nötig (der API-Schlüssel gehört dorthin, nie in den Browsercode). Die App
sendet erst, wenn eine HTTPS-Adresse eingetragen **und** ausdrücklich zugestimmt wurde, und nur die
Tischregeln (keine Kamerabilder, keine Muster). Vorschläge werden mit dem Rechenmodell geprüft und
nicht automatisch übernommen. Schnittstelle:

```
POST <eigene https-Adresse>   Content-Type: application/json
{ "task": "blackjack-strategy-research", "schema": 1, "rules": {...}, "rulesText": "...", "app": "BJ.AI 0.5.0 (Phase 5)" }

Antwort:
{ "summary": "...",
  "sources": [{ "title": "...", "url": "https://...", "retrievedAt": "2026-11-22", "excerpt": "..." }],
  "approaches": ["..."],
  "suggestions": [{ "key": "hard:16:10", "code": "Rh", "rationale": "..." }],
  "model": "..." }
```

Antworten ohne Quellen (Titel, https-URL, Abrufdatum) werden abgelehnt. Kostenpflichtige Dienste
werden nie automatisch aktiviert.

## Phase 6 (Version 0.6.0) – YUMEKO AI

### Was ist neu

- **YUMEKO AI** ist ein festes Strategieprofil („Adaptive Blackjack Intelligence.“). Es ist wie
  jedes andere Profil aktivierbar; es ist immer genau ein Profil aktiv. YUMEKO kann nicht gelöscht
  und nicht direkt bearbeitet werden – es ändert sich nur über geprüfte und bestätigte Strategieversionen.
- **Spielarchiv** (Einstellungen → Spielarchiv): Jede Live-Runde wird gespeichert, sobald das Ergebnis
  sicher ist. Fehlt etwas (z. B. Dealerkarten nicht fertig erkannt), wird sie als „unvollständig“
  gespeichert und auf der Hauptansicht um Bestätigung (Gewonnen/Verloren/Push je Hand) gebeten.
  Runden lassen sich öffnen, Karten und Ergebnisse korrigieren (Werte werden neu berechnet), löschen,
  suchen und nach W/L/Push/Offen filtern. Export/Import als JSON; beim Import wird nie überschrieben.
  Das ganze Archiv lässt sich nur nach ausdrücklicher Bestätigung löschen.
- **Ein Dealer-Scanfeld**: Erste Dealerkarte = offene Karte, zweite = verdeckte Karte (bis sie wirklich
  gesehen wird „unbekannt“), weitere = gezogene Karten. Jede Karte wird mehrfach bestätigt, bewegte
  Karten werden nicht doppelt gezählt.
- **Live-Runde**: Eine Runde endet nicht, nur weil Karten kurz verdeckt sind (erst nach 5 s leerem Tisch).
  Split-Hände werden getrennt geführt, Aktionen (Ziehen/Stehen/Split) mit der jeweiligen Empfehlung erfasst.
  „Runde abschliessen“ beendet eine Runde von Hand.
- **Aufgeben/Surrender** ist aus Regeln, Profilen, Empfehlungen, Menüs, Demo und YUMEKO entfernt.
  Alte Profile und Daten mit Aufgeben-Codes bleiben lesbar (Rh→Ziehen, Rs→Stehen, Rp→Split; Original in
  `legacySurrender`).

### Was YUMEKO wirklich lernt (und wie)

1. **Archiv analysieren** – rechnet jede gespeicherte Entscheidung mit dem Rechenmodell (`ev.js`) nach:
   Entscheidungsqualität getrennt vom Ergebnis, Glück/Pech (Ergebnis minus Erwartung), Konfidenzintervalle
   für kleine Stichproben, häufige Situationen, wiederholte Fehler, uneinheitliche Entscheidungen.
   Reproduzierbar: gleiche Daten → gleiches Ergebnis.
2. **Erkennung** – aus Korrekturen im Archiv lernt YUMEKO, welche Ränge oft falsch erkannt werden, und
   verlangt für diese Ränge zusätzliche Bestätigungen in der Live-Erkennung.
3. **Strategieversionen** – ein Entwurf entsteht aus der Basisstrategie plus vom Benutzer bestätigten
   Regeln/Hypothesen. Jede Abweichung wird mathematisch geprüft (kein Verlust über der Toleranz,
   Gesamt-EV nicht schlechter als die Referenz). Aktiv wird eine Version erst nach erfolgreicher Prüfung
   **und** ausdrücklicher Bestätigung.
4. **Video-Lernsequenzen** – erkannte Szenen aus einem Video werden nach Prüfung/Korrektur als
   Beobachtungen übernommen; sie ändern die Strategie nie direkt.

Beobachtungen, mathematisch geprüfte Erkenntnisse und unbestätigte Hypothesen bleiben getrennt.
Es gibt keine Gewinngarantie und keine erfundenen Analysen: Fortschritt entsteht nur aus echten Daten.

### Wissensspeicher

Kategorien: Spielerfahrungen, Videobeobachtungen, Strategieregeln, Mathematisch geprüfte Erkenntnisse,
Unbestätigte Hypothesen, Quellen und Lernmaterial, Strategieversionen. Jeder Eintrag hat Inhalt, Ursprung,
Datum, Regeln, Vertrauen, Prüfstatus und Verweise auf Runden/Videos. Einträge lassen sich korrigieren oder
löschen; gelöschte automatische Einträge werden bei der nächsten Analyse nicht wieder angelegt.

### Video lernen

Verfügbar: vorhandene Kamera (keine zweite Verbindung) oder Videodatei, Bildanalyse alle 0,5 s,
Kartenerkennung mit den angelernten Mustern, Szenenwechsel mit Zeitstempel, unsichere Erkennungen
markiert, Korrektur, „Lernsequenz übernehmen“. Während „Video lernen“ ist die Live-Spielerkennung pausiert.

**Noch nicht verfügbar:** Texterkennung (OCR), Sprach-Transkription und KI-Bildanalyse. Dafür bräuchte
es einen eigenen Server mit KI-Dienst (Schlüssel nie im öffentlichen Code) und die ausdrückliche
Zustimmung, bevor Bilder das Gerät verlassen.

### Speicher

IndexedDB-Datenbank `bjassist` (Stores `rounds`, `knowledge`, `videos`, `versions`, `meta`). Ist IndexedDB
nicht verfügbar, wird ein kleinerer Ersatz in `localStorage` (`bjassist.db.<store>`) genutzt und darauf
hingewiesen. Safari kann Website-Daten löschen – deshalb regelmässig im Spielarchiv exportieren.
Profile: `bjassist.profiles` (Version 2, alte Version 1 wird automatisch umgewandelt).

### Nur auf einem echten iPad prüfbar

- Kartenerkennung mit echter Kamera im neuen Dealer-Feld (verdeckte Karte, gezogene Karten)
- Video lernen mit Videodatei aus „Fotos“/„Dateien“ und mit gefilmtem Bildschirm
- Speicher bleibt nach Schliessen der Home-Bildschirm-App erhalten
- Flüssigkeit/Leistung während Live-Erkennung und Videoanalyse
