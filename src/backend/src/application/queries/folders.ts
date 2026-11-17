import type { User } from '../../domain/models.js';
import type { QueryDatabase } from '../ports.js';

export class FolderQueries {
  constructor(private readonly db: QueryDatabase) {}

  async listVisibleFolders(user: User) {
    return this.db.read(async repo => {
      const visible = [];
      for (const folder of await repo.listFolders()) {
        const rights = await repo.folderRights(user, folder.id);
        if (rights.read) visible.push({ ...folder, rights });
      }
      const visibleIds = new Set(visible.map(folder => folder.id));
      return visible.map(folder => ({
        ...folder,
        parent_id: folder.parent_id && visibleIds.has(folder.parent_id) ? folder.parent_id : null,
      }));
    });
  }
}
