import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Injector, runInInjectionContext } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { Api, errorMessage } from '../src/app/api';
import type { StoredFile } from '../src/app/workspace';

test('API uses the same-origin proxy, scopes credentials and sends real multipart bodies', async () => {
  const calls: unknown[][] = [];
  const blob = new Blob(['contents']);
  const client = {
    request(method: string, url: string, options: unknown) {
      calls.push([method, url, options]);
      return of(url === '/api/folders' ? [{ id: 'folder' }] : []);
    },
    get(url: string, options: unknown) { calls.push([url, options]); return of(blob); },
  };
  const injector = Injector.create({ providers: [{ provide: HttpClient, useValue: client }] });
  const api = runInInjectionContext(injector, () => new Api());
  await api.request('POST', '/auth/login', { email: 'user@example.test' });
  assert.deepEqual(calls.shift(), ['POST', '/api/auth/login', { body: { email: 'user@example.test' }, headers: {} }]);

  api.setToken('secret');
  assert.deepEqual(await api.workspace(), { folders: [{ id: 'folder' }], files: [] });
  for (const path of ['/api/folders', '/api/files']) {
    assert.deepEqual(calls.shift(), ['GET', path, { body: undefined, headers: { Authorization: 'Bearer secret' } }]);
  }
  const file = new File(['contents'], 'test.txt');
  await api.upload('PUT', '/files/file/content', file);
  const [method, url, options] = calls.shift() as [string, string, { body: FormData; headers: unknown }];
  assert.deepEqual([method, url, options.headers], ['PUT', '/api/files/file/content', { Authorization: 'Bearer secret' }]);
  assert.equal((options.body.get('file') as File).name, 'test.txt');
  assert.equal(await api.download({ id: 'file' } as StoredFile), blob);
  assert.deepEqual(calls.shift(), ['/api/files/file/download', { headers: { Authorization: 'Bearer secret' }, responseType: 'blob' }]);

  api.setToken('');
  await api.request('GET', '/me');
  assert.deepEqual(calls.shift(), ['GET', '/api/me', { body: undefined, headers: {} }]);
});

test('API errors report the server message and German fallbacks', () => {
  assert.equal(errorMessage(new HttpErrorResponse({ status: 403, error: { error: 'Keine Berechtigung' } })), 'Keine Berechtigung');
  assert.match(errorMessage(new HttpErrorResponse({ status: 0 })), /nicht erreichbar/);
  assert.match(errorMessage(new HttpErrorResponse({ status: 401 })), /erneut anmelden/);
  assert.match(errorMessage(new Error('internal details')), /nicht abgeschlossen/);
});

test('download errors preserve server permission messages returned as blobs', async () => {
  const client = { get: () => throwError(() => new HttpErrorResponse({ status: 403, error: new Blob(['{"error":"Keine Berechtigung"}'], { type: 'application/json' }) })) };
  const injector = Injector.create({ providers: [{ provide: HttpClient, useValue: client }] });
  const api = runInInjectionContext(injector, () => new Api());
  await assert.rejects(api.download({ id: 'file' } as StoredFile), error => errorMessage(error) === 'Keine Berechtigung');
});
