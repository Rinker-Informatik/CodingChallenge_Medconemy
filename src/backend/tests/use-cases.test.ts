import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FolderCommands } from '../src/application/commands/folders.js';
import { Trash } from '../src/application/trash.js';
import { FileCommands } from '../src/application/commands/files.js';
import { FileQueries } from '../src/application/queries/files.js';
import { AccountQueries } from '../src/application/queries/accounts.js';
import { rights } from '../src/domain/permissions.js';
import type { Database, Repository, ObjectStore, Credentials } from '../src/application/ports.js';
import type { FileRecord, User } from '../src/domain/models.js';

const user: User = { id: 'user', email: 'user@example.test', is_admin: false };
const otherFile: FileRecord = { id: 'file', name: 'a', folder_id: 'child', owner_id: 'other', object_key: 'key', content_type: 'text/plain', size: '1' };
const noRights = rights(false, []);
const treeRights = rights(false, [{ permission: 'write', delete_files: false, delete_folders: true }]);
const allRights = rights(false, [{ permission: 'write', delete_files: true, delete_folders: true }]);
function database(repo: Partial<Repository>): Database {
  repo.fileLockMatches ??= async () => true;
  repo.recordFileVersion ??= async () => {};
  repo.listFileVersions ??= async () => [];
  repo.recordActivity ??= async () => {};
  repo.findFilesByName ??= async () => [];
  return { read: work => work(repo as Repository), execute: work => work(repo as Repository), transaction: work => work(repo as Repository) };
}
function objectStore(deleted: string[] = []): ObjectStore {
  return { put: async () => {}, get: async () => Buffer.from('x'), delete: async key => { deleted.push(key); } };
}

test('expired trash remains retryable if object deletion fails', async () => {
  let attempts = 0, purged = false;
  const repo: Partial<Repository> = {
    listExpiredTrash: async () => purged ? [] : ['batch'],
    trashPurgeKeys: async () => ['key'],
    purgeTrash: async () => { purged = true; },
  };
  const trash = new Trash(database(repo), { delete: async () => { if (++attempts === 1) throw new Error('storage unavailable'); } });
  const original = console.error;
  console.error = () => {};
  try { await trash.purgeExpired(); } finally { console.error = original; }
  assert.equal(purged, false);
  await trash.purgeExpired();
  assert.equal(purged, true);
});

test('folder deletion checks every nested folder and file before deleting anything', async () => {
  const deleted: string[] = [];
  let databaseDeleted = false;
  const repo: Partial<Repository> = {
    getFolder: async () => ({ id: 'root', name: 'root', parent_id: null, owner_id: 'other' }),
    getTree: async () => ({ folderIds: ['root', 'child'], files: [otherFile] }),
    folderRights: async () => treeRights,
    fileRights: async () => treeRights,
    trashTree: async () => { databaseDeleted = true; },
  };
  const folders = new FolderCommands(database(repo), objectStore(deleted));
  await assert.rejects(folders.deleteFolderTree(user, 'root'), { status: 403 });
  assert.equal(databaseDeleted, false);
  assert.deepEqual(deleted, []);
  repo.fileRights = async () => allRights;
  await folders.deleteFolderTree(user, 'root');
  assert.equal(databaseDeleted, true);
  assert.deepEqual(deleted, []);
});

test('a direct file read requires ownership or a share, and writes alone cannot delete foreign files', async () => {
  let deleted = false;
  const repo: Partial<Repository> = {
    getFile: async () => otherFile,
    fileRights: async () => noRights,
    trashFile: async () => { deleted = true; },
  };
  const files = new FileCommands(database(repo), objectStore());
  const queries = new FileQueries(database(repo), objectStore());
  await assert.rejects(queries.downloadFile(user, 'file'), { status: 403 });
  repo.fileRights = async () => treeRights;
  assert.equal((await queries.downloadFile(user, 'file')).data.toString(), 'x');
  await assert.rejects(files.deleteFile(user, 'file'), { status: 403 });
  assert.equal(deleted, false);
  repo.fileRights = async () => allRights;
  await files.deleteFile(user, 'file');
  assert.equal(deleted, true);
});

test('authentication verifies tokens and checks that the account still exists', async () => {
  const credentials: Credentials = {
    hash: async s => s, verify: async () => false, issueToken: () => '',
    verifyToken: token => { if (token !== 'valid') throw new Error(); return user.id; },
  };
  let account: User | undefined = user;
  const accounts = new AccountQueries(database({ getUser: async () => account }), credentials);
  await assert.rejects(accounts.authenticateToken(undefined), { status: 401 });
  await assert.rejects(accounts.authenticateToken('bad'), { status: 401 });
  assert.deepEqual(await accounts.authenticateToken('valid'), user);
  account = undefined;
  await assert.rejects(accounts.authenticateToken('valid'), { status: 401 });
});

test('file listing query returns only readable files and omits storage keys', async () => {
  const own = { ...otherFile, id: 'own', owner_id: user.id, object_key: 'own-secret' };
  const shared = { ...otherFile, id: 'shared', object_key: 'shared-secret' };
  const hidden = { ...otherFile, id: 'hidden' };
  const query = new FileQueries(database({
    listFiles: async () => [own, shared, hidden],
    folderRights: async () => noRights,
    fileRights: async (_user, file) => file.id === 'shared' ? treeRights : noRights,
  }), objectStore());
  const visible = await query.listVisibleFiles(user);
  assert.deepEqual(visible.map(file => file.id), ['own', 'shared']);
  assert.ok(visible.every(file => !('object_key' in file) && file.folder_id === null));
});

test('copy command requires write access to source and destination before accessing storage', async () => {
  let readObject = false;
  let inserted = false;
  let sourceRights = noRights;
  let destinationRights = noRights;
  const repo: Partial<Repository> = {
    getFile: async () => otherFile,
    getFolder: async id => ({ id, name: 'target', parent_id: null, owner_id: 'other' }),
    fileRights: async () => sourceRights,
    folderRights: async () => destinationRights,
    insertFile: async () => { inserted = true; },
  };
  const store: ObjectStore = { ...objectStore(), get: async () => { readObject = true; return Buffer.from('x'); } };
  const commands = new FileCommands(database(repo), store);
  await assert.rejects(commands.copyFile(user, 'file', { folderId: 'target' }), { status: 403 });
  sourceRights = treeRights;
  await assert.rejects(commands.copyFile(user, 'file', { folderId: 'target' }), { status: 403 });
  assert.equal(readObject, false);
  assert.equal(inserted, false);
  destinationRights = treeRights;
  const result = await commands.copyFile(user, 'file', { folderId: 'target' });
  assert.ok(result.id);
  assert.equal(inserted, true);
});

test('commands reject non-admin account creation before accessing credentials or database', async () => {
  const { AccountCommands } = await import('../src/application/commands/accounts.js');
  const credentials: Credentials = {
    hash: async () => { throw new Error('should not hash'); },
    verify: async () => false, issueToken: () => '', verifyToken: () => '',
  };
  const commands = new AccountCommands(database({}), credentials);
  await assert.rejects(commands.createUser(user, { email: 'x@example.test', password: 'long-password', isAdmin: false }), { status: 403 });
});

test('sign-in validates credentials and normalizes email; admin creates accounts', async () => {
  const { AccountCommands } = await import('../src/application/commands/accounts.js');
  const admin = { ...user, is_admin: true };
  let stored: unknown[] = [];
  const repo: Partial<Repository> = {
    getUserByEmail: async email => email === 'user@example.test' ? { ...user, password_hash: 'hash' } : undefined,
    createUser: async (...args) => { stored = args; },
    listUsers: async () => [user],
  };
  const creds: Credentials = { hash: async () => 'hash', verify: async password => password === 'correct', issueToken: id => `token:${id}`, verifyToken: () => user.id };
  const commands = new AccountCommands(database(repo), creds);
  await assert.rejects(commands.signIn('absent@example.test', 'correct'), { status: 401 });
  await assert.rejects(commands.signIn(user.email, 'wrong'), { status: 401 });
  assert.deepEqual(await commands.signIn('USER@example.test', 'correct'), { token: 'token:user' });
  const result = await commands.createUser(admin, { email: 'NEW@example.test', password: 'secret', isAdmin: false });
  assert.deepEqual(stored, [result.id, 'new@example.test', 'hash', false]);
  const queries = new AccountQueries(database(repo), creds);
  await assert.rejects(queries.listUsers(user), { status: 403 });
  assert.deepEqual(await queries.listUsers(admin), [user]);
});

test('folder creation and listing honor inherited folder rights', async () => {
  const { FolderQueries } = await import('../src/application/queries/folders.js');
  const parent = { id: 'parent', name: 'parent', parent_id: null, owner_id: 'other' };
  let currentRights = noRights;
  let inserted: unknown;
  const repo: Partial<Repository> = {
    getFolder: async () => parent,
    folderRights: async (_user, id) => id === 'parent' ? currentRights : noRights,
    listFolders: async () => [parent, { ...parent, id: 'hidden' }],
    insertFolder: async folder => { inserted = folder; },
  };
  const commands = new FolderCommands(database(repo), objectStore());
  await assert.rejects(commands.createFolder(user, 'root', null), { status: 403 });
  await assert.rejects(commands.createFolder(user, 'child', 'parent'), { status: 403 });
  currentRights = treeRights;
  const result = await commands.createFolder(user, 'child', 'parent');
  assert.deepEqual(inserted, { id: result.id, name: 'child', parent_id: 'parent', owner_id: user.id });
  assert.deepEqual((await new FolderQueries(database(repo)).listVisibleFolders(user)).map(folder => folder.id), ['parent']);
  await commands.createFolder({ ...user, is_admin: true }, 'root', null);
});

test('file uploads and replacements enforce permissions and clean failed writes', async () => {
  const own = { ...otherFile, owner_id: user.id };
  const upload = { buffer: Buffer.from('new'), contentType: 'text/plain', size: 3 };
  let currentRights = noRights;
  let failInsert = false;
  let failUpdate = false;
  const puts: string[] = [], deleted: string[] = [];
  let saved: FileRecord | undefined;
  const repo: Partial<Repository> = {
    getFolder: async id => ({ id, name: 'folder', parent_id: null, owner_id: user.id }),
    folderRights: async () => currentRights,
    getFile: async () => own,
    fileRights: async () => currentRights,
    fileLockMatches: async () => true,
    insertFile: async file => { if (failInsert) throw new Error('insert failed'); saved = file; },
    updateFileContent: async () => { if (failUpdate) throw new Error('update failed'); },
  };
  const store: ObjectStore = { ...objectStore(deleted), put: async key => { puts.push(key); } };
  const commands = new FileCommands(database(repo), store);
  await assert.rejects(commands.uploadFile(user, 'f', 'a.txt', upload), { status: 403 });
  await assert.rejects(commands.replaceFileContent(user, 'file', upload), { status: 403 });
  assert.deepEqual(puts, []);
  currentRights = treeRights;
  const result = await commands.uploadFile(user, 'f', 'a.txt', upload);
  assert.equal(saved?.id, result.id);
  assert.equal(saved?.object_key, puts[0]);
  failInsert = true;
  await assert.rejects(commands.uploadFile(user, 'f', 'a.txt', upload), /insert failed/);
  assert.equal(deleted.at(-1), puts.at(-1));
  failUpdate = true;
  await assert.rejects(commands.replaceFileContent(user, 'file', upload), /update failed/);
  assert.equal(deleted.at(-1), puts.at(-1));
  failUpdate = false;
  await commands.replaceFileContent(user, 'file', upload);
  assert.notEqual(deleted.at(-1), own.object_key);
});

test('metadata changes require ownership or write rights and check destination on moves', async () => {
  let currentRights = noRights;
  let destinationRights = noRights;
  let updated: unknown[] = [];
  const own = { ...otherFile, owner_id: user.id };
  const repo: Partial<Repository> = {
    getFile: async () => own,
    fileRights: async () => currentRights,
    folderRights: async () => destinationRights,
    getFolder: async id => ({ id, name: 'target', parent_id: null, owner_id: user.id }),
    updateFile: async (...args) => { updated = args; },
  };
  const commands = new FileCommands(database(repo), objectStore());
  await assert.rejects(commands.changeFileMetadata(user, own.id, { name: 'new' }), { status: 403 });
  currentRights = rights(false, [{ permission: 'upload', delete_files: false, delete_folders: false }]);
  assert.deepEqual(await commands.changeFileMetadata(user, own.id, { name: 'new' }), { id: own.id });
  assert.deepEqual(updated, [own.id, 'new', own.folder_id, user.id]);
  await assert.rejects(commands.changeFileMetadata(user, own.id, { folderId: 'target' }), { status: 403 });
  currentRights = treeRights;
  await assert.rejects(commands.changeFileMetadata(user, own.id, { folderId: 'target' }), { status: 403 });
  destinationRights = treeRights;
  await commands.changeFileMetadata(user, own.id, { folderId: 'target' });
  assert.deepEqual(updated, [own.id, own.name, 'target', user.id]);
});

test('share commands enforce admin access, notify on folders and revoke shares', async () => {
  const { ShareCommands } = await import('../src/application/commands/shares.js');
  const admin = { ...user, is_admin: true };
  const base = { userId: user.id, permission: 'read' as const, deleteFiles: false, deleteFolders: false };
  const notifications: string[] = [];
  let exists = true;
  let saved = false;
  const repo: Partial<Repository> = {
    getFolder: async id => ({ id, name: 'Projektunterlagen', parent_id: null, owner_id: user.id }),
    getFile: async () => otherFile,
    getUser: async () => exists ? user : undefined,
    insertShare: async () => { saved = true; },
    deleteShare: async () => exists,
    getShare: async () => exists ? { id: 'id', userId: user.id, grantedBy: null, folderId: 'folder', fileId: null, name: 'folder', permission: 'read', deleteFiles: false, deleteFolders: false } : undefined,
  };
  const commands = new ShareCommands(database(repo), { folderShared: async (email, id) => { notifications.push(`${email}:${id}`); } });
  await assert.rejects(commands.grantShare(user, { ...base, folderId: 'folder' }), { status: 403 });
  await assert.rejects(commands.grantShare(admin, { ...base, fileId: 'file', deleteFolders: true }), { status: 400 });
  exists = false;
  await assert.rejects(commands.grantShare(admin, { ...base, folderId: 'folder' }), { status: 404 });
  assert.equal(saved, false);
  exists = true;
  assert.equal((await commands.grantShare(admin, { ...base, folderId: 'folder' })).notified, true);
  assert.deepEqual(notifications, ['user@example.test:Projektunterlagen']);
  assert.equal((await commands.grantShare(admin, { ...base, fileId: 'file' })).notified, null);
  await assert.rejects(commands.revokeShare(user, 'id'), { status: 403 });
  await commands.revokeShare(admin, 'id');
  exists = false;
  await assert.rejects(commands.revokeShare(admin, 'id'), { status: 404 });
});

test('copy removes the new object when saving its metadata fails', async () => {
  const deleted: string[] = [], stored: string[] = [];
  const repo: Partial<Repository> = {
    getFile: async () => otherFile,
    getFolder: async id => ({ id, name: 'target', parent_id: null, owner_id: user.id }),
    fileRights: async () => treeRights,
    folderRights: async () => treeRights,
    insertFile: async () => { throw new Error('database unavailable'); },
  };
  const store: ObjectStore = { ...objectStore(deleted), put: async key => { stored.push(key); } };
  await assert.rejects(new FileCommands(database(repo), store).copyFile(user, otherFile.id, {}), /database unavailable/);
  assert.deepEqual(deleted, stored);
});

test('failed notification is reported without undoing the folder share', async t => {
  const { ShareCommands } = await import('../src/application/commands/shares.js');
  t.mock.method(console, 'error', () => {});
  let saved = false;
  const repo: Partial<Repository> = {
    getFolder: async id => ({ id, name: 'folder', parent_id: null, owner_id: user.id }),
    getUser: async () => user,
    insertShare: async () => { saved = true; },
  };
  const commands = new ShareCommands(database(repo), { folderShared: async () => { throw new Error('offline'); } });
  const result = await commands.grantShare({ ...user, is_admin: true }, { userId: user.id, folderId: 'folder', permission: 'read', deleteFiles: false, deleteFolders: false });
  assert.equal(result.notified, false);
  assert.equal(saved, true);
});

test('admins classify existing accounts and list or change direct shares without resending mail', async () => {
  const { AccountCommands } = await import('../src/application/commands/accounts.js');
  const { ShareCommands } = await import('../src/application/commands/shares.js');
  const admin = { ...user, is_admin: true };
  const direct = { id: 'grant', folderId: 'child', fileId: null, name: 'Austausch',
    permission: 'read' as const, deleteFiles: false, deleteFolders: false };
  let accountType: string | undefined;
  let changes: unknown;
  const repo: Partial<Repository> = {
    getUser: async id => id === user.id ? user : undefined,
    setAccountType: async (id, type) => {
      if (id !== user.id) return false;
      accountType = type;
      return true;
    },
    listUserShares: async id => id === user.id ? [direct] : [],
    getShare: async id => id === direct.id ? { ...direct, userId: user.id, grantedBy: null } : undefined,
    updateShare: async (id, rights) => {
      if (id !== direct.id) return false;
      changes = rights;
      return true;
    },
  };
  const credentials: Credentials = {
    hash: async value => value, verify: async () => false, issueToken: () => '', verifyToken: () => user.id,
  };
  const db = database(repo);
  const accounts = new AccountCommands(db, credentials);
  const queries = new AccountQueries(db, credentials);
  const grants = new ShareCommands(db, { folderShared: async () => assert.fail('editing a grant must not resend mail') });
  await assert.rejects(accounts.classifyAccount(user, user.id, 'external'), { status: 403 });
  await assert.rejects(accounts.classifyAccount(admin, 'missing', 'external'), { status: 404 });
  await accounts.classifyAccount(admin, user.id, 'external');
  assert.equal(accountType, 'external');
  await assert.rejects(queries.listSharesForUser(user, user.id), { status: 403 });
  await assert.rejects(queries.listSharesForUser(admin, 'missing'), { status: 404 });
  assert.deepEqual(await queries.listSharesForUser(admin, user.id), [direct]);
  const rights = { permission: 'upload' as const, deleteFiles: true, deleteFolders: true };
  await assert.rejects(grants.changeShare(user, direct.id, rights), { status: 403 });
  await assert.rejects(grants.changeShare(admin, 'missing', rights), { status: 404 });
  await grants.changeShare(admin, direct.id, rights);
  assert.deepEqual(changes, rights);
});
