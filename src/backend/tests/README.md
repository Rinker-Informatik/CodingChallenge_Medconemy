# Testübersicht

`npm test` führt die isolierten Tests aus. `npm run coverage` misst mit der experimentellen Node-Test-Coverage die beim Testen geladenen Dateien unter `src`; `npm run typecheck` prüft auch die Tests. Die Zähler sind kein Nachweis, dass alle denkbaren Fälle getestet sind.

| Öffentliche Schnittstellen | Nachweis |
| --- | --- |
| `rights`, `canReadFile`, `canEditFile`, `canDeleteFile`, `canDeleteTree` | `permissions.test.ts`, ergänzend `use-cases.test.ts` |
| `AccountCommands.signIn/createUser`, `AccountQueries.authenticateToken/listUsers` | `use-cases.test.ts`: Erfolg, falsche Zugangsdaten, fehlende Konten und Adminprüfung |
| `FolderCommands.createFolder/deleteFolderTree`, `FolderQueries.listVisibleFolders` | `use-cases.test.ts`: vererbte Rechte, Wurzelordner, Sichtbarkeit und vollständige Löschprüfung |
| `FileCommands.uploadFile/replaceFileContent/copyFile/changeFileMetadata/deleteFile`, `FileQueries.listVisibleFiles/downloadFile` | `use-cases.test.ts`: Berechtigungen, Zielrechte und Fehlerbereinigung |
| `ShareCommands.grantShare/revokeShare` | `use-cases.test.ts`: Adminprüfung, fehlender Empfänger, Benachrichtigung und Widerruf |
| `PostgresDatabase.read/execute/transaction` und die darüber zugänglichen `Repository`-Methoden | `infrastructure.test.ts`: simulierter Client, Datenübergabe, Commit, Rollback und Freigabe |
| `JwtCredentials.hash/verify/issueToken/verifyToken`, `S3ObjectStore.ensureBucket/put/get/delete`, `MailNotifier.folderShared` | `infrastructure.test.ts`: echte lokale Kryptoprüfung; S3 und Mail simuliert |
| `createApp`, `route`, `authentication`, `errorHandler`, `requireAdmin`, `fail`, `requirePermission` und `AppError` | `http.test.ts` und die Anwendungsfalltests; HTTP-Anfragen laufen über In-Memory-Streams mit simulierten Handlern |

Die öffentliche `pool`-Eigenschaft ist eine Bibliotheksinstanz; deren eigene Methoden sind nicht Teil der Backend-Unit-Tests. Konstruktoren werden beim Erzeugen der getesteten Klassen durchlaufen. Reine TypeScript-Typen und Interfaces haben kein Laufzeitverhalten. Der nicht exportierte Prozesseinstieg `src/server.ts` verbindet reale Dienste und startet den Listener; er wird nicht importiert, weil dies externe Dienste und einen offenen Port voraussetzt. Er erscheint daher auch nicht im Coverage-Bericht. Die Tests beweisen nicht die Ausführung der SQL-Abfragen gegen PostgreSQL, die Kommunikation mit S3/SMTP, alle HTTP-Fehlerzweige oder das Verhalten bei Prozessabstürzen und Commitfehlern. Dafür sind gesonderte Integrationstests nötig.

`office.test.ts` prüft die öffentlichen Editorsitzungs- und ONLYOFFICE-Adaptermethoden über den Sessionablauf, einschließlich JWT-Geltungsbereich, Widerruf, Versionskonflikt, doppeltem Callback und sicherer Ergebnisabfrage. Der Browser-Test im Projektstamm prüft die HTTP-Routen und die Kommunikation mit dem echten Editor.
