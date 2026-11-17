import { invitationToken } from './invitation-helpers.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

test('Angular and Express exchange and share a file through the UI proxy', { timeout: 90_000 }, async () => {
  const run = randomUUID();
  const email = `browser-${run}@example.test`;
  const folderName = 'Vertraulicher Ordner ' + run.slice(0, 8);
  const adminPassword = process.env.OFFICE_TEST_ADMIN_PASSWORD ?? 'integration-admin-password';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(process.env.UI_URL);
    const button = name => page.getByRole('button', { name, exact: true });
    const dialog = page.getByRole('dialog');
    const row = name => page.locator('.row').filter({ hasText: name });
    const actions = async (name, action) => {
      const menu = row(name).locator('details');
      if (await menu.getAttribute('open') === null) await menu.locator('summary').click();
      await row(name).getByRole('button', { name: action, exact: true }).click();
    };
    const submit = async name => {
      await dialog.getByRole('button', { name, exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    };
    const login = async (email, password) => {
      await page.getByLabel('E-Mail', { exact: true }).fill(email);
      await page.getByLabel('Passwort', { exact: true }).fill(password);
      await button('Anmelden').click();
      await button('Abmelden').waitFor();
    };
    await login('admin@example.test', adminPassword);

    await button('Nutzerverwaltung').click();
    const accountPage = page.locator('.account-page');
    await accountPage.getByLabel('E-Mail für neues Konto').fill(email);
    await accountPage.locator('select[name=accountType]').selectOption('external');
    await accountPage.getByRole('button', { name: 'Konto anlegen', exact: true }).click();
    await accountPage.getByText(email, { exact: false }).waitFor();
    const invite = await invitationToken(email);
    const invitePage = await browser.newPage();
    await invitePage.goto(process.env.UI_URL + '/passwort-setzen#token=' + invite);
    const requirements = invitePage.getByRole('list', { name: 'Passwortbedingungen' });
    await requirements.getByText('Noch offen').first().waitFor();
    await invitePage.getByLabel('Neues Passwort').fill('kurz');
    assert.equal(await requirements.getByText('Erfüllt').count(), 0);
    await invitePage.getByLabel('Neues Passwort').fill('integration-browser-password');
    assert.equal(await requirements.getByText('Erfüllt').count(), 1);
    await invitePage.getByLabel('Passwort bestätigen').fill('integration-browser-password');
    assert.equal(await requirements.getByText('Erfüllt').count(), 2);
    await invitePage.getByRole('button', { name: 'Passwort speichern' }).click();
    await invitePage.getByText('Passwort festgelegt. Du kannst dich jetzt anmelden.').waitFor();
    const reused = await fetch(process.env.UI_URL + '/api/auth/accept-invitation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: invite, password: 'another-password-123' }) });
    assert.equal(reused.status, 400);
    await invitePage.close();
    await button('Übersicht').click();

    await button('Neuer Ordner').click();
    await dialog.getByLabel('Ordnername').fill(folderName);
    await submit('Ordner erstellen');
    await page.getByRole('navigation', { name: 'Ordnerbaum' }).getByRole('button', { name: folderName, exact: true }).click();

    await button('Hochladen').click();
    await dialog.locator('input[type=file]').setInputFiles({
      name: 'Notiz.txt', mimeType: 'text/plain', buffer: Buffer.from('Erster Text'),
    });
    await submit('Datei hochladen');
    await page.getByRole('navigation', { name: 'Ordnerbaum' }).getByRole('button', { name: 'Übersicht', exact: true }).click();
    await page.getByLabel('Alle Dateien und Ordner durchsuchen').fill('Notiz.txt');
    await row('Notiz.txt').getByText(folderName).waitFor();
    await page.getByLabel('Dateityp').selectOption('pdf');
    assert.equal(await row('Notiz.txt').count(), 0);
    await page.getByRole('navigation', { name: 'Ordnerbaum' }).getByRole('button', { name: folderName, exact: true }).click();
    await row('Notiz.txt').getByRole('button', { name: 'Informationen zu Notiz.txt' }).hover();
    const info = row('Notiz.txt').getByRole('tooltip');
    await info.getByText('admin@example.test', { exact: true }).first().waitFor();
    assert.match(await info.innerText(), /Inhaltsversion\s*1/);
    await actions('Notiz.txt', 'Text bearbeiten');
    const textArea = dialog.getByLabel('Textinhalt');
    assert.equal(await textArea.inputValue(), 'Erster Text');
    await textArea.fill('Geänderter Text – äöü');
    await submit('Speichern');
    await actions('Notiz.txt', 'Versionsverlauf');
    await dialog.getByText(/Version 1/).waitFor();
    await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click();
    await row('Notiz.txt').getByRole('button', { name: 'Informationen zu Notiz.txt' }).hover();
    assert.match(await info.innerText(), /Inhaltsversion\s*2/);
    await actions('Notiz.txt', 'Text bearbeiten');
    assert.equal(await textArea.inputValue(), 'Geänderter Text – äöü');
    await textArea.fill('');
    await submit('Speichern');
    await actions('Notiz.txt', 'Text bearbeiten');
    assert.equal(await textArea.inputValue(), '');
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();

    await button('Hochladen').click();
    await dialog.locator('input[type=file]').setInputFiles({
      name: 'Beispiel.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('S3 integration data'),
    });
    await submit('Datei hochladen');
    await row('Beispiel.docx').locator('.file-icon.word').waitFor();
    await actions('Beispiel.docx', 'Umbenennen');
    await dialog.getByLabel('Dateiname').fill('Austausch.docx');
    await submit('Datei umbenennen');
    await actions('Austausch.docx', 'Inhalt ersetzen');
    await dialog.locator('input[type=file]').setInputFiles({
      name: 'Neu.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('Replaced S3 data'),
    });
    await submit('Dateiinhalt ersetzen');

    await button('Neuer Ordner').click();
    await dialog.getByLabel('Ordnername').fill('Unterordner');
    await submit('Ordner erstellen');
    await actions('Austausch.docx', 'Kopieren');
    await dialog.getByLabel('Zielordner').selectOption({ label: folderName + ' / Unterordner' });
    await dialog.getByLabel('Name der Kopie').fill('Kopie.docx');
    await submit('Datei kopieren');
    await actions('Austausch.docx', 'Verschieben');
    await dialog.getByLabel('Zielordner').selectOption({ label: folderName + ' / Unterordner' });
    await submit('Datei verschieben');

    await row('Unterordner').getByRole('button', { name: 'Unterordner' }).click();
    const deepUrl = page.url();
    assert.match(deepUrl, /\/ordner\//);
    await page.reload();
    await page.getByRole('heading', { name: 'Unterordner', exact: true }).waitFor();
    assert.equal(page.url(), deepUrl);
    await button('Übersicht').first().click();
    await page.goto(deepUrl);
    await page.getByRole('heading', { name: 'Unterordner', exact: true }).waitFor();

    await actions('Kopie.docx', 'Löschen');
    await submit('Datei löschen');
    await row('Kopie.docx').waitFor({ state: 'detached' });

    await actions('Austausch.docx', 'Freigeben');
    await dialog.getByLabel('Konto').selectOption({ label: email });
    await submit('Freigabe erteilen');
    const confirmation = await page.getByRole('status').filter({ hasText: 'Freigabe erteilt' }).innerText();
    const shareId = confirmation.match(/ID: ([a-f0-9-]{36})/)[1];

    await button('Abmelden').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await login(email, 'integration-browser-password');
    await row('Austausch.docx').waitFor();
    assert.equal(await page.getByText(folderName, { exact: true }).count(), 0);
    assert.equal(await row('Austausch.docx').locator('summary').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const downloadEvent = page.waitForEvent('download');
    await button('Austausch.docx herunterladen').click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), 'Austausch.docx');
    assert.equal(await readFile(await download.path(), 'utf8'), 'Replaced S3 data');
    await button('Abmelden').click();
    await page.setViewportSize({ width: 1360, height: 900 });
    await login('admin@example.test', adminPassword);
    await button('Freigabe widerrufen').click();
    await dialog.getByLabel('Freigabe-ID').fill(shareId);
    await submit('Freigabe widerrufen');
    await page.getByText('Freigabe widerrufen.', { exact: true }).waitFor();
    await button('Abmelden').click();
    await login(email, 'integration-browser-password');
    await page.getByText('Hier ist noch nichts', { exact: true }).waitFor();
    assert.equal(await row('Austausch.docx').count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('Textbearbeitung sperrt dieselbe Datei in einem zweiten Browser-Tab', { timeout: 90000 }, async () => {
  const base = process.env.UI_URL;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.test', password: process.env.OFFICE_TEST_ADMIN_PASSWORD ?? 'integration-admin-password' }) });
  const { token } = await login.json();
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const folderName = 'Sperrtest ' + randomUUID();
  const folder = await (await fetch(base + '/api/folders', { method: 'POST', headers, body: JSON.stringify({ name: folderName }) })).json();
  const data = new FormData();
  data.append('file', new Blob(['Original']), 'Sperrtest.txt');
  assert.equal((await fetch(base + '/api/folders/' + folder.id + '/files', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: data })).status, 201);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  try {
    const pages = await Promise.all([browser.newPage(), browser.newPage()]);
    for (const page of pages) {
      await page.goto(base);
      await page.getByLabel('E-Mail', { exact: true }).fill('admin@example.test');
      await page.getByLabel('Passwort', { exact: true }).fill(process.env.OFFICE_TEST_ADMIN_PASSWORD ?? 'integration-admin-password');
      await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
      await page.locator('.row').filter({ hasText: folderName }).getByRole('button', { name: folderName, exact: true }).click();
    }
    const edit = async page => {
      const row = page.locator('.row').filter({ hasText: 'Sperrtest.txt' });
      if (await row.locator('details').getAttribute('open') === null) await row.locator('summary').click();
      await row.getByRole('button', { name: 'Text bearbeiten', exact: true }).click();
    };
    await edit(pages[0]);
    await pages[0].getByRole('dialog').locator('textarea').fill('Version A');
    await pages[1].getByRole('button', { name: 'Aktualisieren', exact: true }).click();
    await pages[1].locator('.row').filter({ hasText: 'Sperrtest.txt' }).getByTitle('Wird bearbeitet von admin@example.test').waitFor();
    await edit(pages[1]);
    await pages[1].getByRole('alert').filter({ hasText: 'Diese Datei wird bereits bearbeitet' }).waitFor();
    const released = pages[0].waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname.endsWith('/edit-lock'));
    await pages[0].getByRole('dialog').getByRole('button', { name: 'Speichern', exact: true }).click();
    await pages[0].getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal((await released).status(), 204);
    await edit(pages[1]);
    assert.equal(await pages[1].getByRole('dialog').locator('textarea').inputValue(), 'Version A');
    await pages[1].getByRole('dialog').getByRole('button', { name: 'Abbrechen', exact: true }).click();
  } finally { await browser.close(); }
});

test('Papierkorb stellt eine gelöschte Datei über die Oberfläche wieder her', { timeout: 90000 }, async () => {
  const base = process.env.UI_URL;
  const password = process.env.OFFICE_TEST_ADMIN_PASSWORD ?? 'integration-admin-password';
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.test', password }) });
  const { token } = await login.json();
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const folder = await (await fetch(base + '/api/folders', { method: 'POST', headers, body: JSON.stringify({ name: 'Papierkorb ' + randomUUID() }) })).json();
  const form = new FormData(); form.append('file', new Blob(['Wiederhergestellt']), 'Papierkorb-Test.txt');
  const file = await (await fetch(base + '/api/folders/' + folder.id + '/files', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: form })).json();
  assert.equal((await fetch(base + '/api/files/' + file.id, { method: 'DELETE', headers })).status, 204);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(); await page.goto(base);
    await page.getByLabel('E-Mail', { exact: true }).fill('admin@example.test');
    await page.getByLabel('Passwort', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await page.getByRole('button', { name: 'Papierkorb', exact: true }).click();
    const item = page.locator('.account-row').filter({ hasText: 'Papierkorb-Test.txt' });
    await item.getByRole('button', { name: 'Wiederherstellen', exact: true }).click();
    await item.waitFor({ state: 'detached' });
    assert.equal(await (await fetch(base + '/api/files/' + file.id + '/download', { headers })).text(), 'Wiederhergestellt');
    await page.getByRole('button', { name: 'Aktivitätsprotokoll', exact: true }).click();
    await page.getByText('Datei wiederhergestellt · Papierkorb-Test.txt', { exact: true }).waitFor();
  } finally { await browser.close(); }
});
