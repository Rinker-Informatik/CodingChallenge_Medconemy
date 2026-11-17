// Run explicitly via npm run mail:test; not part of the unit suite.
import { MailNotifier } from '../src/infrastructure/services.js';

const password = process.env.RESEND_API_KEY?.trim();
const from = process.env.RESEND_FROM?.trim();
const recipient = process.env.RESEND_TEST_TO?.trim();
if (!password || password === 'HIER_API_KEY_EINTRAGEN' || !from || !recipient) {
  console.error('Bitte RESEND_API_KEY, RESEND_FROM und RESEND_TEST_TO in src/backend/.env setzen.');
  process.exit(1);
}
const notifier = new MailNotifier({ host: 'smtp.resend.com', port: 465, secure: true, requireTLS: false,
  from, user: 'resend', password });
try {
  await notifier.folderShared(recipient, 'Testordner');
  console.log('Resend hat die Testnachricht angenommen.');
} catch {
  console.error('Der SMTP-Versand über Resend ist fehlgeschlagen. Bitte Zugangsdaten und Absenderdomain prüfen.');
  process.exitCode = 1;
}
