import { randomUUID } from 'node:crypto';
import type { User } from '../../domain/models.js';
import { canDeleteTree } from '../../domain/permissions.js';
import { requireAdmin } from '../authorization.js';
import { fail, requirePermission } from '../errors.js';
import type { Database, ObjectStore } from '../ports.js';

export class FolderCommands {
  constructor(private readonly db: Database, private readonly objects: ObjectStore) {}

  async createFolder(user: User, name: string, parentId: string | null) {
    const id = randomUUID();
    await this.db.transaction(async repo => {
      if (parentId) {
        await repo.getFolder(parentId);
        requirePermission((await repo.folderRights(user, parentId)).write);
      } else requireAdmin(user);
      await repo.insertFolder({ id, name, parent_id: parentId, owner_id: user.id });
      await repo.recordActivity(user.id, 'folder', id, name, 'Ordner erstellt');
    });
    return { id };
  }
  async deleteFolderTree(user: User, id: string) {
    await this.db.transaction(async repo => {
      const folder = await repo.getFolder(id);
      const { folderIds, files } = await repo.getTree(id);
      const folderRights = [];
      for (const folderId of folderIds) folderRights.push(await repo.folderRights(user, folderId));
      const fileRights = [];
      for (const file of files) fileRights.push({ owner: file.owner_id === user.id, rights: await repo.fileRights(user, file) });
      requirePermission(canDeleteTree(user.is_admin, folderRights, fileRights));
      for (const file of files) {
        if (!await repo.fileLockMatches(file.id, user.id)) fail(409, 'Ein Ordnerinhalt wird gerade bearbeitet.');
      }
      const nested = [];
      for (const folderId of folderIds) if (folderId !== id) nested.push(await repo.getFolder(folderId));
      await repo.trashTree(randomUUID(), user.id, folder, folderIds, files.map(file => file.id));
      await repo.recordActivity(user.id, 'folder', id, folder.name, 'Ordner gelöscht');
      for (const child of nested) await repo.recordActivity(user.id, 'folder', child.id, child.name, 'Ordner gelöscht');
      for (const file of files) await repo.recordActivity(user.id, 'file', file.id, file.name, 'Datei gelöscht');
    });
  }
}
