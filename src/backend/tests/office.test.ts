import assert from 'node:assert/strict';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import { OfficeSessions, type EditorGateway } from '../src/application/office.js';
import { OnlyOffice } from '../src/infrastructure/onlyoffice.js';
import { FileCommands } from '../src/application/commands/files.js';
import type { Database, Repository } from '../src/application/ports.js';
import { rights } from '../src/domain/permissions.js';

const user = { id: 'user', email: 'user@example.test', is_admin: false };
const file = { id: 'file', name: 'Plan.xlsx', owner_id: user.id, folder_id: 'folder', object_key: 'original', content_type: 'any', size: '4' };
const writable = rights(false, [{ permission: 'upload', delete_files: false, delete_folders: false }]);
const actor = { ...user, id: 'other' };
const id = '6d9d7ce2-ad64-46e1-8eba-7c92af381814';
const zip = Buffer.from('504b0304', 'hex');
function database(repo: Partial<Repository>): Database {
  repo.recordFileVersion ??= async () => {};
  repo.recordActivity ??= async () => {};
  repo.acquireFileLock ??= async () => true;
  repo.renewFileLock ??= async () => true;
  repo.releaseFileLock ??= async () => {};
  return {
    read: work => work(repo as Repository),
    execute: work => work(repo as Repository),
    transaction: work => work(repo as Repository),
  };
}

test('session start, source and status enforce account, format, scope and version', async () => {
  let current = file;
  let allowed = writable;
  const db = database({ getFile: async () => current, fileRights: async () => allowed, getUser: async () => user });
  const editor = new OnlyOffice('secret', 'http://backend:3000', 'http://office', 'http://localhost:8082');
  const sessions = new OfficeSessions(db, { get: async key => { assert.equal(key, 'original'); return zip; } },
    { replaceFileContent: async () => assert.fail('no write') }, editor);
  await assert.rejects(sessions.open(actor, file.id), { status: 403 });
  current = { ...file, name: 'legacy.xls' };
  await assert.rejects(sessions.open(user, file.id), { status: 415 });
  current = file;
  const session = await sessions.open(user, file.id);
  assert.equal(session.config.documentType, 'cell');
  assert.equal(session.apiScript, 'http://localhost:8082/web-apps/apps/api/documents/api.js');
  assert.equal(sessions.status(user, session.id).status, 'editing');
  assert.throws(() => sessions.status(actor, session.id), { status: 404 });
  const source = jwt.sign({ operation: 'download', payload: { url: editor.sourceUrl(session.id) } }, 'secret');
  await assert.rejects(sessions.source(session.id, session.config.token), { status: 403 });
  assert.deepEqual((await sessions.source(session.id, source)).data, zip);
  allowed = rights(false, []);
  await assert.rejects(sessions.source(session.id, source), { status: 403 });
  allowed = writable;
  current = { ...file, object_key: 'new' };
  await assert.rejects(sessions.source(session.id, source), { status: 409 });
});

test('save callback rejects wrong key and stale or revoked sessions without changing S3', async () => {
  let allowed = writable;
  let current = file;
  let written = 0;
  let currentUser = user;
  const db = database({
    getFile: async () => current, fileRights: async () => allowed, getUser: async () => currentUser, fileLockMatches: async () => true,
    updateFileContent: async (_id, key) => { current = { ...current, object_key: key }; },
  });
  const objects = { get: async () => zip, put: async () => { written++; }, delete: async () => {} };
  const gateway = new OnlyOffice('secret', 'http://backend:3000', 'http://office', 'http://localhost:8082');
  const stub: EditorGateway = {
    apiScript: gateway.apiScript, sourceUrl: gateway.sourceUrl.bind(gateway), callbackUrl: gateway.callbackUrl.bind(gateway),
    signConfig: gateway.signConfig.bind(gateway), verifySource: gateway.verifySource.bind(gateway),
    readCallback: gateway.readCallback.bind(gateway), fetchResult: async () => zip,
  };
  const sessions = new OfficeSessions(db, objects, new FileCommands(db, objects), stub);
  const event = (key: string, status = 2) => jwt.sign({ operation: 'callback', payload: { key, status, url: 'http://office' } }, 'secret');
  const first = await sessions.open(user, file.id);
  await assert.rejects(sessions.callback(first.id, event(id)), { status: 403 });
  await assert.rejects(sessions.callback(first.id, first.config.token), { status: 400 });
  await sessions.callback(first.id, event(first.id, 1));
  allowed = rights(false, []);
  await assert.rejects(sessions.callback(first.id, event(first.id)), { status: 403 });
  assert.equal(sessions.status(user, first.id).status, 'failed');
  assert.equal(written, 0);
  allowed = writable;
  const second = await sessions.open(user, file.id);
  current = { ...file, object_key: 'external replacement' };
  await assert.rejects(sessions.callback(second.id, event(second.id)), { status: 409 });
  assert.equal(written, 0);
  const third = await sessions.open(user, file.id);
  await sessions.callback(third.id, event(third.id));
  assert.equal(sessions.status(user, third.id).status, 'saved');
  await sessions.callback(third.id, event(third.id));
  assert.equal(written, 1);
  const fourth = await sessions.open(user, file.id);
  currentUser = { ...user, is_admin: false };
  await sessions.callback(fourth.id, event(fourth.id, 4));
  assert.equal(sessions.status(user, fourth.id).status, 'unchanged');
});

test('result fetch pins origin, blocks redirected/non-session paths, and validates result bytes', async t => {
  const editor = new OnlyOffice('secret', 'http://backend:3000', 'http://office', 'http://localhost:8082');
  const path = '/cache/files/data/' + id + '_123/output.docx/output.docx?signature=example';
  const fetcher = t.mock.method(globalThis, 'fetch', async () => new Response(zip));
  await assert.rejects(editor.fetchResult('http://host/latest/meta-data', id, 'docx'), { status: 400 });
  await assert.rejects(editor.fetchResult('http://host' + path.replace(id, 'different-key'), id, 'docx'), { status: 400 });
  assert.equal(fetcher.mock.calls.length, 0);
  assert.deepEqual(await editor.fetchResult('http://untrusted-host' + path, id, 'docx'), zip);
  const [url, options] = fetcher.mock.calls[0].arguments as unknown as [URL, RequestInit];
  assert.equal(url.href, 'http://office' + path);
  assert.equal(options.redirect, 'error');
});

test('office locks prevent parallel edits and stale callbacks cannot overwrite a new session', async () => {
  let held: string | undefined;
  let writes = 0;
  const repo: Partial<Repository> = {
    getFile: async () => file,
    getUser: async () => user,
    fileRights: async () => writable,
    acquireFileLock: async (_file, _user, token) => { if (held) return false; held = token; return true; },
    renewFileLock: async (_file, _user, token) => held === token,
    releaseFileLock: async (_file, _user, token) => { if (held === token) held = undefined; },
    fileLockMatches: async (_file, _user, token) => !!token && token === held,
    updateFileContent: async () => { writes++; },
  };
  const db = database(repo);
  let callbackKey = '';
  const gateway: EditorGateway = {
    apiScript: 'http://office/api.js', sourceUrl: id => id, callbackUrl: id => id,
    signConfig: () => 'signed', verifySource: () => {},
    readCallback: () => ({ key: callbackKey, status: 2, url: 'http://office' }), fetchResult: async () => zip,
  };
  const objects = { get: async () => zip, put: async () => {}, delete: async () => {} };
  const sessions = new OfficeSessions(db, objects, new FileCommands(db, objects), gateway);
  const first = await sessions.open(user, file.id);
  await assert.rejects(sessions.open(user, file.id), { status: 409 });
  await sessions.heartbeat(user, first.id);
  held = undefined; // Simulate expiry and a new editor obtaining the lock.
  const second = await sessions.open(user, file.id);
  callbackKey = first.id;
  await assert.rejects(sessions.callback(first.id, 'callback'), { status: 409 });
  assert.equal(writes, 0);
  await sessions.heartbeat(user, second.id);
  await sessions.close(user, second.id);
  assert.equal(held, undefined);
});
