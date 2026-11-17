# Medconemy Dateiaustausch

Eine Webanwendung zum gemeinsamen Austausch und Bearbeiten von Dateien. Medconemy verbindet eine Angular-Oberfläche mit einer Express-API, PostgreSQL und einem S3-kompatiblen Dateispeicher. Dateien und Ordner können gezielt für interne und externe Konten freigegeben werden.

> **Projektstatus:** Lokale Demo und Entwicklungsprojekt. Die mitgelieferte Konfiguration ist nicht für den produktiven Einsatz oder echte vertrauliche Daten ausgelegt.

[Funktionsumfang](#funktionen) · [Schnellstart](#schnellstart) · [Entwicklung](#entwicklung) · [Tests](#tests) · [Mitwirken](#mitwirken) · [Lizenz](#lizenz)

## Funktionen

- **Dateien und Ordner:** Hochladen, herunterladen, umbenennen, kopieren, verschieben und löschen. Mehrere Dateien lassen sich per Drag-and-drop hochladen; das Limit beträgt 10 MiB pro Datei.
- **Freigaben:** Einzelne Dateien oder Ordner mit vererbten Rechten freigeben. Neben Lesen, Hochladen und Schreiben lassen sich Löschrechte und ein optionales Ablaufdatum festlegen. Interne Konten können höchstens ihre eigenen Rechte weitergeben.
- **Versionen und Papierkorb:** Frühere Dateistände herunterladen oder wiederherstellen. Gelöschte Dateien und Ordner bleiben 30 Tage im Papierkorb, bevor sie automatisch bereinigt werden.
- **Bearbeitung:** UTF-8-Textdateien direkt bearbeiten und optional DOCX- und XLSX-Dateien mit ONLYOFFICE öffnen. Bearbeitungssperren schützen vor parallelem Überschreiben.
- **Konten:** Administratoren können Konten anlegen, interne Konten zu Administratoren machen, Konten deaktivieren und Sitzungen widerrufen. Einladungen und Passwort-Resets erfolgen über zeitlich begrenzte Links.
- **Übersicht:** Suche über zugängliche Inhalte mit Filtern sowie ein berechtigungsabhängiges Aktivitätsprotokoll der letzten 365 Tage.

## Schnellstart

### Voraussetzungen

- [Docker](https://www.docker.com/) mit laufendem Docker-Daemon und Docker Compose ab Version 2.24.4
- Git und Netzwerkzugriff zum Laden der Docker-Images und npm-Pakete
- Freie lokale Ports **8080** und **8026**

### Starten

```bash
git clone https://github.com/Rinker-Informatik/CodingChallenge_Meconemy.git
cd CodingChallenge_Meconemy

docker compose -p medconemy \
  -f src/backend/docker-compose.yml \
  -f deployment/compose.ui.yml \
  up -d --build
```

Nach der Initialisierung von Datenbank und Dateispeicher erreichst du:

| Dienst | Adresse |
| --- | --- |
| Weboberfläche | [http://localhost:8080](http://localhost:8080) |
| Mailpit – lokale Test-E-Mails | [http://localhost:8026](http://localhost:8026) |

Für eine **neu initialisierte lokale Datenbank** wird folgendes Demo-Administratorkonto angelegt:

| | |
| --- | --- |
| E-Mail | `admin@example.test` |
| Passwort | `demo-admin-password` |

Ein bestehendes Konto wird beim Neustart nicht auf dieses Passwort zurückgesetzt. Einladungen und Passwort-Reset-Links landen in der Standardkonfiguration in Mailpit; es werden dabei keine echten E-Mails zugestellt.

Zum Stoppen:

```bash
docker compose -p medconemy \
  -f src/backend/docker-compose.yml \
  -f deployment/compose.ui.yml \
  down
```

Die Datenbank und der Dateispeicher verwenden Docker-Volumes und bleiben bei `down` erhalten. Die Option `--volumes` entfernt diese Daten dauerhaft.

### Optional: Office-Bearbeitung

Für DOCX- und XLSX-Bearbeitung kann ONLYOFFICE zusätzlich gestartet werden. Lege einen eigenen zufälligen Schlüssel fest und behalte ihn für die Dauer des Compose-Projekts bei:

```bash
export OFFICE_SECRET="$(openssl rand -hex 32)"

docker compose -p medconemy \
  -f src/backend/docker-compose.yml \
  -f deployment/compose.ui.yml \
  -f deployment/compose.office.yml \
  up -d --build
```

Die Oberfläche bleibt auf Port **8080**; der Browser erreicht die Editor-Komponenten über Port **8082**. Der erste Start des Office-Dienstes kann einige Zeit dauern. Zum Verwalten oder Stoppen dieser Variante dieselben Compose-Dateien und denselben `OFFICE_SECRET` verwenden. ONLYOFFICE ist ein eigenständiger Dienst mit eigener Lizenz; siehe [ONLYOFFICE Document Server](https://github.com/ONLYOFFICE/DocumentServer).

## Verwendung

1. Als Administrator anmelden und unter **Nutzerverwaltung** ein Konto anlegen. Der Einladungslink kann in Mailpit geöffnet werden.
2. Einen Ordner erstellen und Dateien hochladen.
3. Über **Aktionen → Freigeben** an einer Datei oder einem Ordner Zugriff für ein Konto einrichten. Bestehende direkte Freigaben lassen sich dort ändern oder widerrufen.
4. Unter **Aktionen → Versionsverlauf** frühere Dateistände ansehen und bei ausreichender Berechtigung wiederherstellen. Der Verlauf beginnt mit Änderungen, die seit Aktivierung der Versionierung vorgenommen wurden.
5. Gelöschte Elemente über **Papierkorb** wiederherstellen; Aktivitäten sind über **Aktivitätsprotokoll** sichtbar.

Die API prüft Berechtigungen serverseitig. Ordnerfreigaben gelten auch für enthaltene Dateien und Unterordner. Weitergegebene Berechtigungen werden eingeschränkt, wenn die zugrunde liegenden Rechte wegfallen oder ablaufen.

## Technologie und Projektstruktur

| Bereich | Technologie |
| --- | --- |
| Frontend | Angular, TypeScript, Spartan UI, Tailwind CSS |
| Backend | Node.js, Express, TypeScript |
| Daten | PostgreSQL und S3-kompatibler Objektspeicher |
| Lokale Dienste | Docker Compose, S3Mock und Mailpit |
| Office – optional | ONLYOFFICE Docs |

```text
src/backend/    Express-API, Datenmodell und Backend-Tests
src/ui/         Angular-Oberfläche und UI-Tests
deployment/     Compose-Erweiterungen für UI, Office und SMTP
tests/          Isolierte Integrations- und Browsertests
docs/           Funktions- und Sicherheitsdokumentation
```

## Entwicklung

Für die lokale Entwicklung außerhalb der Container wird Node.js 22 ab Version **22.12** benötigt. Abhängigkeiten und Prüfungen getrennt für Backend und Frontend ausführen:

```bash
npm --prefix src/backend ci
npm --prefix src/backend run typecheck
npm --prefix src/backend test

npm --prefix src/ui ci
npm --prefix src/ui run typecheck
npm --prefix src/ui test
npm --prefix src/ui run build
```

Die Compose-Oberflächenkonfiguration verwendet S3Mock für die lokale Entwicklung; die eigenständige Backend-Konfiguration verwendet MinIO. SMTP kann über die Umgebungsvariablen des Backends und optional `deployment/compose.resend.yml` eingerichtet werden. Zugangsdaten gehören in eine lokale Umgebungsdatei oder einen Secret-Speicher und nicht ins Repository. `PUBLIC_APP_URL` bestimmt die Basisadresse für Einladungs- und Passwortlinks.

## Tests

Die Integrationsskripte erstellen ein eigenes Compose-Projekt mit isolierter Datenbank und Testdaten:

```bash
# API, PostgreSQL, S3Mock und Mailpit
./tests/run-integration.sh

# Zusätzlich Browser-Tests mit Chromium
./tests/run-integration.sh --ui

# Zusätzlich ONLYOFFICE und Office-Browser-Tests
./tests/run-integration.sh --office
```

Der erste Lauf benötigt Netzwerkzugriff und kann wegen des Image-Builds länger dauern. Weitere Hinweise stehen in der [Testdokumentation](tests/README.md).

## Projektstatus und Sicherheit

Die Compose-Konfiguration enthält öffentliche Demo-Zugangsdaten und ist für die lokale Entwicklung vorgesehen. Vor einem produktiven Einsatz sind insbesondere eine abgesicherte Bereitstellung mit TLS, geeignete Geheimnisverwaltung, Schutz vor automatisierten Anmeldeversuchen und eine erneute Sicherheitsprüfung erforderlich. Die vorhandene [Sicherheitsprüfung](docs/SICHERHEITSTEST-2026-11-17.md) beschreibt ihren damaligen Umfang und ersetzt keinen vollständigen unabhängigen Penetrationstest.

Die Dokumentation unter `src/backend`, `src/ui` und `docs` enthält zusätzliche Hintergründe; einzelne dort beschriebene Verhaltensweisen können älter als der aktuelle Code sein.

## Mitwirken

Fehlerberichte, Ideen und Pull Requests sind willkommen. Beschreibe bei Fehlern möglichst die Schritte zur Reproduktion, das erwartete Verhalten und deine Umgebung. Führe für Änderungen die zum betroffenen Bereich passenden Tests aus und halte Pull Requests auf einen nachvollziehbaren Umfang begrenzt.

## Lizenz

Dieses Projekt steht unter der [Apache License 2.0](LICENSE). Für eingebundene Abhängigkeiten und optional betriebene Dienste gelten deren jeweilige Lizenzen.
