# Backend-Demo

## Start

Voraussetzungen: Docker mit Compose und Zugang zu den öffentlichen Images und zum npm-Registry. Im Verzeichnis `src/backend` ausführen:

```sh
docker compose up --build
```

Die API ist unter `http://localhost:3000`, Mailpit unter `http://localhost:8025` und die MinIO-Konsole unter `http://localhost:9001` erreichbar. Das Demo-Administratorkonto lautet `admin@example.test` mit Passwort `demo-admin-password`; MinIO verwendet `minioadmin`/`minioadmin`. Diese Zugangsdaten sind öffentlich und ausschließlich für lokale Tests geeignet. Daten bleiben in Docker-Volumes erhalten; die SQL-Initialisierung läuft nur bei einem neuen PostgreSQL-Volume. `docker compose down -v` löscht diese Daten dauerhaft.

Für lokale Prüfung der Logik: `npm ci`, `npm run typecheck`, `npm test`; `npm run coverage` misst die geladenen Quelldateien. Die [Testübersicht](tests/README.md) beschreibt abgedeckte Schnittstellen und Grenzen. Ein bestehender Admin wird beim Neustart nicht zurückgesetzt, auch wenn sich die Umgebungsvariablen ändern.

## Aufbau

`src/http` enthält Express-Routen, Eingabeprüfung und Fehlerbehandlung. `src/application/commands` enthält zustandsändernde Anwendungsfälle und den Login, `src/application/queries` die lesenden Anwendungsfälle. Beide nutzen Schnittstellen für Datenbank, Speicher, Authentifizierung und Benachrichtigungen; Query-Handler erhalten nur lesende Datenbankschnittstellen. Es gibt weder Event Sourcing noch getrennte Datenbanken oder einen Command-Bus. Der PostgreSQL-Zugriff verwendet weiterhin direktes SQL. `src/domain` enthält Daten- und Berechtigungsregeln; `src/infrastructure` implementiert die Schnittstellen mit PostgreSQL, S3, JWT und SMTP. `src/server.ts` verbindet die Komponenten und startet den Dienst. Schreibende Baum- und Freigabeoperationen behalten ihre gemeinsame Datenbank-Transaktionssperre, damit Rechteprüfung und Änderung zusammen ausgeführt werden.

## API

Die bestehende HTTP-API bleibt unverändert. GET-Routen verwenden Queries, schreibende Routen Commands. `PATCH /files/:id` bleibt für bestehende Clients kompatibel und leitet anhand von `copy` intern an den Kopier- oder Änderungs-Command weiter; es sind keine Vertragsänderungen erforderlich. Login gibt ein Token aus und wird als Command behandelt.


JSON-Anfragen verwenden `Content-Type: application/json`; nach Anmeldung wird `Authorization: Bearer <token>` benötigt. IDs sind UUIDs. Bei nicht sichtbaren Elternordnern liefern die Listen `parent_id: null` bzw. `folder_id: null`. Antworten bei Fehlern enthalten `error`.

- `POST /auth/login`: `{ "email": "admin@example.test", "password": "demo-admin-password" }` liefert ein acht Stunden gültiges Token.
- `GET /me`; `GET /users` und `POST /users` (nur Admin): Konto mit `email`, `password` (mindestens 12 Zeichen) und optional `isAdmin` erstellen.
- `POST /users` akzeptiert zusätzlich `accountType: "internal"` oder `"external"`. `PATCH /users/:id` ändert den Kontotyp. Admins sehen die direkten Freigaben eines Kontos über `GET /users/:id/shares`. `PATCH /shares/:id` setzt Stufe und Löschrechte einer bestehenden Freigabe. Interne Konten dürfen Freigaben im Rahmen ihrer eigenen Rechte verwalten; externe Konten dürfen keine Freigaben verwalten. Beim Start ergänzt das Backend die Spalte für bestehende Datenbanken. Alte Konten bleiben zunächst ohne Zuordnung.

- `POST /folders`: `{ "name": "Projekt", "parentId": null }`. Nur Admins erstellen Wurzelordner; Unterordner erfordern `write` auf dem Elternordner. `GET /folders` listet lesbare Ordner.
- `POST /folders/:id/files`: Multipart-Upload im Feld `file`, maximal 10 MiB. `GET /files` listet lesbare und eigene Dateien; `GET /files/:id/download` lädt eine Datei herunter. `PUT /files/:id/content` ersetzt ihren Inhalt per Multipart-Feld `file`. `PATCH /files/:id` benennt mit `name` um, verschiebt mit `folderId` oder kopiert mit `copy: true` und optional `folderId`/`name`. `DELETE /files/:id` löscht eine Datei.
- `POST /shares` (Admin oder internes Konto im Rahmen eigener Rechte): `{ "userId": "<UUID>", "folderId": "<UUID>", "permission": "read", "deleteFiles": false, "deleteFolders": false }`. Statt `folderId` kann `fileId` angegeben werden. `DELETE /shares/:id` widerruft die Freigabe. Bestehende Freigaben können über `PATCH /shares/:id` geändert werden. Bei Ordnerfreigaben wird eine E-Mail versendet; `notified: false` zeigt einen Zustellfehler beim Mailserver an, die Freigabe bleibt bestehen.
- `DELETE /folders/:id` löscht einen ganzen Ordnerbaum nach Prüfung aller enthaltenen Ordner und Dateien.

`read` erlaubt Lesen, `upload` zusätzlich Hochladen und Bearbeiten eigener Dateien, `write` zusätzlich Bearbeiten, Verschieben und Kopieren fremder Dateien. Eigene Dateien bleiben auch ohne Freigabe sichtbar. Eigene Dateien dürfen mit `write` gelöscht werden. Das explizite Recht `deleteFiles` erlaubt das Löschen eigener und fremder Dateien unabhängig von der Berechtigungsstufe. `deleteFolders` gilt nur für Ordner und wird wie die anderen Rechte entlang des Ordnerbaums vererbt. Für einen Ordnerbaum müssen das Ordnerlöschrecht auf jedem Ordner und die jeweiligen Dateilöschrechte auf jeder Datei vorliegen. Direkte Datei- und geerbte Ordnerfreigaben ergänzen sich. Administratoren dürfen alle Operationen ausführen.

Der optionale Office-Editor verwendet `POST /files/:id/editor` für eine an den Nutzer gebundene Sitzung und `GET /editor/:id` für den Speicherstatus. `GET /features` meldet, ob der Editor konfiguriert ist. ONLYOFFICE bezieht Originaldateien und meldet fertige Ergebnisse über signierte interne Endpunkte unter `/office`. Status und Sitzungen liegen im Arbeitsspeicher. Die endgültige Übernahme nutzt den regulären Ersetzen-Command mit zusätzlicher Versionsprüfung.

## Bewusste Grenzen

Keine produktive Bereitstellung: Es fehlen unter anderem TLS, allgemeine Passwortänderung und Kontolöschung, Rate-Limits, ein manipulationssicheres Audit-Protokoll, Virenprüfung, Quotas, Pagination und eine robuste Mail-Warteschlange. Uploads und Downloads werden vollständig im Arbeitsspeicher gehalten. DB und Objektspeicher bilden keine gemeinsame Transaktion; bei Abstürzen oder Fehlern können verwaiste Objekte entstehen. Die Demo serialisiert schreibende Baum- und Freigabeoperationen mit einem Datenbank-Lock, ist aber nicht für hohe Last ausgelegt. Fehler beim Bereinigen abgelaufener Papierkorbeinträge werden protokolliert; der Eintrag bleibt für einen späteren Bereinigungsversuch erhalten. Es gibt keine Ordner-Verschiebe-/Kopierfunktion. Eine lokale Benutzeroberfläche ist unter [src/ui](../ui/README.md) dokumentiert. Die verwendete Multer-1.x-Abhängigkeit hat bekannte Sicherheitsprobleme und muss vor jeder weitergehenden Nutzung aktualisiert werden.

Automatisierte Tests decken zentrale Rechte- und Löschentscheidungen sowie ausgewählte Commands und Queries mit simulierten Abhängigkeiten ab. Ein isolierter Integrationstest für PostgreSQL, S3Mock und Mailpit prüft die Bereichsfreigabe und den tatsächlichen E-Mail-Eingang. Aufruf und Grenzen stehen in der [Integrationstest-Dokumentation](../../tests/README.md). Die Compose-Demo mit MinIO wurde damit nicht geprüft.

### SMTP und Resend testen

Standardmäßig sendet die Demo Ordnerfreigaben über Mailpit. Der SMTP-Adapter unterstützt alternativ `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASSWORD` und `SMTP_FROM`. Das optionale Compose-Overlay `deployment/compose.resend.yml` konfiguriert Resend; `RESEND_API_KEY` und `RESEND_FROM` müssen über eine private Umgebung bereitgestellt werden. Die Absenderdomain muss bei Resend freigeschaltet sein. Schlüssel nicht in das Repository einchecken.

Für einen einzelnen SMTP-Test ohne Umstellung des laufenden Systems `src/backend/.env` aus `.env.example` anlegen und den Resend-Key dort lokal eintragen. Die Datei ist durch `.gitignore` ausgeschlossen. Danach im Projektstamm ausführen:

```sh
npm --prefix src/backend run mail:test
```

Der Test verschickt eine echte Nachricht mit dem Platzhalter „Testordner“ an `RESEND_TEST_TO`. Eine SMTP-Annahme bestätigt noch nicht die Zustellung im Posteingang. Der isolierte Mailpit-Integrationstest prüft zusätzlich, dass eine tatsächliche Ordnerfreigabe den Versand auslöst und den Ordnernamen enthält.

Um Resend für den Compose-Stack zu konfigurieren, `src/backend/.env` als zusätzliches `--env-file` und nach den regulären Compose-Dateien `-f deployment/compose.resend.yml` angeben. Benötigt die bestehende Konfiguration weitere Umgebungsdateien, müssen diese ebenfalls angegeben werden. Der Backend-Container muss mit der Änderung neu erstellt werden. Die `.env`-Datei und der API-Key dürfen nicht in das Repository gelangen.

### Einladungen und Passwortvergabe

Die Nutzerverwaltung erstellt Konten mit einem zufälligen Startgeheimnis und versendet einen einmaligen Einladungslink. Über „Einladen“ kann ein Administrator für ein bestehendes Konto einen neuen Link senden; jeder neue Link ersetzt den vorherigen. Der Link ist 24 Stunden gültig. Nur sein Hash wird gespeichert; nach erfolgreicher Passwortvergabe wird er ungültig. Bei erfolgreicher Passwortvergabe werden bestehende Anmeldesitzungen ungültig.

`PUBLIC_APP_URL` legt die Basisadresse im Link fest und verwendet lokal standardmäßig `http://localhost:8080`. Für den Zugriff von anderen Geräten muss eine für den Empfänger erreichbare HTTPS-Adresse konfiguriert werden. Der SMTP-Versand muss entsprechend eingerichtet sein; bei einem Versandfehler bleibt das Konto bestehen und die Einladung kann erneut gesendet werden.
