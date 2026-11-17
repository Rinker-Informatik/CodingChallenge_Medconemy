import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

const url = process.env.UI_URL;
const adminPassword = process.env.OFFICE_TEST_ADMIN_PASSWORD ?? 'integration-admin-password';

async function api(method, path, expected, token, data) {
  const multipart = data instanceof FormData;
  const response = await fetch(url + '/api' + path, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(data && !multipart ? { 'Content-Type': 'application/json' } : {}),
    },
    body: multipart ? data : data ? JSON.stringify(data) : undefined,
  });
  const text = await response.text();
  assert.equal(response.status, expected, method + ' ' + path + ' ' + text);
  return text ? JSON.parse(text) : undefined;
}

async function login(page, email, password) {
  await page.goto(url);
  await page.getByLabel('E-Mail', { exact: true }).fill(email);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await page.getByRole('button', { name: 'Abmelden', exact: true }).waitFor();
}

function treeFolder(page, name) {
  return page.getByRole('navigation', { name: 'Ordnerbaum' }).getByRole('button', { name, exact: true });
}

function row(page, name) {
  return page.locator('.row').filter({ hasText: name });
}

async function externalDrop(page, target, specs) {
  // An OS file drag cannot be started by Playwright. Inject Chrome's native File/DataTransfer
  // objects at the UI boundary. The subsequent Angular requests hit the actual stack.
  const dataTransfer = await page.evaluateHandle(files => {
    const data = new DataTransfer();
    for (const file of files) {
      data.items.add(new File([new Uint8Array(file.size).fill(65)], file.name, { type: 'text/plain' }));
    }
    return data;
  }, specs);
  try {
    await target.dispatchEvent('dragover', { dataTransfer });
    if (await target.count() && await target.evaluate(el => el.classList.contains('upload-drop-zone'))) {
      await target.getByText('Dateien zum Hochladen loslassen').waitFor();
    }
    await target.dispatchEvent('drop', { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
}

test('files drop into the current folder and move only to writable targets', { timeout: 100_000 }, async () => {
  const suffix = randomUUID().slice(0, 8);
  const account = `drag-reader-${suffix}@example.test`;
  const password = 'integration-browser-password';
  const sourceName = 'Drop Quelle ' + suffix;
  const targetName = 'Drop Ziel ' + suffix;
  const { token } = await api('POST', '/auth/login', 200, undefined, { email: 'admin@example.test', password: adminPassword });
  const source = await api('POST', '/folders', 201, token, { name: sourceName });
  const target = await api('POST', '/folders', 201, token, { name: targetName, parentId: source.id });
  const { id: userId } = await api('POST', '/users', 201, token, { email: account, password });
  await api('POST', '/shares', 201, token, { userId, folderId: target.id, permission: 'read' });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  try {
    const admin = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await login(admin, 'admin@example.test', adminPassword);
    await treeFolder(admin, sourceName).click();
    await externalDrop(admin, admin.locator('.upload-drop-zone'), [
      { name: 'Erster-Drop.txt', size: 3 },
      { name: 'Zweiter-Drop.txt', size: 5 },
      { name: 'Zu-groß.txt', size: 10 * 1024 * 1024 + 1 },
    ]);
    await admin.getByRole('status').filter({ hasText: '2 Dateien hochgeladen.' }).waitFor();
    await admin.getByRole('alert').filter({ hasText: 'Zu-groß.txt (größer als 10 MiB)' }).waitFor();
    const stored = (await api('GET', '/files', 200, token)).filter(file => file.folder_id === source.id);
    assert.deepEqual(stored.map(file => file.name).sort(), ['Erster-Drop.txt', 'Zweiter-Drop.txt']);
    const first = stored.find(file => file.name === 'Erster-Drop.txt');
    const download = await fetch(url + '/api/files/' + first.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(await download.text(), 'AAA');

    const patchRequests = [];
    admin.on('request', request => { if (request.method() === 'PATCH') patchRequests.push(request.url()); });
    const draggable = row(admin, 'Erster-Drop.txt').locator('[draggable=true]');
    await draggable.dragTo(treeFolder(admin, sourceName));
    assert.deepEqual(patchRequests, [], 'Drop auf den Quellordner darf nichts verschieben');
    await draggable.dragTo(treeFolder(admin, targetName));
    await admin.getByRole('status').filter({ hasText: 'Datei verschoben.' }).waitFor();
    await row(admin, 'Erster-Drop.txt').waitFor({ state: 'detached' });
    assert.equal(patchRequests.length, 1);

    await treeFolder(admin, targetName).click();
    await admin.getByText('1 Element', { exact: true }).waitFor();
    await row(admin, 'Erster-Drop.txt').waitFor();

    const reader = await browser.newPage();
    await login(reader, account, password);
    await treeFolder(reader, targetName).click();
    assert.equal(await reader.locator('.upload-drop-zone').count(), 0);
    assert.equal(await row(reader, 'Erster-Drop.txt').locator('[draggable=true]').count(), 0);
    const deniedRequests = [];
    reader.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/files')) deniedRequests.push(request.url()); });
    await externalDrop(reader, reader.locator('main.workspace'), [{ name: 'Verboten.txt', size: 4 }]);
    await reader.getByRole('alert').filter({ hasText: 'keine Dateien hochladen' }).waitFor();
    assert.deepEqual(deniedRequests, []);
    assert.equal((await api('GET', '/files', 200, token)).filter(file => file.folder_id === target.id).length, 1);

    // Browser drops also work on folder rows, independently of the tree.
    await treeFolder(admin, sourceName).click();
    await row(admin, 'Zweiter-Drop.txt').locator('[draggable=true]').dragTo(row(admin, targetName));
    await row(admin, 'Zweiter-Drop.txt').waitFor({ state: 'detached' });
    assert.equal((await api('GET', '/files', 200, token)).filter(file => file.folder_id === target.id).length, 2);

    await treeFolder(admin, targetName).click();
    await externalDrop(admin, admin.locator('.upload-drop-zone'), Array.from({ length: 12 }, (_, index) => ({
      name: 'Mobile-' + String(index).padStart(2, '0') + '.txt', size: 1,
    })));
    await admin.getByRole('status').filter({ hasText: '12 Dateien hochgeladen.' }).waitFor();
    await admin.setViewportSize({ width: 390, height: 844 });
    const summary = row(admin, 'Zweiter-Drop.txt').locator('summary');
    assert.match(await summary.ariaSnapshot(), /Aktionen für Datei Zweiter-Drop.txt/);
    await summary.evaluate(el => el.scrollIntoView({ block: 'end' }));
    await summary.focus();
    await summary.press('Enter');
    const menu = row(admin, 'Zweiter-Drop.txt').locator('details.menu-above .action-menu');
    await menu.waitFor();
    const bounds = await menu.boundingBox();
    const anchor = await summary.boundingBox();
    assert.ok(bounds && anchor && bounds.y >= 0 && bounds.y + bounds.height <= anchor.y + 1);
    assert.ok(await menu.evaluate(el => el.scrollHeight <= el.clientHeight), 'alle Aktionen passen ins aufgeklappte Menü');
    await admin.mouse.click(5, 5);
    await menu.waitFor({ state: 'hidden' });
    await row(admin, 'Zweiter-Drop.txt').locator('summary[aria-expanded=false]').waitFor();
    await summary.press('Enter');
    await menu.waitFor();
    await menu.getByRole('button', { name: 'Umbenennen', exact: true }).click();
    await admin.getByRole('dialog').getByLabel('Dateiname').waitFor();
  } finally {
    await browser.close();
  }
});

test('upload conflicts offer rename, keep both and explicit replacement for drops', { timeout: 90000 }, async () => {
  const { token } = await api('POST', '/auth/login', 200, undefined, { email: 'admin@example.test', password: adminPassword });
  const folderName = 'Doppelte Namen ' + randomUUID();
  const folder = await api('POST', '/folders', 201, token, { name: folderName });
  const body = new FormData(); body.append('file', new Blob(['original']), 'gleich.txt');
  const initial = await api('POST', '/folders/' + folder.id + '/files', 201, token, body);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(); await login(page, 'admin@example.test', adminPassword);
    await treeFolder(page, folderName).click();
    const conflict = page.getByRole('dialog', { name: 'Dateiname existiert bereits' });
    await externalDrop(page, page.locator('.upload-drop-zone'), [{ name: 'gleich.txt', size: 6 }]);
    await conflict.getByRole('button', { name: 'Beide behalten', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '1 Datei hochgeladen.' }).waitFor();
    await row(page, 'gleich.txt').nth(1).waitFor();
    assert.equal(await row(page, 'gleich.txt').count(), 2);
    await externalDrop(page, page.locator('.upload-drop-zone'), [{ name: 'gleich.txt', size: 7 }]);
    await conflict.getByLabel('Neuer Dateiname').fill('umbenannt.txt');
    await conflict.getByRole('button', { name: 'Umbenennen und hochladen', exact: true }).click();
    await row(page, 'umbenannt.txt').waitFor();
    await externalDrop(page, page.locator('.upload-drop-zone'), [{ name: 'gleich.txt', size: 8 }]);
    await conflict.getByLabel('Datei zum Ersetzen').selectOption(initial.id);
    await conflict.getByRole('button', { name: 'Auswahl ersetzen', exact: true }).click();
    await conflict.waitFor({ state: 'hidden' });
    await page.getByRole('status').filter({ hasText: '1 Datei hochgeladen.' }).waitFor();
    const versions = await api('GET', '/files/' + initial.id + '/versions', 200, token);
    assert.equal(versions.length, 1);
    await page.getByRole('button', { name: 'Hochladen', exact: true }).click();
    const uploadDialog = page.getByRole('dialog', { name: 'Datei hochladen' });
    await uploadDialog.locator('input[type=file]').setInputFiles({ name: 'gleich.txt', mimeType: 'text/plain', buffer: Buffer.from('Einzelupload') });
    await uploadDialog.getByRole('button', { name: 'Datei hochladen', exact: true }).click();
    await conflict.getByRole('button', { name: 'Beide behalten', exact: true }).click();
    await uploadDialog.waitFor({ state: 'hidden' });
    await row(page, 'gleich.txt').nth(2).waitFor();
    assert.equal(await row(page, 'gleich.txt').count(), 3);
  } finally { await browser.close(); }
});
