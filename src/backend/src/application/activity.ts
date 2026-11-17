import type { User } from '../domain/models.js';
import { canReadFile } from '../domain/permissions.js';
import { AppError } from './errors.js';
import type { QueryDatabase } from './ports.js';

export class Activity {
  constructor(private readonly db: QueryDatabase) {}
  async list(user: User) {
    return this.db.read(async repo => {
      const events = await repo.listActivity();
      if (user.is_admin) return events;
      const access = new Map<string, boolean>();
      const visible = [];
      for (const event of events) {
        const key = event.object_type + ':' + event.object_id;
        let allowed = access.get(key);
        if (allowed === undefined) {
          try {
            if (event.object_type === 'folder') {
              await repo.getFolder(event.object_id);
              allowed = (await repo.folderRights(user, event.object_id)).read;
            } else {
              const file = await repo.getFile(event.object_id);
              allowed = canReadFile(user.is_admin, file.owner_id === user.id, await repo.fileRights(user, file));
            }
          } catch (error) {
            if (!(error instanceof AppError) || error.status !== 404) throw error;
            allowed = false;
          }
          access.set(key, allowed);
        }
        if (allowed) visible.push(event);
      }
      return visible;
    });
  }
}
