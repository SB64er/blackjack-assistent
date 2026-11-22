# Yumeko-Server (Referenz) – optional, nicht eingerichtet

Die Yumeko Academy funktioniert ohne Server. Dann sagt sie bei jedem YouTube-Link offen
„Kein Transkript verfügbar“, und du kannst ein Transkript von Hand einfügen. Erkennung der
Aussagen und die mathematische Prüfung laufen immer lokal auf dem Gerät.

Ein eigener Server ist nur nötig, wenn Titel, Kanal, Dauer und Transkript **automatisch**
kommen sollen. Ein Browser darf YouTube-Untertitel nicht direkt lesen, und API-Schlüssel
gehören nie in den Browsercode. Deshalb diese Zwischenstelle.

## Was der Referenz-Server kann

| Teil | Quelle | Bedingung |
|------|--------|-----------|
| Titel, Kanal, Dauer, Datum, Sprache | YouTube Data API v3 (`videos.list`) | `YT_API_KEY` gesetzt (Google-Cloud-Projekt, kostenloses Kontingent) |
| Transkript | Dateien in `TRANSCRIPT_DIR` (`<videoId>.json` oder `<videoId>.txt`) | Nur rechtmässig beschaffte Transkripte (eigene Videos, vom Rechteinhaber freigegeben) |
| Videobildanalyse | – | Nicht vorhanden; Antwort `available: false` |

Der Server liest **keine** Untertitel von youtube.com aus. Inoffizielle Transkript-Abrufe
verstossen gegen die YouTube-Nutzungsbedingungen. Die offizielle Untertitel-Schnittstelle
(`captions.download`) funktioniert nur für Videos, die dir gehören (OAuth des Kanalinhabers).

## Datenschutz

- Die App sendet nur `{ task, schema, videoId, want, app }`, ohne Spielrunden, Kamerabilder oder persönliche Daten.
- Der Server speichert nichts: keine Datenbank, keine Logdatei mit Video-IDs.
- Mit `YT_API_KEY` geht die Video-ID vom Server an Google (YouTube Data API).
- Die App schickt keine Cookies (`credentials: 'omit'`) und nimmt nur `https://`-Adressen ohne Zugangsdaten an.

## Starten

Voraussetzung: Node.js 18 oder neuer. Es gibt keine Abhängigkeiten.

```
ALLOWED_ORIGINS=https://<dein-github-name>.github.io \
YT_API_KEY=<schlüssel>            # optional
TRANSCRIPT_DIR=./transcripts      # optional
PORT=8787 \
node server/yumeko-server.mjs
```

| Variable | Bedeutung |
|----------|-----------|
| `ALLOWED_ORIGINS` | Kommagetrennte Herkünfte, die anfragen dürfen (CORS). Leer = Browser-Anfragen werden abgelehnt. |
| `YT_API_KEY` | Schlüssel für die YouTube Data API. Nur auf dem Server, nie in der App. |
| `TRANSCRIPT_DIR` | Ordner mit zulässigen Transkripten. |
| `RATE_PER_MIN` | Anfragen pro Minute und IP (Standard 20). |
| `PORT` | Port (Standard 8787). |

Der Server muss über **HTTPS** erreichbar sein, z. B. hinter einem Reverse-Proxy (Caddy, nginx) oder
bei einem Anbieter mit TLS. Danach die Adresse in der App eintragen: **YUMEKO → Yumeko Academy →
Daten → Eigener Server**. Mit dem Eintragen stimmst du zu, dass neue Links (nur die Video-ID) an
diesen Server gehen. Feld leeren = ausgeschaltet.

## Transkript-Dateien

`<videoId>.txt`: eine Zeile pro Satz, optional mit Zeitstempel:

```
0:05 Always split aces and eights.
0:20 Stand on 12 against a 4, 5 or 6.
```

`<videoId>.json`:

```json
{ "language": "en", "kind": "vom Kanal bereitgestellt", "segments": [{ "start": 5, "text": "Always split aces and eights." }] }
```

## Schnittstelle

`POST /` mit `Content-Type: application/json`:

```json
{ "task": "youtube-video", "schema": 1, "videoId": "dQw4w9WgXcQ", "want": ["metadata", "transcript", "frames"], "app": "BJ.AI 0.8.0 (Phase 8)" }
```

Antwort (fehlende Teile sind `null` bzw. `available: false` mit Grund):

```json
{
  "videoId": "dQw4w9WgXcQ", "title": "…", "channel": "…", "durationSec": 213, "publishedAt": "…", "language": "en",
  "transcript": { "available": true, "language": "en", "kind": "bereitgestellt", "segments": [{ "start": 5, "text": "…" }] },
  "frames": { "available": false, "reason": "Dieser Server analysiert keine Videobilder." },
  "provider": "Yumeko-Referenzserver + YouTube Data API"
}
```

Die App prüft jede Antwort streng (`js/academy/server-client.js`, `validateServerResponse`):
anderes Video, falsche Typen und übergrosse Transkripte (über 200 000 Zeichen) werden abgelehnt bzw. gekürzt.
Ein eigener Server mit anderer Technik muss nur dieses Format einhalten.

## Kosten

Der Referenz-Server selbst kostet nichts. Hosting und das Google-Cloud-Projekt richtest du selbst ein.
Die YouTube Data API hat ein kostenloses Tageskontingent; `videos.list` kostet 1 Einheit pro Anfrage.
In der App ist nichts Kostenpflichtiges aktiviert.
