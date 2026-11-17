import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpErrorResponse } from '@angular/common/http';
import { dragKind, droppedFiles, uploadBatch, MOVE_FILE_TYPE, MAX_UPLOAD_BYTES } from '../src/app/file-drop';
import { canMoveTo, type Folder, type StoredFile } from '../src/app/workspace';

test('native files are distinct from internal moves and unrelated drags', () => {
  assert.equal(dragKind(['Files']), 'external');
  assert.equal(dragKind(['Files', MOVE_FILE_TYPE]), 'external');
  assert.equal(dragKind([MOVE_FILE_TYPE]), 'internal');
  assert.equal(dragKind(['text/plain']), null);
});

test('drop extraction ignores directories and supports browsers providing only files', () => {
  const file = new File(['body'], 'note.txt');
  const transfer = {
    items: [
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true, name: 'folder' }) },
      { kind: 'file', getAsFile: () => file },
      { kind: 'string' },
    ],
    files: [],
  };
  assert.deepEqual(droppedFiles(transfer as unknown as DataTransfer), { files: [file], folders: ['folder'] });
  assert.deepEqual(droppedFiles({ items: [], files: [file] } as unknown as DataTransfer), { files: [file], folders: [] });
});

test('upload batches preserve successes and explain individual failures', async () => {
  const files = [
    new File(['yes'], 'ok.txt'),
    new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'large.txt'),
    new File(['no'], 'denied.txt'),
    new File(['yes'], 'next.txt'),
  ];
  const attempts: string[] = [];
  const result = await uploadBatch(files, async file => {
    attempts.push(file.name);
    if (file.name === 'denied.txt') throw new HttpErrorResponse({ status: 403, error: { error: 'Keine Berechtigung' } });
  });
  assert.deepEqual(attempts, ['ok.txt', 'denied.txt', 'next.txt']);
  assert.deepEqual(result, { uploaded: 2, failures: ['large.txt (größer als 10 MiB)', 'denied.txt (Keine Berechtigung)'] });
});

test('upload batch stops on session expiry', async () => {
  const files = [new File(['1'], 'one.txt'), new File(['2'], 'two.txt')];
  let attempts = 0;
  await assert.rejects(uploadBatch(files, async () => {
    attempts++;
    throw new HttpErrorResponse({ status: 401 });
  }), { status: 401 });
  assert.equal(attempts, 1);
});

test('move requires write at both ends and forbids the current folder', () => {
  const rights = { read: true, upload: true, write: true, deleteFiles: false, deleteFolders: false };
  const file: StoredFile = { id: 'file', folder_id: 'source', name: 'note.txt', owner_id: 'u', content_type: 'text/plain', size: '1', rights };
  const folder: Folder = { id: 'target', name: 'Target', parent_id: null, rights };
  assert.equal(canMoveTo(file, folder), true);
  assert.equal(canMoveTo(file, { ...folder, id: 'source' }), false);
  assert.equal(canMoveTo(file, { ...folder, rights: { ...rights, write: false } }), false);
  assert.equal(canMoveTo({ ...file, rights: { ...rights, write: false } }, folder), false);
});
