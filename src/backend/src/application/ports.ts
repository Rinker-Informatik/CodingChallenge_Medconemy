import type { AccountType, DirectShare, FileRecord, FileVersion, Folder, ShareInput, ShareRights, Upload, User } from '../domain/models.js';
import type { Rights } from '../domain/permissions.js';

export interface ReadRepository {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<(User & { password_hash: string }) | undefined>;
  listUsers(): Promise<User[]>;
  listUserShares(userId: string): Promise<DirectShare[]>;
  listObjectShares(folderId?: string, fileId?: string): Promise<Array<DirectShare & { userId: string; email: string; grantedBy: string | null }>>;
  getShare(id: string): Promise<(DirectShare & { userId: string; grantedBy: string | null }) | undefined>;
  getFolder(id: string): Promise<Folder>;
  getFile(id: string): Promise<FileRecord>;
  listFolders(): Promise<Folder[]>;
  listFiles(): Promise<FileRecord[]>;
  findFilesByName(folderId: string, name: string): Promise<FileRecord[]>;
  listFileVersions(fileId: string): Promise<FileVersion[]>;
  getFileVersion(fileId: string, id: string): Promise<FileVersion | undefined>;
  folderRights(user: User, id: string): Promise<Rights>;
  fileRights(user: User, file: FileRecord): Promise<Rights>;
  listTrash(user: User): Promise<TrashItem[]>;
  getTrash(id: string): Promise<TrashItem | undefined>;
  listTrashObjects(id: string): Promise<Array<{ kind: 'file' | 'folder'; id: string; name: string }>>;
  listExpiredTrash(): Promise<string[]>;
  listActivity(): Promise<ActivityItem[]>;
}

export type TrashItem = { id: string; kind: 'file' | 'folder'; target_id: string; parent_id: string | null; name: string; deleted_by: string; deleted_at: string; expires_at: string };
export type ActivityItem = { id: string; object_type: 'file' | 'folder'; object_id: string; object_name: string; action: string; actor_id: string; actor_email: string | null; occurred_at: string };

export interface Repository extends ReadRepository {
  acquireFileLock(fileId: string, userId: string, token: string): Promise<boolean>;
  renewFileLock(fileId: string, userId: string, token: string): Promise<boolean>;
  releaseFileLock(fileId: string, userId: string, token: string): Promise<void>;
  // Without a token, succeeds only when no active lock exists; with one, it must match the owner and token.
  fileLockMatches(fileId: string, userId: string, token?: string): Promise<boolean>;
  createUser(id: string, email: string, hash: string, admin: boolean, accountType?: AccountType): Promise<void>;
  setAccountType(id: string, accountType: AccountType): Promise<boolean>;
  promoteInternalUser(id: string): Promise<boolean>;
  countActiveAdmins(): Promise<number>;
  setUserActive(id: string, active: boolean): Promise<void>;
  revokeUserSessions(id: string): Promise<void>;
  saveInvitation(userId: string, tokenHash: string): Promise<void>;
  consumeInvitation(tokenHash: string, passwordHash: string): Promise<boolean>;
  insertFolder(folder: Folder): Promise<void>;
  insertFile(file: FileRecord): Promise<void>;
  updateFile(id: string, name: string, folderId: string, actorId: string): Promise<void>;
  updateFileContent(id: string, key: string, contentType: string, size: number, actorId: string): Promise<void>;
  recordFileVersion(id: string, file: FileRecord): Promise<void>;
  deleteFile(id: string): Promise<void>;
  getTree(id: string): Promise<{ folderIds: string[]; files: FileRecord[] }>;
  deleteTree(folderIds: string[], fileIds: string[]): Promise<void>;
  trashFile(batchId: string, userId: string, file: FileRecord): Promise<void>;
  trashTree(batchId: string, userId: string, folder: Folder, folderIds: string[], fileIds: string[]): Promise<void>;
  restoreTrash(id: string): Promise<void>;
  trashPurgeKeys(id: string): Promise<string[]>;
  purgeTrash(id: string): Promise<void>;
  recordActivity(actorId: string, type: 'file' | 'folder', id: string, name: string, action: string): Promise<void>;
  purgeActivity(): Promise<void>;
  insertShare(id: string, share: ShareInput, grantedBy?: string): Promise<void>;
  updateShare(id: string, changes: ShareRights): Promise<boolean>;
  deleteShare(id: string): Promise<boolean>;
}

export interface Database {
  read<T>(work: (repo: ReadRepository) => Promise<T>): Promise<T>;
  execute<T>(work: (repo: Repository) => Promise<T>): Promise<T>;
  transaction<T>(work: (repo: Repository) => Promise<T>): Promise<T>;
}
export type QueryDatabase = Pick<Database, 'read'>;

export interface ObjectStore {
  put(key: string, upload: Upload): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
export interface Notifier { folderShared(email: string, folderName: string): Promise<void> }
export interface Credentials {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
  issueToken(userId: string, sessionVersion?: number): string;
  verifyToken(token: string): string;
  verifySession?(token: string): { userId: string; sessionVersion: number };
}
