# Integrationstest: Bereichsfreigabe und E-Mail

Im Projektstamm `./tests/run-integration.sh` ausführen. Voraussetzung sind Node.js 22+, Docker mit laufendem Daemon und Compose sowie Zugriff auf die Docker-Registry und das npm-Registry für den Image-Build. Der Test erstellt PostgreSQL, den S3-kompatiblen Testserver S3Mock, Mailpit und das echte Backend über eine eigene Compose-Konfiguration. Er meldet sich als Admin an, legt einen Nutzer und einen Ordner an, gibt den Ordner frei, prüft dessen Sichtbarkeit für den Nutzer und liest Empfänger, Betreff und Ordner-ID der tatsächlichen Nachricht über die Mailpit-API aus.

Jeder Lauf erhält einen zufälligen Compose-Projektnamen, eigene Container, ein internes Netzwerk, ein eigenes Compose-Datenbankvolume und einen kurzlebigen Testcontainer. Es werden keine Host-Ports veröffentlicht. Der Mailserver ist Mailpit und das Compose-Netz ist intern: Der Test ist nicht für echten Mailversand eingerichtet. Das Skript entfernt beim regulären Abschluss, Fehler und abfangbaren Abbruch nur Ressourcen seines eigenen Projekts und das dabei gebaute Projekt-Image. Bei gewaltsamem Abbruch (z. B. SIGKILL oder Stromausfall) muss das zuvor ausgegebene Projekt bei Bedarf manuell mit `docker compose -p <projektname> -f tests/compose.integration.yml down --volumes --remove-orphans --rmi local` aufgeräumt werden. Niemals einen anderen Projektnamen einsetzen.

Der Test prüft keinen vollständigen S3-Datei-Upload; der S3-kompatible Dienst wird beim Backend-Start zur Bucket-Initialisierung benötigt. S3Mock ersetzt für diesen Test das in der Demo konfigurierte MinIO-Image, dessen Registry-Verfügbarkeit je nach Umgebung abweichen kann. Das S3Mock-Image ist über einen Digest festgelegt.

`./tests/run-integration.sh --ui` führt zusätzlich den Chromium-Test im selben internen Compose-Netz aus. Er nutzt die ausgelieferte Angular-Oberfläche via Nginx, legt ein Testkonto unter `example.test` an und prüft Login, Konten und Ordner anlegen, Upload, Umbenennen, Ersetzen, Kopieren, Verschieben und Löschen. In einer mobilen Ansicht prüft er die Sichtbarkeit einer einzeln freigegebenen Datei ohne Elternpfad und vergleicht den Download mit dem zuvor ersetzten Inhalt. Der Build des Testcontainers benötigt zusätzlich Zugriff auf die Alpine-Paketquelle für Chromium. Beim manuellen Aufräumen eines UI-Testlaufs beide Compose-Dateien und `--profile test` angeben.

`./tests/run-integration.sh --office` aktiviert im isolierten Projekt auch ONLYOFFICE Docs und führt den Office-Browsertest aus. Der Test erzeugt eine DOCX-Datei mit fett formatiertem Text und eine XLSX-Datei mit einer Formel, bearbeitet sie in Chromium und prüft die erneut heruntergeladenen Office-Dateien. Dafür braucht Docker zusätzlich Platz für das gepinnte ONLYOFFICE-Image und Chromium. Das Editor-Netz und die Testdaten gehören ausschließlich dem jeweiligen Testprojekt.

Wenn im Docker-Datenträger kein Platz für den Chromium-Container ist, kann derselbe Browsertest einen installierten lokalen Chrome verwenden. Auf macOS zum Beispiel mit `CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ./tests/run-office-host.sh`. Der Hostmodus benötigt zusätzlich npm, OpenSSL und freie Loopback-Ports 8080, 8082 und 8026. Er startet ein neues Compose-Projekt, installiert die Testbibliotheken temporär und räumt beides wieder auf.

### Abdeckung der UI-Abläufe

| Bereich | Prüfung gegen echte Dienste |
| --- | --- |
| Anmeldung und Konten | Browser für Admin und normales Konto, ungültiges Passwort, Abmeldung sowie Konten anlegen und anzeigen. Ergänzende API-Aufrufe prüfen gesperrte Kontenverwaltung und Zugriff ohne Token. |
| Ordner | Browser für Wurzel- und Unterordner, sichtbare Inhalte und Breadcrumbs. Ein rekursiver Löschversuch ohne ausreichende Rechte bleibt folgenlos. Ein Versuch mit ausdrücklichem Datei- und Ordnerlöschrecht entfernt den Baum. |
| Dateien | Browser für Upload, Download mit Inhaltsvergleich, Umbenennen, Inhalt ersetzen, Kopieren, Verschieben und Löschen. Als eingeschränktes Konto sind Änderungen an fremden Dateien und eigene Löschung allein mit `upload` gesperrt. |
| Freigaben und SMTP | Browser für Einzeldateifreigabe, vererbte Ordnerfreigabe und beide Widerrufe per ID. Die Mailpit-API prüft Empfänger, Betreff und Ordner-ID. |
| Office | Browser für die DOCX- und XLSX-Bearbeitung mit anschließendem Download und XML-Prüfung. Start- und Speicherberechtigungen, Widerruf während einer Sitzung, Versionskonflikte und ungültige Callbacks sind zusätzlich in den Backend-Unit-Tests mit Testdoubles abgedeckt. |

`--office` und der Hostmodus führen alle Browserszenarien aus. `--ui` prüft die Dateiaustausch- und Berechtigungsabläufe ohne Editor. Für Änderungen von E-Mail-Adresse oder Passwort bestehender Konten sowie den Export verworfener Editoränderungen gibt es derzeit keine öffentlichen API-Funktionen.

`dragdrop.smoke.mjs` gehört zu beiden UI-Testvarianten. Der Test speist mehrere externe Dateien über die nativen Chrome-Typen `File` und `DataTransfer` ein. Er kontrolliert Teilerfolg, gespeicherte Bytes, echte Browser-Ziehgesten auf Ordnerbaum und Ordnerzeile, verweigerte Drops sowie den zugänglichen Namen und die Position des mobilen Aktionsmenüs. Der Test erzeugt keinen systemweiten Desktop-Drag.

Der [Konten-Browsertest](accounts.smoke.mjs) prüft die Kontotyp-Zuordnung, die Verwaltung direkter Ordner- und Dateifreigaben, die daraus wirksamen Rechte und das Schließen der Zeilenmenüs per Klick außerhalb.
