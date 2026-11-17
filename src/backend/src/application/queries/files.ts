import type { User } from '../../domain/models.js';
import { canReadFile } from '../../domain/permissions.js';
import { fail, requirePermission } from '../errors.js';
import type { QueryDatabase, ObjectStore } from '../ports.js';

export class FileQueries {
  constructor(private readonly db: QueryDatabase, private readonly objects: Pick<ObjectStore, 'get'>) {}

  async listVisibleFiles(user: User) {
    return this.db.read(async repo => {
      const visible = [];
      const readableParents = new Map<string, boolean>();
      for (const file of await repo.listFiles()) {
        const rights = await repo.fileRights(user, file);
        if (canReadFile(user.is_admin, file.owner_id === user.id, rights)) {
          const { object_key, ...safe } = file;
          let parentReadable = readableParents.get(file.folder_id);
          if (parentReadable === undefined) {
            parentReadable = (await repo.folderRights(user, file.folder_id)).read;
            readableParents.set(file.folder_id, parentReadable);
          }
          visible.push({ ...safe, folder_id: parentReadable ? file.folder_id : null, rights });
        }
      }
      return visible;
    });
  }
  async downloadFile(user: User, id: string) {
    const file = await this.db.read(async repo => {
      const file = await repo.getFile(id);
      requirePermission(canReadFile(user.is_admin, file.owner_id === user.id, await repo.fileRights(user, file)));
      return file;
    });
    return { name: file.name, data: await this.objects.get(file.object_key) };
  }
  async listVersions(user: User, id: string) {
    return this.db.read(async repo => {
      const file = await repo.getFile(id);
      requirePermission(canReadFile(user.is_admin, file.owner_id === user.id, await repo.fileRights(user, file)));
      return (await repo.listFileVersions(id)).map(({ object_key, ...version }) => version);
    });
  }
  async downloadVersion(user: User, id: string, versionId: string) {
    const version = await this.db.read(async repo => {
      const file = await repo.getFile(id);
      requirePermission(canReadFile(user.is_admin, file.owner_id === user.id, await repo.fileRights(user, file)));
      const version = await repo.getFileVersion(id, versionId);
      if (!version) return fail(404, 'Dateiversion nicht gefunden.');
      return { file, version };
    });
    return { name: version.file.name, data: await this.objects.get(version.version.object_key) };
  }
}
