import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { JwtCredentials, MailNotifier, S3ObjectStore } from '../src/infrastructure/services.js';
import { PostgresDatabase } from '../src/infrastructure/postgres.js';
import type { FileRecord, User } from '../src/domain/models.js';

const user: User = { id: 'user', email: 'user@example.test', is_admin: false };
const file: FileRecord = { id: 'file', name: 'a', folder_id: 'folder', owner_id: 'user', object_key: 'key', content_type: 'text/plain', size: '1' };

test('credentials hash passwords and reject invalid, wrong-secret and subjectless tokens', async () => {
  const credentials = new JwtCredentials('test-secret');
  const hash = await credentials.hash('password');
  assert.notEqual(hash, 'password');
  assert.equal(await credentials.verify('password', hash), true);
  assert.equal(await credentials.verify('wrong', hash), false);
  assert.equal(credentials.verifyToken(credentials.issueToken('user')), 'user');
  assert.throws(() => credentials.verifyToken('invalid'));
  assert.throws(() => credentials.verifyToken(jwt.sign({}, 'other', { subject: 'user' })));
  assert.throws(() => credentials.verifyToken(jwt.sign({}, 'test-secret')));
});

test('S3 adapter creates a missing bucket and reads, writes and deletes objects', async t => {
  const commands: unknown[] = [];
  let missing = true;
  t.mock.method(S3Client.prototype, 'send', (async (command: unknown) => {
    commands.push(command);
    if (command instanceof HeadBucketCommand && missing) { missing = false; throw new Error('missing'); }
    if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => Buffer.from('data') } };
    return {};
  }) as typeof S3Client.prototype.send);
  const store = new S3ObjectStore('bucket', 'http://localhost:9000', 'key', 'secret');
  await store.ensureBucket();
  await store.ensureBucket();
  await store.put('object', { buffer: Buffer.from('data'), contentType: 'text/plain', size: 4 });
  assert.equal((await store.get('object')).toString(), 'data');
  await store.delete('object');
  assert.deepEqual(commands.map(command => (command as object).constructor), [HeadBucketCommand, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand]);
  assert.deepEqual((commands[3] as PutObjectCommand).input, { Bucket: 'bucket', Key: 'object', Body: Buffer.from('data'), ContentType: 'text/plain' });
});

test('mail adapter addresses the recipient and identifies the shared folder', async t => {
  let message: Record<string, unknown> = {};
  let options: unknown;
  t.mock.method(nodemailer, 'createTransport', ((config: unknown) => { options = config; return ({ sendMail: async (input: Record<string, unknown>) => { message = input; } }); }) as unknown as typeof nodemailer.createTransport);
  await new MailNotifier({ host: 'smtp.resend.com', port: 465, secure: true, requireTLS: false, from: 'sender@example.test', user: 'resend', password: 'key' }).folderShared('recipient@example.test', 'Projektunterlagen');
  assert.deepEqual(options, { host: 'smtp.resend.com', port: 465, secure: true, requireTLS: false, auth: { user: 'resend', pass: 'key' } });
  assert.equal(message.from, 'sender@example.test');
  assert.equal(message.to, 'recipient@example.test');
  assert.match(String(message.text), /Projektunterlagen/);
});

test('PostgreSQL adapter exposes repository operations and serializes transactions', async t => {
  const db = new PostgresDatabase('postgres://unused');
  const calls: { sql: string; params?: unknown[] }[] = [];
  let released = 0;
  let missing = false;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT id FROM tree') || sql.includes('SELECT id FROM tree')) return { rows: [{ id: 'folder' }] };
      if (sql.includes('permission') && sql.includes('delete_folders')) return { rows: [{ permission: 'upload', delete_files: false, delete_folders: false }] };
      if (sql.includes('FROM files WHERE folder_id=ANY')) return { rows: [file] };
      if (sql.startsWith('DELETE FROM shares WHERE id=')) return { rowCount: missing ? 0 : 1, rows: [] };
      if (sql.startsWith('SELECT')) return { rows: missing ? [] : [sql.includes('folders') ? { id: 'folder' } : file] };
      return { rows: [], rowCount: 1 };
    },
    release: () => { released++; },
  };
  t.mock.method(db.pool, 'connect', (async () => client) as unknown as typeof db.pool.connect);
  await db.read(async repo => {
    assert.ok(await repo.getUser('user'));
    assert.ok(await repo.getUserByEmail('a@example.test'));
    assert.equal((await repo.listUsers()).length, 1);
    assert.equal((await repo.getFolder('folder')).id, 'folder');
    assert.equal((await repo.getFile('file')).id, 'file');
    assert.equal((await repo.listFolders()).length, 1);
    assert.equal((await repo.listFiles()).length, 1);
    assert.equal((await repo.folderRights(user, 'folder')).upload, true);
    assert.equal((await repo.fileRights(user, file)).upload, true);
  });
  missing = true;
  await db.read(async repo => {
    assert.equal(await repo.getUser('missing'), undefined);
    await assert.rejects(repo.getFolder('missing'), { status: 404 });
    await assert.rejects(repo.getFile('missing'), { status: 404 });
  });
  missing = false;
  await db.execute(async repo => {
    await repo.createUser('id', user.email, 'hash', false);
    await repo.insertFolder({ id: 'folder', name: 'name', parent_id: null, owner_id: 'user' });
    await repo.insertFile(file);
    await repo.updateFile('file', 'new', 'folder', 'user');
    await repo.updateFileContent('file', 'new-key', 'text/plain', 3, 'user');
    await repo.deleteFile('file');
    assert.deepEqual(await repo.getTree('folder'), { folderIds: ['folder'], files: [file] });
    await repo.deleteTree(['folder'], ['file']);
    await repo.insertShare('share', { userId: 'user', folderId: 'folder', permission: 'read', deleteFiles: false, deleteFolders: false });
    assert.equal(await repo.deleteShare('share'), true);
    missing = true;
    assert.equal(await repo.deleteShare('share'), false);
  });
  await db.transaction(async () => 'done');
  const queries = calls.map(call => call.sql);
  assert.ok(queries.includes('BEGIN'));
  assert.ok(queries.includes('SELECT pg_advisory_xact_lock(7342901)'));
  assert.ok(queries.includes('COMMIT'));
  await assert.rejects(db.transaction(async () => { throw new Error('failure'); }), /failure/);
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(released, 5);
});
