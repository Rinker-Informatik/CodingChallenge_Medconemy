import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breadcrumb, fileActions, fileType, formatSize, visibleContents, searchWorkspace } from '../src/app/workspace';

const rights = { read: true, upload: true, write: false, deleteFiles: false, deleteFolders: false };
const root = { id: 'root', name: 'Root', parent_id: null, rights };
const child = { id: 'child', name: 'Child', parent_id: 'root', rights };
const user = { id: 'me', email: 'me@example.test', is_admin: false };
const file = { id: 'f', name: 'Plan.DOCX', owner_id: 'me', folder_id: 'child', rights, size: '1536', content_type: 'application/octet-stream' };

test('workspace search combines name, type, date and editor filters across folders', () => {
  const updated = { ...file, updated_at: '2026-11-15T12:00:00Z', updated_by_email: 'editor@example.test' };
  assert.deepEqual(searchWorkspace([root, child], [updated], 'plan', 'word', '2026-11-14', 'editor').files, [updated]);
  assert.equal(searchWorkspace([root, child], [updated], '', '', '2026-11-17', '').files.length, 0);
  assert.equal(searchWorkspace([root, child], [updated], 'child', '', '', '').folders.length, 1);
  assert.equal(searchWorkspace([root, child], [updated], '', 'pdf', '', '').files.length, 0);
});

test('recognises file types by extension and falls back to MIME', () => {
  for (const [extension, type] of Object.entries({ docx: 'word', xlsx: 'excel', pptx: 'slides', pdf: 'pdf', png: 'image', zip: 'archive', mp3: 'audio', mp4: 'video' })) {
    assert.equal(fileType({ ...file, name: 'File.' + extension.toUpperCase() }).key, type);
  }
  assert.equal(fileType({ name: 'unknown', content_type: 'image/webp' }).key, 'image');
  assert.equal(fileType({ name: 'unknown', content_type: 'application/octet-stream' }).key, 'generic');
});

test('breadcrumbs stop at the first inaccessible parent', () => {
  assert.deepEqual(breadcrumb([root, child], 'child'), [root, child]);
  assert.deepEqual(breadcrumb([child], 'child'), [child]);
  assert.deepEqual(breadcrumb([child], 'hidden'), []);
});

test('files outside the visible tree appear in the overview', () => {
  const detached = { ...file, id: 'detached', folder_id: null };
  assert.deepEqual(visibleContents([child], [file, detached], null), { folders: [child], files: [detached] });
  assert.deepEqual(visibleContents([child], [file, detached], 'child'), { folders: [], files: [file] });
});

test('file actions distinguish owner uploads, foreign deletes and writable destinations', () => {
  assert.deepEqual(fileActions(file, user, [child]), { edit: true, delete: false, copy: false, move: false });
  assert.deepEqual(fileActions({ ...file, owner_id: 'other' }, user, [child]), { edit: false, delete: false, copy: false, move: false });
  const writable = { ...rights, write: true, deleteFiles: true };
  assert.deepEqual(fileActions({ ...file, owner_id: 'other', rights: writable }, user, [{ ...child, rights: writable }]),
    { edit: true, delete: true, copy: true, move: false });
  assert.equal(fileActions({ ...file, rights: writable }, user, [{ ...root, rights: writable }]).move, true);
});

test('formats S3 file sizes with German separators', () => {
  assert.equal(formatSize('12'), '12 B');
  assert.equal(formatSize('1536'), '1,5 KB');
});

test('browser editing requires an OOXML type and the normal content edit permission', async () => {
  const { canOpenOffice } = await import('../src/app/workspace');
  assert.equal(canOpenOffice(file, user), true);
  assert.equal(canOpenOffice({ ...file, name: 'file.xls' }, user), false);
  assert.equal(canOpenOffice({ ...file, name: 'file.xlsx', owner_id: 'other' }, user), false);
  assert.equal(canOpenOffice({ ...file, name: 'file.xlsx', owner_id: 'other', rights: { ...rights, write: true } }, user), true);
});

test('owned file deletion follows write or explicit deletion rights', () => {
  assert.equal(fileActions(file, user, [child]).delete, false);
  const withWrite = { ...file, rights: { ...file.rights, write: true } };
  assert.equal(fileActions(withWrite, user, [child]).delete, true);
  const explicitDelete = { ...file, rights: { ...file.rights, upload: false, deleteFiles: true } };
  assert.equal(fileActions(explicitDelete, user, [child]).delete, true);
});


test('folder URLs preserve hierarchy, encode names and resolve IDs unambiguously', async () => {
  const { folderUrl, folderFromUrl } = await import('../src/app/workspace');
  const rights = { read: true, upload: true, write: true, deleteFiles: true, deleteFolders: true };
  const folders = [
    { id: 'a', name: 'Über / uns', parent_id: null, rights },
    { id: 'b', name: 'Dokumente', parent_id: 'a', rights },
    { id: 'c', name: 'Dokumente', parent_id: null, rights },
  ];
  const url = folderUrl(folders, 'b');
  assert.equal(url, '/ordner/a/%C3%9Cber%20%2F%20uns/b/Dokumente');
  assert.equal(folderFromUrl(folders, url), 'b');
  assert.equal(folderFromUrl(folders, '/ordner/c/Dokumente/b/Dokumente'), undefined);
  assert.equal(folderFromUrl(folders, '/ordner/missing/name'), undefined);
  assert.equal(folderFromUrl(folders, '/'), null);
});
