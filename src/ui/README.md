# Medconemy Dateiaustausch

Angular 21, Spartan UI 1.9 mit generierten Helm-Komponenten und Lucide-Dateisymbolen. Das Frontend verwendet die Express-API über denselben Origin unter `/api`. Der Anmeldetoken wird für den aktuellen Browser-Tab gespeichert und beim Abmelden entfernt. Nach einem Reload wird die Sitzung wiederhergestellt, solange der Token gültig ist.

Im Projektstamm mit Docker Compose ab Version 2.24.4 starten:

```sh
docker compose -p medconemy-ui -f src/backend/docker-compose.yml -f deployment/compose.ui.yml up --build
```

Sobald das Backend den S3-Bucket initialisiert hat, ist die Anmeldung verfügbar. Die Oberfläche läuft auf [localhost:8080](http://localhost:8080), Mailpit auf [localhost:8026](http://localhost:8026). Das lokale Admin-Konto lautet `admin@example.test` mit Passwort `demo-admin-password`. Der Compose-Projektname verwendet eigene Volumes für PostgreSQL und den lokalen S3Mock-Dateispeicher. Zum Stoppen denselben Compose-Befehl mit `down` statt `up --build` verwenden.

Für die Frontend-Entwicklung in `src/ui` mit Node.js 22 ab 22.12 `npm ci` und `npm start` ausführen. Der Entwicklungsproxy erwartet die Backend-API auf Port 3000. Zur Prüfung dienen `npm test`, `npm run typecheck` und `npm run build`. `./tests/run-integration.sh --ui` startet den isolierten Chromium- und Mailpit-Test vom Projektstamm.

Die Übersicht zeigt direkt freigegebene und eigene Dateien auch ohne sichtbaren Elternordner. Die API liefert für einen nicht sichtbaren Pfad `folder_id: null` beziehungsweise `parent_id: null`. Alle Änderungen werden vom Backend autorisiert.

Unter **Verwaltung → Nutzerverwaltung → Verwalten** können Admins Konten als **Intern** oder **Extern** kennzeichnen. Bestehende Konten ohne Zuordnung werden entsprechend angezeigt. Der Kontotyp ändert die Zugriffsrechte nicht. Auf derselben Seite lassen sich direkte Freigaben für Ordner und Dateien auflisten, hinzufügen, ändern und widerrufen. Die Stufen sind Lesen, Hochladen und eigene Dateien bearbeiten sowie Schreiben. Dateilöschung und Ordnerlöschung sind separat wählbar. Ordnerfreigaben wirken auf Nachfahren. Der separate Widerruf per Freigabe-ID steht weiterhin zur Verfügung.

## Dateiinformationen

Das Info-Symbol zeigt Ersteller, letzte Änderung und Inhaltsversion. Eine neue Datei beginnt bei Version 1; beim Ersetzen oder Bearbeiten des Inhalts steigt die Nummer. Umbenennen und Verschieben ändern das Änderungsdatum, aber nicht die Inhaltsversion. Frühere Inhalte werden nicht archiviert. Bei älteren Dateien stehen historische Angaben, die nicht gespeichert wurden, als nicht verfügbar; ihre Inhaltszählung beginnt mit der ersten Änderung nach Einführung der Funktion.

## Textdateien bearbeiten

TXT-Dateien in UTF-8 lassen sich über **Aktionen → Text bearbeiten** öffnen und speichern, wenn das Konto die Datei bearbeiten darf. Es gilt das Dateilimit von 10 MiB. Änderungen anderer Personen können beim Speichern überschrieben werden.

## Dateien ziehen und ablegen

Mehrere lokale Dateien lassen sich auf die Ablagefläche im geöffneten Ordner ziehen, wenn dort Uploads erlaubt sind. Die Oberfläche meldet erfolgreiche Uploads sowie Fehler je Datei. Pro Datei gilt das Limit von 10 MiB.

Ziehe eine vorhandene Datei auf einen schreibbaren Zielordner im Ordnerbaum oder in der Liste, um sie zu verschieben. Die Dateiauswahl über **Hochladen** und der Dialog **Verschieben** stehen auch auf Mobilgeräten und mit der Tastatur zur Verfügung.

## DOCX und XLSX im Browser bearbeiten

Im Projektstamm mit einem eigenen lokalen Editorsicherheitsschlüssel starten:

```sh
export OFFICE_SECRET="$(openssl rand -hex 32)"
docker compose -p medconemy-ui -f src/backend/docker-compose.yml -f deployment/compose.ui.yml -f deployment/compose.office.yml up --build
```

Den Schlüssel für die Dauer des laufenden Compose-Projekts beibehalten. Angular verwendet weiterhin Port 8080. Für die Editor-Assets und die Browser-Verbindung gibt es auf Loopback Port 8082. Die erstmalige Initialisierung von ONLYOFFICE kann etwas dauern. Bei einer DOCX- oder XLSX-Datei mit Bearbeitungsrecht **Aktionen → Im Browser bearbeiten** auswählen. **Speichern und schließen** beendet die Sitzung und wartet auf die Bestätigung des Backends. Je nach Editor dauert das einige Sekunden.

Backend und Editor kommunizieren im internen Compose-Netz. ONLYOFFICE Docs Community (AGPLv3 laut [Projekt](https://github.com/ONLYOFFICE/DocumentServer)) läuft lokal. Das Backend signiert die Konfiguration, prüft die Signatur der Editor-Aufrufe und lädt Ergebnisse ausschließlich vom konfigurierten internen Editor über den zur Sitzung gehörenden Cache-Pfad. Der private S3-Speicher bleibt hinter der API. Beim Schreiben prüft das Backend die aktuellen Rechte und den S3-Schlüssel der geöffneten Version in derselben Datenbanktransaktion wie beim normalen Ersetzen. Bei einer konkurrierenden Änderung oder einem Widerruf bleibt die vorhandene Datei erhalten.

Die Demo verwendet getrennte Editorsitzungen ohne gemeinsames Bearbeiten. Sie unterstützt unverschlüsselte DOCX- und XLSX-Dateien bis 10 MiB. Sitzungen laufen nach zwei Stunden ab und gehen bei einem Backend-Neustart verloren. Bei einem Speicherkonflikt übernimmt das Backend die bearbeitete Fassung nicht. Ein unterstützter Formatierungs- und Formelerhalt wird an einfachen Beispieldateien getestet. Der vollständige Funktionsumfang von Microsoft Office und mobile Bearbeitung wurden nicht geprüft.
