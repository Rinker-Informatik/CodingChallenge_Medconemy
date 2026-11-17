import { createHash, randomBytes } from 'node:crypto';
import type { Credentials, Database } from './ports.js';
import type { User } from '../domain/models.js';
import { requireAdmin } from './authorization.js';
import { fail } from './errors.js';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class Invitations {
  private readonly origin: string;
  constructor(private readonly db: Database, private readonly credentials: Credentials,
    private readonly notifier: { invite(email: string, link: string, reset?: boolean): Promise<void> }, appUrl: string) {
    const url = new URL(appUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_APP_URL muss eine gültige Basisadresse sein.');
    this.origin = url.origin;
  }
  async send(admin: User, userId: string, reset = false) {
    requireAdmin(admin);
    const token = randomBytes(32).toString('base64url');
    const email = await this.db.transaction(async repo => {
      const user = await repo.getUser(userId);
      if (!user) return fail(404, 'Nutzer nicht gefunden');
      await repo.saveInvitation(userId, hash(token));
      return user.email;
    });
    try {
      await this.notifier.invite(email, this.origin + '/passwort-setzen#token=' + token, reset);
      return { notified: true };
    } catch {
      return { notified: false };
    }
  }
  async accept(token: string, password: string) {
    const passwordHash = await this.credentials.hash(password);
    const updated = await this.db.transaction(repo => repo.consumeInvitation(hash(token), passwordHash));
    if (!updated) fail(400, 'Der Link ist ungültig, abgelaufen oder wurde bereits verwendet.');
  }
}
