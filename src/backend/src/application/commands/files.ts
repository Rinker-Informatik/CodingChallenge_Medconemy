import { randomUUID } from 'node:crypto';
import type { FileRecord, Upload, User } from '../../domain/models.js';
import { canDeleteFile, canEditFile } from '../../domain/permissions.js';
import { fail, requirePermission } from '../errors.js';
import type { Database, ObjectStore } from '../ports.js';

export class FileCommands {
  constructor(private readonly db: Database, private readonly objects: ObjectStore) {}

  async acquireEditLock(user: User, id: string) {
    const token = randomUUID();
    await this.db.transaction(async repo => {
      const file = await repo.getFile(id);
      requirePermission(canEditFile(user.is_admin, file.owner_id === user.id, await repo.fileRights(user, file)));
      if (!await repo.acquireFileLock(id, user.id, token)) fail(409, 'Diese Datei wird bereits bearbeitet.');
    });
    return { token };
  }
  async renewEditLock(user: User, id: string, token: string) {
    await this.db.transaction(async repo => {
      const file = await repo.getFile(id);
      requirePermission(canEditFile(user.is_admin, file.owner_id === user.id, await repo.fileRights(user, file)));
      if (!await repo.renewFileLock(id, user.id, token)) fail(409, 'Die Bearbeitungssperre ist abgelaufen. Bitte den Text sichern und die Datei erneut öffnen.');
    });
  }
  async releaseEditLock(user: User, id: string, token: string) {
    await this.db.transaction(repo => repo.releaseFileLock(id, user.id, token));
  }

  async uploadFile(user: User, folderId: string, name: string, upload: Upload, conflict: { keep?: boolean; replaceId?: string } = {}) {
    const id = randomUUID(), key = randomUUID();
    return this.db.transaction(async repo => {
      await repo.getFolder(folderId);
      requirePermission((await repo.folderRights(user, folderId)).upload);
      const matches = await repo.findFilesByName(folderId, name);
      if (conflict.replaceId) {
        const existing = matches.find(file => file.id === conflict.replaceId);
        if (!existing) return fail(409, 'Die ausgewählte Datei ist nicht mehr vorhanden oder wurde umbenannt.');
        requirePermission(canEditFile(user.is_admin, existing.owner_id === user.id, await repo.fileRights(user, existing)));
        if (!await repo.fileLockMatches(existing.id, user.id)) return fail(409, 'Diese Datei wird gerade bearbeitet.');
        await this.objects.put(key, upload);
        try {
          await repo.recordFileVersion(randomUUID(), existing);
          await repo.updateFileContent(existing.id, key, upload.contentType, upload.size, user.id);
          await repo.recordActivity(user.id, 'file', existing.id, existing.name, 'Dateiinhalt geändert');
        } catch (error) { await this.objects.delete(key).catch(console.error); throw error; }
        return { id: existing.id };
      }
      if (matches.length && !conflict.keep) return fail(409, 'Eine Datei mit diesem Namen existiert bereits.');
      await this.objects.put(key, upload);
      try {
        await repo.insertFile({ id, name, folder_id: folderId, owner_id: user.id, object_key: key, content_type: upload.contentType, size: String(upload.size) });
        await repo.recordActivity(user.id, 'file', id, name, 'Datei hochgeladen');
      } catch (error) {
        await this.objects.delete(key).catch(console.error);
        throw error;
      }
      return { id };
    });
  }
  async replaceFileContent(user: User, id: string, upload: Upload, expected?: { objectKey: string; extension: string }, lockToken?: string) {
    const key = randomUUID();
    await this.db.transaction(async repo => {
      const actor = expected ? await repo.getUser(user.id) : user;
      if (!actor || actor.is_active === false || (expected && (actor.session_version ?? 0) !== (user.session_version ?? 0))) return fail(403, 'Konto oder Sitzung hat keinen Zugriff mehr.');
      const file = await repo.getFile(id);
      requirePermission(canEditFile(actor.is_admin, file.owner_id === actor.id, await repo.fileRights(actor, file)));
      if (!await repo.fileLockMatches(id, actor.id, lockToken)) fail(409, lockToken ? 'Die Bearbeitungssperre ist abgelaufen. Bitte den Text sichern und die Datei erneut öffnen.' : 'Diese Datei wird bereits bearbeitet.');
      if (expected && (file.object_key !== expected.objectKey || !file.name.toLowerCase().endsWith('.' + expected.extension))) {
        fail(409, 'Die Datei wurde inzwischen geändert. Diese Fassung wurde nicht übernommen.');
      }
      await this.objects.put(key, upload);
      try {
        await repo.recordFileVersion(randomUUID(), file);
        await repo.updateFileContent(id, key, upload.contentType, upload.size, actor.id);
        await repo.recordActivity(actor.id, 'file', id, file.name, 'Dateiinhalt geändert');
      }
      catch (error) { await this.objects.delete(key).catch(console.error); throw error; }
    });
  }
  async restoreVersion(user: User, fileId: string, versionId: string) {
    await this.db.transaction(async repo => {
      const file = await repo.getFile(fileId);
      requirePermission(canEditFile(user.is_admin, file.owner_id === user.id, await repo.fileRights(user, file)));
      if (!await repo.fileLockMatches(fileId, user.id)) fail(409, 'Diese Datei wird gerade bearbeitet.');
      const version = await repo.getFileVersion(fileId, versionId);
      if (!version) return fail(404, 'Dateiversion nicht gefunden.');
      const data = await this.objects.get(version.object_key);
      const key = randomUUID();
      await this.objects.put(key, { buffer: data, contentType: version.content_type, size: data.length });
      try {
        await repo.recordFileVersion(randomUUID(), file);
        await repo.updateFileContent(fileId, key, version.content_type, data.length, user.id);
        await repo.recordActivity(user.id, 'file', fileId, file.name, 'Dateiversion wiederhergestellt');
      } catch (error) { await this.objects.delete(key).catch(console.error); throw error; }
    });
  }
  async copyFile(user: User, id: string, input: { name?: string; folderId?: string }) {
    return this.applyFileChange(user, id, { ...input, copy: true });
  }
  async changeFileMetadata(user: User, id: string, input: { name?: string; folderId?: string }) {
    return this.applyFileChange(user, id, { ...input, copy: false });
  }
  private async applyFileChange(user: User, id: string, input: { name?: string; folderId?: string; copy: boolean }) {
    return this.db.transaction(async repo => {
      const file = await repo.getFile(id);
      const rights = await repo.fileRights(user, file);
      if (input.folderId || input.copy) {
        requirePermission(rights.write);
        const target = input.folderId || file.folder_id;
        await repo.getFolder(target);
        requirePermission((await repo.folderRights(user, target)).write);
        if (input.copy) {
          const data = await this.objects.get(file.object_key);
          const newId = randomUUID(), key = randomUUID();
          await this.objects.put(key, { buffer: data, contentType: file.content_type, size: Number(file.size) });
          const copy: FileRecord = { ...file, id: newId, name: input.name || file.name, folder_id: target, owner_id: user.id, object_key: key };
          try {
            await repo.insertFile(copy);
            await repo.recordActivity(user.id, 'file', newId, copy.name, 'Datei kopiert');
          } catch (error) {
            await this.objects.delete(key).catch(console.error);
            throw error;
          }
          return { id: newId };
        }
      } else requirePermission(canEditFile(user.is_admin, file.owner_id === user.id, rights));
      if (!await repo.fileLockMatches(id, user.id)) fail(409, 'Diese Datei wird gerade bearbeitet.');
      await repo.updateFile(id, input.name || file.name, input.folderId || file.folder_id, user.id);
      await repo.recordActivity(user.id, 'file', id, input.name || file.name, 'Datei geändert');
      return { id };
    });
  }
  async deleteFile(user: User, id: string) {
    await this.db.transaction(async repo => {
      const file = await repo.getFile(id);
      requirePermission(canDeleteFile(user.is_admin, file.owner_id === user.id, await repo.fileRights(user, file)));
      if (!await repo.fileLockMatches(id, user.id)) fail(409, 'Diese Datei wird gerade bearbeitet.');
      await repo.trashFile(randomUUID(), user.id, file);
      await repo.recordActivity(user.id, 'file', id, file.name, 'Datei gelöscht');
    });
  }
}
