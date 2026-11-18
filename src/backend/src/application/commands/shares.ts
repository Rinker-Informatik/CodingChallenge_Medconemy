import { randomUUID } from 'node:crypto';
import type { ShareInput, ShareRights, User } from '../../domain/models.js';
import { fail } from '../errors.js';
import { canReadFile, canDeleteFile } from '../../domain/permissions.js';
import type { Database, Notifier, ReadRepository } from '../ports.js';

export class ShareCommands {
  constructor(private readonly db: Database, private readonly notifier: Notifier) {}

  private requireShareManager(user: User) {
    if (!user.is_admin && user.account_type !== 'internal') fail(403, 'Nur interne Konten dürfen Freigaben verwalten.');
  }

  private async checkScope(repo: ReadRepository, user: User, target: { folderId?: string | null; fileId?: string | null }, requested?: ShareRights) {
    if (target.folderId) {
      await repo.getFolder(target.folderId);
      const allowed = await repo.folderRights(user, target.folderId);
      if (!allowed.read) fail(403, 'Kein Zugriff auf diesen Ordner.');
      if (requested && ((requested.permission === 'upload' && !allowed.upload) || (requested.permission === 'write' && !allowed.write)
        || (requested.deleteFiles && !allowed.deleteFiles) || (requested.deleteFolders && !allowed.deleteFolders))) fail(403, 'Du kannst nur deine eigenen Rechte weitergeben.');
    } else {
      const file = await repo.getFile(target.fileId!);
      const allowed = await repo.fileRights(user, file);
      if (!canReadFile(user.is_admin, file.owner_id === user.id, allowed)) fail(403, 'Kein Zugriff auf diese Datei.');
      if (requested && ((requested.permission === 'upload' && !allowed.upload) || (requested.permission === 'write' && !allowed.write)
        || (requested.deleteFiles && !canDeleteFile(user.is_admin, file.owner_id === user.id, allowed)) || requested.deleteFolders)) fail(403, 'Du kannst nur deine eigenen Rechte weitergeben.');
    }
  }

  async listObjectShares(user: User, input: { folderId?: string; fileId?: string }) {
    this.requireShareManager(user);
    return this.db.read(async repo => {
      if (user.is_admin) {
        if (input.folderId) await repo.getFolder(input.folderId);
        else await repo.getFile(input.fileId!);
      } else await this.checkScope(repo, user, input);
      const shares = await repo.listObjectShares(input.folderId, input.fileId);
      return user.is_admin ? shares : shares.filter(share => share.grantedBy === user.id);
    });
  }

  async grantShare(user: User, input: ShareInput) {
    this.requireShareManager(user);
    if (!user.is_admin && user.id === input.userId) fail(400, 'Eine Freigabe an das eigene Konto ist nicht möglich.');
    if (input.fileId && input.deleteFolders) fail(400, 'Ordnerlöschrecht nur für Ordner');
    const id = randomUUID();
    const { email, name } = await this.db.transaction(async repo => {
      if (!user.is_admin) await this.checkScope(repo, user, input, input);
      const name = input.folderId ? (await repo.getFolder(input.folderId)).name : (await repo.getFile(input.fileId!)).name;
      const recipient = await repo.getUser(input.userId);
      if (!recipient) return fail(404, 'Nutzer nicht gefunden');
      await repo.insertShare(id, input, user.is_admin ? undefined : user.id);
      await repo.recordActivity(user.id, input.folderId ? 'folder' : 'file', input.folderId ?? input.fileId!, name, 'Freigabe erteilt');
      return { email: recipient.email, name };
    });
    let notified = true;
    if (input.folderId) {
      try { await this.notifier.folderShared(email, name); }
      catch (error) { notified = false; console.error('Mail failed', error); }
    }
    return { id, notified: input.folderId ? notified : null };
  }
  async changeShare(user: User, id: string, changes: ShareRights) {
    this.requireShareManager(user);
    const updated = await this.db.transaction(async repo => {
      const share = await repo.getShare(id);
      if (!share || (!user.is_admin && share.grantedBy !== user.id)) fail(404, 'Freigabe nicht gefunden');
      if (!user.is_admin) {
        await this.checkScope(repo, user, share, changes);
      }
      const updated = await repo.updateShare(id, changes);
      if (updated) await repo.recordActivity(user.id, share.folderId ? 'folder' : 'file', share.folderId ?? share.fileId!, share.name, 'Freigabe geändert');
      return updated;
    });
    if (!updated) fail(404, 'Freigabe nicht gefunden');
  }

  async revokeShare(user: User, id: string) {
    this.requireShareManager(user);
    const deleted = await this.db.transaction(async repo => {
      const share = await repo.getShare(id);
      if (!share || (!user.is_admin && share.grantedBy !== user.id)) fail(404, 'Freigabe nicht gefunden');
      const deleted = await repo.deleteShare(id);
      if (deleted) await repo.recordActivity(user.id, share.folderId ? 'folder' : 'file', share.folderId ?? share.fileId!, share.name, 'Freigabe widerrufen');
      return deleted;
    });
    if (!deleted) fail(404, 'Freigabe nicht gefunden');
  }
}
