import type { User } from '../domain/models.js';
import { fail, requirePermission } from './errors.js';
import type { Database, ObjectStore } from './ports.js';

export class Trash {
  constructor(private readonly db: Database, private readonly objects: Pick<ObjectStore, 'delete'>) {}

  async list(user: User) { return this.db.read(repo => repo.listTrash(user)); }

  async restore(user: User, id: string) {
    await this.db.transaction(async repo => {
      const item = await repo.getTrash(id);
      if (!item || (!user.is_admin && item.deleted_by !== user.id)) fail(404, 'Papierkorbeintrag nicht gefunden.');
      if (item.parent_id) {
        await repo.getFolder(item.parent_id);
        requirePermission((await repo.folderRights(user, item.parent_id)).read);
      } else if (!user.is_admin) {
        requirePermission((await repo.folderRights(user, item.target_id)).read);
      }
      const entries = await repo.listTrashObjects(id);
      await repo.restoreTrash(id);
      for (const entry of entries) await repo.recordActivity(user.id, entry.kind, entry.id, entry.name, entry.kind === 'file' ? 'Datei wiederhergestellt' : 'Ordner wiederhergestellt');
    });
  }

  async purgeExpired() {
    const ids = await this.db.read(repo => repo.listExpiredTrash());
    for (const id of ids) {
      try {
        await this.db.transaction(async repo => {
          if (!(await repo.listExpiredTrash()).includes(id)) return;
          for (const key of await repo.trashPurgeKeys(id)) await this.objects.delete(key);
          await repo.purgeTrash(id);
        });
      } catch (error) { console.error('Papierkorb konnte nicht bereinigt werden:', id, error); }
    }
  }
}
