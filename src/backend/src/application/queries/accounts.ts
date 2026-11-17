import type { User } from '../../domain/models.js';
import type { Credentials, QueryDatabase } from '../ports.js';
import { fail } from '../errors.js';
import { requireAdmin } from '../authorization.js';

export class AccountQueries {
  constructor(private readonly db: QueryDatabase, private readonly credentials: Pick<Credentials, 'verifyToken'> & Partial<Pick<Credentials, 'verifySession'>>) {}

  async authenticateToken(token: string | undefined): Promise<User> {
    if (!token) return fail(401, 'Anmeldung erforderlich');
    let id: string, version = 0;
    try {
      if (this.credentials.verifySession) ({ userId: id, sessionVersion: version } = this.credentials.verifySession(token));
      else id = this.credentials.verifyToken(token);
    } catch { return fail(401, 'Ungültiges Token'); }
    const user = await this.db.read(repo => repo.getUser(id));
    if (!user || user.is_active === false || (user.session_version ?? 0) !== version) return fail(401, 'Ungültiges Token');
    return user;
  }
  async listSharesForUser(user: User, id: string) {
    requireAdmin(user);
    return this.db.read(async repo => {
      if (!await repo.getUser(id)) return fail(404, 'Nutzer nicht gefunden');
      return repo.listUserShares(id);
    });
  }

  async listUsers(user: User) { requireAdmin(user); return this.db.read(repo => repo.listUsers()); }
  async listShareRecipients(user: User) {
    if (!user.is_admin && user.account_type !== 'internal') fail(403, 'Nur interne Konten dürfen Freigaben verwalten.');
    return this.db.read(async repo => (await repo.listUsers()).filter(account => account.id !== user.id && account.is_active !== false).map(({ id, email }) => ({ id, email })));
  }
}
