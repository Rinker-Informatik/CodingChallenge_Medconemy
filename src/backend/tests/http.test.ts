import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { createApp } from '../src/http/app.js';
import { AppError } from '../src/application/errors.js';

const id = 'a0c1e815-8974-4d81-9457-e16ac4459721';
const admin = { id, email: 'admin@example.test', is_admin: true };
const calls: string[] = [];
const services = {
  accountCommands: { signIn: async () => ({ token: 'ok' }), createUser: async () => ({ id }) },
  accountQueries: { authenticateToken: async (token: string) => { if (token !== 'ok') throw new AppError(401, 'Ungültiges Token'); return admin; }, listUsers: async () => [admin] },
  folderCommands: { createFolder: async () => ({ id }), deleteFolderTree: async () => {} },
  folderQueries: { listVisibleFolders: async () => [] },
  fileCommands: { uploadFile: async () => ({ id }), replaceFileContent: async () => {}, copyFile: async () => { calls.push('copy'); return { id }; }, changeFileMetadata: async () => { calls.push('change'); return { id }; }, deleteFile: async () => {} },
  fileQueries: { listVisibleFiles: async () => [], downloadFile: async () => ({ name: 'a.txt', data: Buffer.from('hello') }) },
  shareCommands: { grantShare: async () => ({ id, notified: true }), revokeShare: async () => {} },
} as unknown as Parameters<typeof createApp>[0];

async function request(method: string, path: string, body?: string, contentType = 'application/json', token = 'ok') {
  const chunks: Buffer[] = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  const req = new IncomingMessage(socket as never);
  req.method = method; req.url = path; req.complete = true;
  req.headers = { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) } : {}) };
  const res = new ServerResponse(req);
  res.assignSocket(socket as never);
  const done = new Promise<void>(resolve => res.once('finish', resolve));
  createApp(services)(req, res);
  if (body !== undefined) req.push(body);
  req.push(null);
  await done;
  const raw = Buffer.concat(chunks).toString();
  return { status: res.statusCode, headers: res.getHeaders(), body: raw.split('\r\n\r\n').slice(1).join('\r\n\r\n') };
}

test('HTTP app authenticates, validates input, dispatches CQRS actions and maps errors', async () => {
  assert.equal((await request('POST', '/auth/login', JSON.stringify({ email: 'admin@example.test', password: 'pass' }), 'application/json', 'bad')).status, 200);
  assert.equal((await request('GET', '/me', undefined, undefined, 'bad')).status, 401);
  assert.equal((await request('POST', '/folders', JSON.stringify({ name: '' }))).status, 400);
  assert.equal((await request('GET', '/me')).status, 200);
  assert.equal((await request('GET', '/users')).status, 200);
  assert.equal((await request('POST', '/users', JSON.stringify({ email: 'new@example.test', password: 'long-password' }))).status, 201);
  assert.equal((await request('GET', '/folders')).status, 200);
  assert.equal((await request('POST', '/folders', JSON.stringify({ name: 'folder' }))).status, 201);
  assert.equal((await request('DELETE', `/folders/${id}`)).status, 204);
  assert.equal((await request('GET', '/files')).status, 200);
  assert.equal((await request('GET', `/files/${id}/download`)).status, 200);
  assert.equal((await request('PATCH', `/files/${id}`, JSON.stringify({ name: 'new' }))).status, 200);
  assert.equal((await request('PATCH', `/files/${id}`, JSON.stringify({ copy: true }))).status, 200);
  assert.deepEqual(calls, ['change', 'copy']);
  assert.equal((await request('DELETE', `/files/${id}`)).status, 204);
  assert.equal((await request('POST', '/shares', JSON.stringify({ userId: id, folderId: id, permission: 'read' }))).status, 201);
  assert.equal((await request('DELETE', `/shares/${id}`)).status, 204);
  const multipart = '--demo\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--demo--\r\n';
  assert.equal((await request('POST', `/folders/${id}/files`, multipart, 'multipart/form-data; boundary=demo')).status, 201);
  assert.equal((await request('PUT', `/files/${id}/content`, multipart, 'multipart/form-data; boundary=demo')).status, 204);
  assert.equal((await request('POST', `/folders/${id}/files`)).status, 400);
  assert.equal((await request('PUT', `/files/${id}/content`)).status, 400);
});
