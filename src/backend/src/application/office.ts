import { randomUUID } from 'node:crypto';
import type { User } from '../domain/models.js';
import { canEditFile } from '../domain/permissions.js';
import { AppError, fail, requirePermission } from './errors.js';
import type { FileCommands } from './commands/files.js';
import type { Database, ObjectStore } from './ports.js';

const formats = {
  docx: { documentType: 'word', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { documentType: 'cell', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
} as const;

export const OFFICE_LIMIT = 10 * 1024 * 1024;
const SESSION_MS = 2 * 60 * 60 * 1000;
type Format = keyof typeof formats;
type State = { status: 'editing' | 'saving' | 'saved' | 'unchanged' | 'failed'; message?: string };
type Session = {
  id: string; user: User; fileId: string; objectKey: string; extension: Format;
  expires: number; state: State; lockToken: string;
};
export interface EditorGateway {
  apiScript: string;
  sourceUrl(id: string): string;
  callbackUrl(id: string): string;
  signConfig(config: object): string;
  verifySource(token: string | undefined, id: string): void;
  readCallback(token: string | undefined): { key: string; status: number; url?: string };
  fetchResult(url: string, key: string, extension: Format): Promise<Buffer>;
}

export class OfficeSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly db: Database,
    private readonly objects: Pick<ObjectStore, 'get'>,
    private readonly files: Pick<FileCommands, 'replaceFileContent'>,
    private readonly editor: EditorGateway,
  ) {}

  async open(user: User, fileId: string) {
    for (const [id, session] of this.sessions) {
      if (session.expires <= Date.now() && session.state.status !== 'saving') this.sessions.delete(id);
    }
    if (this.sessions.size >= 500) return fail(503, 'Der Editor ist ausgelastet. Bitte später erneut versuchen.');
    const lockToken = randomUUID();
    const { file, extension } = await this.db.transaction(async repo => {
      const file = await repo.getFile(fileId);
      requirePermission(canEditFile(user.is_admin, user.id === file.owner_id, await repo.fileRights(user, file)));
      const extension = /\.(docx|xlsx)$/i.exec(file.name)?.[1].toLowerCase();
      if (extension !== 'docx' && extension !== 'xlsx') return fail(415, 'Nur DOCX und XLSX lassen sich im Browser bearbeiten.');
      if (Number(file.size) > OFFICE_LIMIT) return fail(413, 'Die Datei überschreitet 10 MiB.');
      if (!await repo.acquireFileLock(fileId, user.id, lockToken)) return fail(409, 'Diese Datei wird bereits bearbeitet.');
      return { file, extension: extension as Format };
    });
    const id = randomUUID();
    const expires = Date.now() + SESSION_MS;
    const config = {
      documentType: formats[extension].documentType,
      document: { fileType: extension, key: id, title: file.name, url: this.editor.sourceUrl(id),
        permissions: { edit: true, download: false, print: false, chat: false } },
      editorConfig: { mode: 'edit', lang: 'de', callbackUrl: this.editor.callbackUrl(id),
        user: { id: user.id, name: user.email },
        customization: { forcesave: false, plugins: false, macros: false } },
    };
    try {
      const token = this.editor.signConfig(config);
      this.sessions.set(id, { id, user, fileId, objectKey: file.object_key, extension, expires, lockToken, state: { status: 'editing' } });
      return { id, apiScript: this.editor.apiScript, config: { ...config, token } };
    } catch (error) {
      await this.db.transaction(repo => repo.releaseFileLock(fileId, user.id, lockToken));
      throw error;
    }
  }

  status(user: User, id: string): State {
    const session = this.lookup(id);
    if (session.user.id !== user.id) return fail(404, 'Editorsitzung nicht gefunden.');
    return session.state;
  }

  async heartbeat(user: User, id: string) {
    const session = this.lookup(id);
    if (session.user.id !== user.id) return fail(404, 'Editorsitzung nicht gefunden.');
    if (session.state.status !== 'editing' && session.state.status !== 'saving') return fail(409, 'Editorsitzung wurde beendet.');
    await this.db.transaction(async repo => {
      const actor = await repo.getUser(user.id);
      if (!actor || actor.is_active === false || (actor.session_version ?? 0) !== (session.user.session_version ?? 0)) return fail(403, 'Konto oder Sitzung hat keinen Zugriff mehr.');
      const file = await repo.getFile(session.fileId);
      requirePermission(canEditFile(actor.is_admin, actor.id === file.owner_id, await repo.fileRights(actor, file)));
      if (!await repo.renewFileLock(session.fileId, user.id, session.lockToken)) fail(409, 'Die Bearbeitungssperre ist abgelaufen.');
    });
  }
  async close(user: User, id: string) {
    const session = this.lookup(id);
    if (session.user.id !== user.id) return fail(404, 'Editorsitzung nicht gefunden.');
    if (session.state.status === 'saving') return fail(409, 'Die Datei wird noch gespeichert.');
    if (session.state.status === 'editing') session.state = { status: 'failed', message: 'Editorsitzung geschlossen.' };
    await this.release(session);
  }
  private async release(session: Session) {
    await this.db.transaction(repo => repo.releaseFileLock(session.fileId, session.user.id, session.lockToken));
  }

  async source(id: string, token: string | undefined) {
    this.editor.verifySource(token, id);
    const session = this.lookup(id);
    if (session.state.status !== 'editing') return fail(409, 'Editorsitzung wurde beendet.');
    await this.db.read(async repo => {
      const user = await repo.getUser(session.user.id);
      if (!user || user.is_active === false || (user.session_version ?? 0) !== (session.user.session_version ?? 0)) return fail(403, 'Konto oder Sitzung hat keinen Zugriff mehr.');
      const file = await repo.getFile(session.fileId);
      requirePermission(canEditFile(user.is_admin, user.id === file.owner_id, await repo.fileRights(user, file)));
      if (file.object_key !== session.objectKey) fail(409, 'Die Datei wurde inzwischen ersetzt.');
    });
    return { data: await this.objects.get(session.objectKey), mime: formats[session.extension].mime };
  }

  async callback(id: string, token: string | undefined) {
    const event = this.editor.readCallback(token);
    if (event.key !== id) return fail(403, 'Ungültige Editorsitzung.');
    const session = this.lookup(id);
    if (session.state.status === 'saved' || session.state.status === 'unchanged') return;
    if (session.state.status !== 'editing') return fail(409, 'Editorsitzung wurde bereits verarbeitet.');
    switch (event.status) {
      case 1: return;
      case 4: session.state = { status: 'unchanged' }; await this.release(session).catch(console.error); return;
      case 3:
      case 7: session.state = { status: 'failed', message: 'Der Editor meldet einen Speicherfehler.' }; await this.release(session).catch(console.error); return;
      case 2: break;
      default: return fail(400, 'Unerwarteter Editorstatus.');
    }
    session.state = { status: 'saving' };
    try {
      if (!event.url) return fail(400, 'Speicherdatei fehlt.');
      const buffer = await this.editor.fetchResult(event.url, session.id, session.extension);
      await this.files.replaceFileContent(session.user, session.fileId,
        { buffer, size: buffer.length, contentType: formats[session.extension].mime },
        { objectKey: session.objectKey, extension: session.extension }, session.lockToken);
      session.state = { status: 'saved' };
      await this.release(session).catch(console.error);
    } catch (error) {
      session.state = { status: 'failed', message: error instanceof AppError && error.status < 500
        ? error.message : 'Die bearbeitete Datei konnte nicht übernommen werden.' };
      await this.release(session).catch(console.error);
      throw error;
    }
  }

  private lookup(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.expires <= Date.now()) return fail(404, 'Editorsitzung nicht gefunden oder abgelaufen.');
    return session;
  }
}
