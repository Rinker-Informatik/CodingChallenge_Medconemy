import { randomUUID } from 'node:crypto';
import type { AccountType, User } from '../../domain/models.js';
import type { Credentials, Database } from '../ports.js';
import { requireAdmin } from '../authorization.js';
import { fail } from '../errors.js';

export class AccountCommands {
  constructor(private readonly db: Database, private readonly credentials: Credentials) {}

  async signIn(email: string, password: string) {
    const user = await this.db.read(repo => repo.getUserByEmail(email.toLowerCase()));
    if (!user || user.is_active === false || !await this.credentials.verify(password, user.password_hash)) fail(401, 'Ungültige Zugangsdaten');
    return { token: this.credentials.issueToken(user.id, user.session_version ?? 0) };
  }
  async createUser(user: User, input: { email: string; password: string; isAdmin: boolean; accountType?: AccountType }) {
    requireAdmin(user);
    const id = randomUUID();
    const email = input.email.toLowerCase();
    const hash = await this.credentials.hash(input.password);
    await this.db.execute(repo => input.accountType
      ? repo.createUser(id, email, hash, input.isAdmin, input.accountType)
      : repo.createUser(id, email, hash, input.isAdmin));
    return { id, email, isAdmin: input.isAdmin, accountType: input.accountType ?? null };
  }
  async classifyAccount(user: User, id: string, accountType: AccountType) {
    requireAdmin(user);
    const updated = await this.db.execute(repo => repo.setAccountType(id, accountType));
    if (!updated) fail(404, 'Nutzer nicht gefunden');
  }
  async promoteInternalUser(user: User, id: string) {
    requireAdmin(user);
    await this.db.transaction(async repo => {
      const target = await repo.getUser(id);
      if (!target) fail(404, 'Nutzer nicht gefunden');
      if (target.account_type !== 'internal') fail(400, 'Nur interne Konten können zum Administrator ernannt werden.');
      if (!await repo.promoteInternalUser(id)) fail(409, 'Der Kontotyp wurde inzwischen geändert.');
    });
  }
  async setActive(user: User, id: string, active: boolean) {
    requireAdmin(user);
    await this.db.transaction(async repo => {
      const target = await repo.getUser(id);
      if (!target) fail(404, 'Nutzer nicht gefunden');
      if (!active && target.is_active !== false && target.is_admin && await repo.countActiveAdmins() <= 1) fail(409, 'Das letzte aktive Administratorkonto kann nicht deaktiviert werden.');
      await repo.setUserActive(id, active);
    });
  }
  async revokeSessions(user: User, id: string) {
    requireAdmin(user);
    await this.db.transaction(async repo => {
      if (!await repo.getUser(id)) fail(404, 'Nutzer nicht gefunden');
      await repo.revokeUserSessions(id);
    });
  }
}
