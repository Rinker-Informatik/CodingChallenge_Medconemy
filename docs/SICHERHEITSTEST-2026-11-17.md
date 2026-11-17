# Sicherheitsprüfung vom 17. November 2026

## Umfang und Vorgehen

Gezielte Prüfung des lokalen Entwicklungsstands in einer isolierten Docker-Umgebung mit PostgreSQL, S3-Mock, Mailpit, Backend und UI. Getestet wurden Authentifizierung, direkte Objektzugriffe, Rechteausweitung, Eingabevalidierung, Einladungen und ausgewählte Konfigurationen. Ergänzend wurde der Quellcode für Sitzungen, Passwortverarbeitung und Bereitstellung geprüft. Die Tests nutzten ausschließlich eigene Testkonten und Testdaten.

Dies ist eine begrenzte technische Sicherheitsprüfung, kein vollständiger unabhängiger Penetrationstest und keine Freigabe für den Produktivbetrieb. Ein externer Deployment-, Infrastruktur-, Last-, vollständiger Abhängigkeits- und Office-Integrationstest war nicht Bestandteil dieser Prüfung.

## Feststellungen

1. **Hoch – BCrypt schneidet mehrbyteige Passwörter ab (reproduziert).** Die API begrenzt Passwörter auf 72 Zeichen, BCrypt verarbeitet jedoch nur die ersten 72 UTF-8-Bytes. Beispiel: `ä` 36-mal gefolgt von `A` und dasselbe Präfix gefolgt von `B` sind unterschiedliche, gültige 37-Zeichen-Passwörter, erzeugen aber einen übereinstimmenden BCrypt-Vergleich. Betroffen sind Passwortvergabe und Anmeldung. Maßnahme: ein Passwort-Hash-Verfahren ohne diese stille Abschneidung einsetzen oder UTF-8-Byte-Länge an allen Eingabepfaden strikt begrenzen; bestehende Konten und Migration berücksichtigen.
2. **Hoch bei öffentlich erreichbarer Bereitstellung – Demo-Konfiguration enthält feste Zugangsdaten und offene Ports (Codeprüfung).** `src/backend/docker-compose.yml` enthält bekannte Admin-, JWT- und Storage-Secrets und bindet Dienste an Host-Ports. Die Dokumentation kennzeichnet diese Konfiguration als Demo. Maßnahme: ausschließlich isoliert lokal verwenden; für produktive Bereitstellung getrennte sichere Secrets, Netzwerkgrenzen und TLS konfigurieren.
3. **Mittel bis hoch – Kein Anwendungslimit für Anmeldeversuche (Codeprüfung).** Der Login-Endpunkt besitzt keine erkennbare Begrenzung oder Sperre. Dadurch sind automatisierte Passwortversuche möglich; ein vorgeschalteter Schutz wurde nicht geprüft. Maßnahme: verteiltes Rate-Limiting für Konto und Quelle, Monitoring und geeignete Schutzmechanismen ergänzen.
4. **Mittel – Sitzungen sind nicht widerrufbar (Codeprüfung).** JWTs gelten acht Stunden; Abmeldung entfernt das Token nur im Browser. Auch ein neu gesetztes Passwort invalidiert bereits ausgestellte Tokens nicht. Ein gestohlenes Token bleibt bis zum Ablauf nutzbar. Maßnahme: serverseitigen Sitzungswiderruf beziehungsweise Token-Versionierung und Widerruf bei Passwortwechsel einführen.
5. **Mittel – Fehlende Browser-Sicherheitsheader und skriptlesbares Token (Codeprüfung).** Die mitgelieferte Nginx-Konfiguration setzt keine CSP oder vergleichbaren Sicherheitsheader; das Bearer-Token liegt in `sessionStorage`. Bei einer erfolgreichen XSS-Schwachstelle könnte fremdes Skript das Token auslesen. Eine XSS-Ausnutzung wurde nicht nachgewiesen. Maßnahme: CSP und weitere passende Header ergänzen und Sitzungsarchitektur samt XSS-Schutz prüfen.

## Erfolgreiche Prüfungen

- Ohne Token und mit manipuliertem Token werden geschützte Dateilisten abgewiesen.
- Ein reguläres Konto kann nicht auf eine fremde, nicht freigegebene Datei zugreifen, sie ändern oder löschen, deren Ordner löschen, Freigaben vergeben oder ein Administratorkonto anlegen.
- Einzelfreigaben und vererbte Ordnerfreigaben wurden mit echter Datenbank und Objektspeicher geprüft; direkte Downloads nicht freigegebener Dateien werden abgewiesen.
- Ein vorhandener Administrator kann über die Oberfläche einen weiteren Administrator einladen. Passwortvergabe, Anmeldung und administrative Kontoanlage funktionieren; ein Einladungslink lässt sich nicht erneut verwenden.
- Ein einfacher SQL-Injection-Versuch im E-Mail-Feld und ein Pfad-Traversal-Name wurden abgewiesen. Das beweist keine allgemeine Freiheit von Injection-Schwachstellen.

Ausführung: `tests/run-integration.sh --ui`; drei API-Integrationstests und fünf Browser-Tests bestanden. Der BCrypt-Nachweis wurde separat mit der installierten `bcryptjs`-Version ausgeführt.
