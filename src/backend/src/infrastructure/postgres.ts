import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Database, Repository, ReadRepository, TrashItem, ActivityItem } from '../application/ports.js';
import { fail } from '../application/errors.js';
import type { AccountType, DirectShare, FileRecord, FileVersion, Folder, ShareInput, ShareRights, User } from '../domain/models.js';
import { rights, type Rights } from '../domain/permissions.js';

class PostgresRepository implements Repository {
  constructor(private readonly client: PoolClient) {}

  async acquireFileLock(fileId: string, userId: string, token: string) {
    const result = await this.client.query(`INSERT INTO file_edit_locks (file_id,user_id,token,expires_at)
      VALUES ($1,$2,$3,now()+interval '2 minutes') ON CONFLICT (file_id) DO UPDATE
      SET user_id=EXCLUDED.user_id,token=EXCLUDED.token,expires_at=EXCLUDED.expires_at
      WHERE file_edit_locks.expires_at <= now() RETURNING file_id`, [fileId, userId, token]);
    return !!result.rowCount;
  }
  async renewFileLock(fileId: string, userId: string, token: string) {
    const result = await this.client.query(`UPDATE file_edit_locks SET expires_at=now()+interval '2 minutes'
      WHERE file_id=$1 AND user_id=$2 AND token=$3 AND expires_at>now() RETURNING file_id`, [fileId, userId, token]);
    return !!result.rowCount;
  }
  async releaseFileLock(fileId: string, userId: string, token: string) {
    await this.client.query('DELETE FROM file_edit_locks WHERE file_id=$1 AND user_id=$2 AND token=$3', [fileId, userId, token]);
  }
  async fileLockMatches(fileId: string, userId: string, token?: string) {
    const result = await this.client.query(`SELECT user_id,token FROM file_edit_locks WHERE file_id=$1 AND expires_at>now()`, [fileId]);
    return token ? !!result.rows[0] && result.rows[0].user_id === userId && result.rows[0].token === token : !result.rows[0];
  }

  async getUser(id: string) {
    return (await this.client.query('SELECT id,email,is_admin,account_type,is_active,session_version FROM users WHERE id=$1', [id])).rows[0] as User | undefined;
  }
  async getUserByEmail(email: string) {
    return (await this.client.query('SELECT * FROM users WHERE email=$1', [email])).rows[0] as (User & { password_hash: string }) | undefined;
  }
  async listUsers() { return (await this.client.query('SELECT id,email,is_admin,account_type,is_active,session_version FROM users ORDER BY email')).rows as User[]; }
  async createUser(id: string, email: string, hash: string, admin: boolean, accountType?: AccountType) {
    await this.client.query('INSERT INTO users (id,email,password_hash,is_admin,account_type) VALUES ($1,$2,$3,$4,$5)',
      [id, email, hash, admin, accountType ?? null]);
  }
  async setAccountType(id: string, accountType: AccountType) {
    const result = await this.client.query('UPDATE users SET account_type=$2 WHERE id=$1', [id, accountType]);
    return !!result.rowCount;
  }
  async promoteInternalUser(id: string) {
    const result = await this.client.query("UPDATE users SET is_admin=true WHERE id=$1 AND account_type='internal' RETURNING id", [id]);
    return !!result.rowCount;
  }
  async countActiveAdmins() {
    return Number((await this.client.query('SELECT count(*) AS count FROM users WHERE is_admin AND is_active')).rows[0].count);
  }
  async setUserActive(id: string, active: boolean) {
    await this.client.query('UPDATE users SET is_active=$2, session_version=session_version+CASE WHEN is_active AND NOT $2::boolean THEN 1 ELSE 0 END WHERE id=$1', [id, active]);
  }
  async revokeUserSessions(id: string) {
    await this.client.query('UPDATE users SET session_version=session_version+1 WHERE id=$1', [id]);
  }
  async saveInvitation(userId: string, tokenHash: string) {
    await this.client.query(`INSERT INTO user_invitations (user_id, token_hash, expires_at) VALUES ($1,$2,now()+interval '24 hours')
      ON CONFLICT (user_id) DO UPDATE SET token_hash=EXCLUDED.token_hash, expires_at=EXCLUDED.expires_at`, [userId, tokenHash]);
  }
  async consumeInvitation(tokenHash: string, passwordHash: string) {
    const result = await this.client.query(`DELETE FROM user_invitations WHERE token_hash=$1 AND expires_at > now() RETURNING user_id`, [tokenHash]);
    if (!result.rows[0]) return false;
    await this.client.query('UPDATE users SET password_hash=$2,session_version=session_version+1 WHERE id=$1', [result.rows[0].user_id, passwordHash]);
    return true;
  }
  async listUserShares(userId: string): Promise<DirectShare[]> {
    const result = await this.client.query(`SELECT s.id, s.folder_id AS "folderId", s.file_id AS "fileId",
      COALESCE(d.name, f.name) AS name, s.permission, s.delete_files AS "deleteFiles",
      s.delete_folders AS "deleteFolders", s.expires_at AS "expiresAt"
      FROM shares s LEFT JOIN folders d ON d.id=s.folder_id LEFT JOIN files f ON f.id=s.file_id
      WHERE s.user_id=$1 ORDER BY name, s.id`, [userId]);
    return result.rows as DirectShare[];
  }
  async listObjectShares(folderId?: string, fileId?: string) {
    const result = await this.client.query(`SELECT s.id, s.user_id AS "userId", u.email,
      s.folder_id AS "folderId", s.file_id AS "fileId", COALESCE(d.name,f.name) AS name,
      s.permission, s.delete_files AS "deleteFiles", s.delete_folders AS "deleteFolders", s.granted_by AS "grantedBy", s.expires_at AS "expiresAt"
      FROM shares s JOIN users u ON u.id=s.user_id LEFT JOIN folders d ON d.id=s.folder_id
      LEFT JOIN files f ON f.id=s.file_id WHERE ($1::uuid IS NOT NULL AND s.folder_id=$1)
      OR ($2::uuid IS NOT NULL AND s.file_id=$2) ORDER BY u.email`, [folderId ?? null, fileId ?? null]);
    return result.rows as Array<DirectShare & { userId: string; email: string; grantedBy: string | null }>;
  }
  async getShare(id: string) {
    const result = await this.client.query(`SELECT s.id, s.user_id AS "userId", s.granted_by AS "grantedBy",
      s.folder_id AS "folderId", s.file_id AS "fileId", COALESCE(d.name,f.name) AS name,
      s.permission,s.delete_files AS "deleteFiles",s.delete_folders AS "deleteFolders",s.expires_at AS "expiresAt"
      FROM shares s LEFT JOIN folders d ON d.id=s.folder_id LEFT JOIN files f ON f.id=s.file_id WHERE s.id=$1`, [id]);
    return result.rows[0] as (DirectShare & { userId: string; grantedBy: string | null }) | undefined;
  }
  async getFolder(id: string) {
    const row = (await this.client.query('SELECT * FROM folders WHERE id=$1 AND trash_id IS NULL', [id])).rows[0] as Folder | undefined;
    return row ?? fail(404, 'Ordner nicht gefunden');
  }
  async getFile(id: string) {
    const row = (await this.client.query('SELECT * FROM files WHERE id=$1 AND trash_id IS NULL', [id])).rows[0] as FileRecord | undefined;
    return row ?? fail(404, 'Datei nicht gefunden');
  }
  async listFolders() { return (await this.client.query('SELECT * FROM folders WHERE trash_id IS NULL ORDER BY name')).rows as Folder[]; }
  async listFiles() { return (await this.client.query(`SELECT f.*, creator.email AS created_by_email, editor.email AS updated_by_email,
    locker.email AS locked_by_email FROM files f LEFT JOIN users creator ON creator.id=f.owner_id
    LEFT JOIN users editor ON editor.id=f.updated_by LEFT JOIN file_edit_locks l ON l.file_id=f.id AND l.expires_at>now()
    LEFT JOIN users locker ON locker.id=l.user_id WHERE f.trash_id IS NULL ORDER BY f.name`)).rows as FileRecord[]; }
  async findFilesByName(folderId: string, name: string) {
    return (await this.client.query('SELECT * FROM files WHERE folder_id=$1 AND name=$2 AND trash_id IS NULL ORDER BY id', [folderId, name])).rows as FileRecord[];
  }
  async listFileVersions(fileId: string) {
    return (await this.client.query(`SELECT v.*, u.email AS saved_by_email FROM file_versions v LEFT JOIN users u ON u.id=v.saved_by WHERE v.file_id=$1 ORDER BY v.saved_at DESC, v.id`, [fileId])).rows as FileVersion[];
  }
  async getFileVersion(fileId: string, id: string) {
    return (await this.client.query('SELECT * FROM file_versions WHERE file_id=$1 AND id=$2', [fileId, id])).rows[0] as FileVersion | undefined;
  }
  async recordFileVersion(id: string, file: FileRecord) {
    await this.client.query('INSERT INTO file_versions (id,file_id,object_key,content_type,size,version,saved_at,saved_by) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now()),$8)', [id, file.id, file.object_key, file.content_type, file.size, file.version ?? null, file.updated_at ?? file.created_at ?? null, file.updated_by ?? file.owner_id]);
  }
  async folderRights(user: User, id: string): Promise<Rights> {
    return this.effectiveRights(user, id, undefined, new Set());
  }
  async fileRights(user: User, file: FileRecord): Promise<Rights> {
    return this.effectiveRights(user, file.folder_id, file, new Set());
  }
  private async effectiveRights(user: User, folderId: string, file: FileRecord | undefined, visited: Set<string>): Promise<Rights> {
    if (user.is_admin) return rights(true, []);
    const result = await this.client.query(`WITH RECURSIVE ancestors AS (
      SELECT id,parent_id FROM folders WHERE id=$1
      UNION ALL SELECT f.id,f.parent_id FROM folders f JOIN ancestors a ON f.id=a.parent_id
    ) SELECT s.id,s.folder_id,s.file_id,s.granted_by,s.permission,s.delete_files,s.delete_folders
      FROM shares s WHERE s.user_id=$2 AND (s.expires_at IS NULL OR s.expires_at>now()) AND (s.file_id=$3 OR s.folder_id IN (SELECT id FROM ancestors))`,
    [folderId, user.id, file?.id ?? null]);
    const effective = rights(false, []);
    for (const share of result.rows) {
      if (visited.has(share.id)) continue;
      const requested = rights(false, [share]);
      if (!share.granted_by) {
        for (const key of Object.keys(effective) as Array<keyof Rights>) effective[key] ||= requested[key];
        continue;
      }
      // Delegated rights remain valid only while the grantor still has those rights.
      // Track the current share path to stop cyclic delegations from granting access.
      const grantor = await this.getUser(share.granted_by);
      if (!grantor || grantor.is_active === false || (!grantor.is_admin && grantor.account_type !== 'internal')) continue;
      const path = new Set(visited).add(share.id);
      const scopeFile = share.file_id ? await this.getFile(share.file_id) : undefined;
      const source = await this.effectiveRights(grantor, share.folder_id ?? scopeFile!.folder_id, scopeFile, path);
      const readable = source.read || !!scopeFile && scopeFile.owner_id === grantor.id;
      effective.read ||= requested.read && readable;
      effective.upload ||= requested.upload && readable && source.upload;
      effective.write ||= requested.write && readable && source.write;
      effective.deleteFiles ||= requested.deleteFiles && readable && (source.deleteFiles || !!scopeFile && scopeFile.owner_id === grantor.id && source.write);
      effective.deleteFolders ||= requested.deleteFolders && readable && source.deleteFolders;
    }
    return effective;
  }
  async insertFolder(f: Folder) { await this.client.query('INSERT INTO folders (id,name,parent_id,owner_id) VALUES ($1,$2,$3,$4)', [f.id, f.name, f.parent_id, f.owner_id]); }
  async insertFile(f: FileRecord) { await this.client.query('INSERT INTO files (id,name,folder_id,owner_id,object_key,content_type,size,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$4)', [f.id, f.name, f.folder_id, f.owner_id, f.object_key, f.content_type, f.size]); }
  async updateFile(id: string, name: string, folderId: string, actorId: string) { await this.client.query('UPDATE files SET name=$1,folder_id=$2,updated_at=now(),updated_by=$4 WHERE id=$3 AND (name IS DISTINCT FROM $1 OR folder_id IS DISTINCT FROM $2::uuid)', [name, folderId, id, actorId]); }
  async updateFileContent(id: string, key: string, contentType: string, size: number, actorId: string) { await this.client.query('UPDATE files SET object_key=$1,content_type=$2,size=$3,updated_at=now(),updated_by=$5,version=COALESCE(version,0)+1 WHERE id=$4', [key, contentType, size, id, actorId]); }
  async deleteFile(id: string) {
    await this.client.query('DELETE FROM shares WHERE file_id=$1', [id]);
    await this.client.query('DELETE FROM files WHERE id=$1', [id]);
  }
  async getTree(id: string) {
    const folders = await this.client.query(`WITH RECURSIVE tree AS (
      SELECT id,parent_id FROM folders WHERE id=$1 AND trash_id IS NULL
      UNION ALL SELECT f.id,f.parent_id FROM folders f JOIN tree t ON f.parent_id=t.id WHERE f.trash_id IS NULL
    ) SELECT id FROM tree`, [id]);
    const folderIds = folders.rows.map((f: { id: string }) => f.id);
    const files = (await this.client.query('SELECT * FROM files WHERE folder_id=ANY($1::uuid[]) AND trash_id IS NULL', [folderIds])).rows as FileRecord[];
    return { folderIds, files };
  }
  async deleteTree(folderIds: string[], fileIds: string[]) {
    await this.client.query('DELETE FROM shares WHERE folder_id=ANY($1::uuid[]) OR file_id=ANY($2::uuid[])', [folderIds, fileIds]);
    await this.client.query('DELETE FROM files WHERE folder_id=ANY($1::uuid[])', [folderIds]);
    await this.client.query('UPDATE folders SET parent_id=NULL WHERE id=ANY($1::uuid[])', [folderIds]);
    await this.client.query('DELETE FROM folders WHERE id=ANY($1::uuid[])', [folderIds]);
  }
  async listTrash(user: User) {
    const result = await this.client.query(`SELECT *, deleted_at+interval '30 days' AS expires_at FROM trash_batches WHERE ($1::boolean OR deleted_by=$2) AND deleted_at>now()-interval '30 days' ORDER BY deleted_at DESC`, [user.is_admin, user.id]);
    return result.rows as TrashItem[];
  }
  async listActivity() {
    return (await this.client.query(`SELECT e.*,u.email AS actor_email FROM activity_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.occurred_at>now()-interval '365 days' ORDER BY e.occurred_at DESC,e.id`)).rows as ActivityItem[];
  }
  async recordActivity(actorId: string, type: 'file' | 'folder', id: string, name: string, action: string) {
    await this.client.query('INSERT INTO activity_events (id,object_type,object_id,object_name,action,actor_id) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), type, id, name, action, actorId]);
  }
  async purgeActivity() { await this.client.query("DELETE FROM activity_events WHERE occurred_at<=now()-interval '365 days'"); }
  async getTrash(id: string) {
    return (await this.client.query(`SELECT *,deleted_at+interval '30 days' AS expires_at FROM trash_batches WHERE id=$1 AND deleted_at>now()-interval '30 days'`, [id])).rows[0] as TrashItem | undefined;
  }
  async listTrashObjects(id: string) {
    const result = await this.client.query("SELECT 'file' AS kind,id,name FROM files WHERE trash_id=$1 UNION ALL SELECT 'folder' AS kind,id,name FROM folders WHERE trash_id=$1", [id]);
    return result.rows as Array<{ kind: 'file' | 'folder'; id: string; name: string }>;
  }
  async trashFile(batchId: string, userId: string, file: FileRecord) {
    await this.client.query("INSERT INTO trash_batches (id,kind,target_id,parent_id,name,deleted_by) VALUES ($1,'file',$2,$3,$4,$5)", [batchId, file.id, file.folder_id, file.name, userId]);
    await this.client.query('UPDATE files SET trash_id=$1 WHERE id=$2 AND trash_id IS NULL', [batchId, file.id]);
  }
  async trashTree(batchId: string, userId: string, folder: Folder, folderIds: string[], fileIds: string[]) {
    await this.client.query("INSERT INTO trash_batches (id,kind,target_id,parent_id,name,deleted_by) VALUES ($1,'folder',$2,$3,$4,$5)", [batchId, folder.id, folder.parent_id, folder.name, userId]);
    await this.client.query('UPDATE folders SET trash_id=$1 WHERE id=ANY($2::uuid[]) AND trash_id IS NULL', [batchId, folderIds]);
    await this.client.query('UPDATE files SET trash_id=$1 WHERE id=ANY($2::uuid[]) AND trash_id IS NULL', [batchId, fileIds]);
  }
  async restoreTrash(id: string) {
    await this.client.query('UPDATE folders SET trash_id=NULL WHERE trash_id=$1', [id]);
    await this.client.query('UPDATE files SET trash_id=NULL WHERE trash_id=$1', [id]);
    await this.client.query('DELETE FROM trash_batches WHERE id=$1', [id]);
  }
  async listExpiredTrash() {
    return (await this.client.query("SELECT id FROM trash_batches WHERE deleted_at<=now()-interval '30 days' ORDER BY deleted_at")).rows.map((row: { id: string }) => row.id);
  }
  async trashPurgeKeys(id: string) {
    const blocked = await this.client.query(`SELECT 1 FROM folders child WHERE child.parent_id IN (SELECT id FROM folders WHERE trash_id=$1) AND child.trash_id IS DISTINCT FROM $1
      UNION ALL SELECT 1 FROM files child WHERE child.folder_id IN (SELECT id FROM folders WHERE trash_id=$1) AND child.trash_id IS DISTINCT FROM $1 LIMIT 1`, [id]);
    if (blocked.rowCount) fail(409, 'Untergeordnete Papierkorbeinträge müssen zuerst entfernt werden.');
    const result = await this.client.query('SELECT object_key FROM files WHERE trash_id=$1 UNION ALL SELECT v.object_key FROM file_versions v JOIN files f ON f.id=v.file_id WHERE f.trash_id=$1', [id]);
    return result.rows.map((row: { object_key: string }) => row.object_key);
  }
  async purgeTrash(id: string) {
    await this.client.query('DELETE FROM shares WHERE file_id IN (SELECT id FROM files WHERE trash_id=$1) OR folder_id IN (SELECT id FROM folders WHERE trash_id=$1)', [id]);
    await this.client.query('DELETE FROM files WHERE trash_id=$1', [id]);
    await this.client.query('UPDATE folders SET parent_id=NULL WHERE trash_id=$1', [id]);
    await this.client.query('DELETE FROM folders WHERE trash_id=$1', [id]);
    await this.client.query('DELETE FROM trash_batches WHERE id=$1', [id]);
  }
  async insertShare(id: string, s: ShareInput, grantedBy?: string) {
    await this.client.query('INSERT INTO shares (id,user_id,folder_id,file_id,permission,delete_files,delete_folders,granted_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, s.userId, s.folderId ?? null, s.fileId ?? null, s.permission, s.deleteFiles, s.deleteFolders, grantedBy ?? null, s.expiresAt ?? null]);
  }
  async updateShare(id: string, changes: ShareRights) {
    const { rows } = await this.client.query('SELECT folder_id FROM shares WHERE id=$1', [id]);
    if (!rows[0]) return false;
    if (changes.deleteFolders && !rows[0].folder_id) fail(400, 'Ordnerlöschrecht nur für Ordner');
    await this.client.query('UPDATE shares SET permission=$2, delete_files=$3, delete_folders=$4, expires_at=CASE WHEN $5::boolean THEN $6::timestamptz ELSE expires_at END WHERE id=$1',
      [id, changes.permission, changes.deleteFiles, changes.deleteFolders, changes.expiresAt !== undefined, changes.expiresAt ?? null]);
    return true;
  }
  async deleteShare(id: string) { return !!(await this.client.query('DELETE FROM shares WHERE id=$1', [id])).rowCount; }
}

export class PostgresDatabase implements Database {
  readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString }); }
  async read<T>(work: (repo: ReadRepository) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { return await work(new PostgresRepository(client)); } finally { client.release(); }
  }
  async execute<T>(work: (repo: Repository) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { return await work(new PostgresRepository(client)); } finally { client.release(); }
  }
  async transaction<T>(work: (repo: Repository) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize tree/share mutations with the authorization checks in the same transaction.
      await client.query('SELECT pg_advisory_xact_lock(7342901)');
      const result = await work(new PostgresRepository(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}
