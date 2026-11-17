import { acceptInvitation } from './invitation-helpers.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

test('real browser enforces inherited grants, revoke and recursive deletion', { timeout: 120_000 }, async () => {
  const tag = randomUUID().slice(0, 8);
  const email = `rights-${tag}@example.test`;
  const password = 'integration-browser-password';
  const rootName = 'Berechtigung ' + tag;
  const adminPassword = process.env.OFFICE_TEST_ADMIN_PASSWORD ?? 'integration-admin-password';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  try {
    const admin = await browser.newPage();
    const reader = await browser.newPage();
    for (const page of [admin, reader]) await page.goto(process.env.UI_URL);
    const button = (page, name) => page.getByRole('button', { name, exact: true });
    const dialog = page => page.getByRole('dialog');
    const row = (page, name) => page.locator('.row').filter({ hasText: name });
    const note = (page, name) => page.getByRole('status').filter({ hasText: name });
    const login = async (page, account, pass) => {
      await page.getByLabel('E-Mail', { exact: true }).fill(account);
      await page.getByLabel('Passwort', { exact: true }).fill(pass);
      await button(page, 'Anmelden').click();
    };
    const submit = async (page, name) => {
      await button(dialog(page), name).click();
      await dialog(page).waitFor({ state: 'hidden' });
    };
    const open = (page, name) => button(row(page, name), name).click();
    const action = async (page, item, name) => {
      const menu = row(page, item).locator('details');
      if (await menu.getAttribute('open') === null) await menu.locator('summary').click();
      await button(menu, name).click();
    };
    const refresh = async page => {
      const response = page.waitForResponse(res => new URL(res.url()).pathname === '/api/files' && res.ok());
      await button(page, 'Aktualisieren').click();
      await response;
    };
    const makeFolder = async name => {
      await button(admin, 'Neuer Ordner').click();
      await dialog(admin).getByLabel('Ordnername').fill(name);
      await submit(admin, 'Ordner erstellen');
    };
    const upload = async (page, name) => {
      await button(page, 'Hochladen').click();
      await dialog(page).locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(name) });
      await submit(page, 'Datei hochladen');
      await row(page, name).waitFor();
    };
    const grant = async (item, permission, { deleteFolders = false, deleteFiles = false } = {}) => {
      await action(admin, item, 'Freigeben');
      await dialog(admin).getByLabel('Konto').selectOption({ label: email });
      await dialog(admin).getByLabel('Berechtigung').selectOption(permission);
      if (deleteFolders) await dialog(admin).getByLabel('Ordner löschen').check();
      if (deleteFiles) await dialog(admin).getByLabel('Dateien ausdrücklich zum Löschen freigeben').check();
      await submit(admin, 'Freigabe erteilen');
      const text = await note(admin, 'Freigabe erteilt').innerText();
      assert.doesNotMatch(text, /fehlgeschlagen/);
      assert.match(text, /ID: [a-f0-9-]{36}/);
      return text.match(/ID: ([a-f0-9-]{36})/)[1];
    };
    const revoke = async id => {
      await button(admin, 'Freigabe widerrufen').click();
      await dialog(admin).getByLabel('Freigabe-ID').fill(id);
      await submit(admin, 'Freigabe widerrufen');
      await note(admin, 'Freigabe widerrufen').waitFor();
    };
    const api = async (page, method, path, status, authorization, data) => {
      const response = await page.request.fetch(process.env.UI_URL + '/api' + path, {
        method, headers: authorization ? { authorization: 'Bearer ' + authorization } : {}, data,
      });
      assert.equal(response.status(), status, method + ' ' + path + ' ' + await response.text());
      return response;
    };

    await login(admin, 'admin@example.test', 'invalid-password');
    await admin.getByRole('alert').filter({ hasText: 'Ungültige Zugangsdaten' }).waitFor();
    await login(admin, 'admin@example.test', adminPassword);
    await button(admin, 'Nutzerverwaltung').click();
    const accountPage = admin.locator('.account-page');
    await accountPage.getByLabel('E-Mail für neues Konto').fill(email);
    await accountPage.locator('select[name=accountType]').selectOption('external');
    await accountPage.getByRole('button', { name: 'Konto anlegen', exact: true }).click();
    await accountPage.getByText(email, { exact: true }).waitFor();
    await acceptInvitation(email, password);
    await button(admin, 'Übersicht').click();
    await makeFolder(rootName);
    await open(admin, rootName);
    await makeFolder('Unterordner');
    await open(admin, 'Unterordner');
    await upload(admin, 'Fremd.txt');
    await button(admin.getByRole('navigation', { name: 'Ordnerpfad' }), 'Übersicht').click();

    const uploadGrant = await grant(rootName, 'upload', { deleteFolders: true });
    let message;
    for (let attempt = 0; attempt < 20 && !message; attempt++) {
      const inbox = await (await fetch(process.env.MAIL_URL + '/api/v1/messages')).json();
      message = inbox.messages.find(item => item.To?.some(to => to.Address === email));
      if (!message) await delay(250);
    }
    assert.ok(message, 'Freigabe-E-Mail fehlt');
    const mail = await (await fetch(process.env.MAIL_URL + '/api/v1/message/' + message.ID)).json();
    assert.equal(mail.Subject, 'Bereich freigegeben');

    const loginResponse = reader.waitForResponse(res => new URL(res.url()).pathname === '/api/auth/login' && res.ok());
    await login(reader, email, password);
    const { token } = await (await loginResponse).json();
    await open(reader, rootName);
    await open(reader, 'Unterordner');
    await row(reader, 'Fremd.txt').waitFor();
    assert.equal(await button(reader, 'Nutzerverwaltung').count(), 0);
    assert.equal(await button(reader, 'Neuer Ordner').count(), 0);
    assert.equal(await row(reader, 'Fremd.txt').locator('details').count(), 1);
    await upload(reader, 'Eigen.txt');
    const files = await (await api(reader, 'GET', '/files', 200, token)).json();
    const own = files.find(file => file.name === 'Eigen.txt').id;
    const foreign = files.find(file => file.name === 'Fremd.txt').id;
    const folders = await (await api(reader, 'GET', '/folders', 200, token)).json();
    const rootId = folders.find(folder => folder.name === rootName).id;
    assert.match(mail.Text, new RegExp(rootId));
    await api(reader, 'GET', '/users', 403, token);
    await api(reader, 'POST', '/users', 403, token, { email: 'forbidden@example.test', password });
    await api(reader, 'DELETE', '/shares/' + uploadGrant, 403, token);
    await api(reader, 'POST', '/shares', 403, token, { userId: folders[0].owner_id, folderId: rootId, permission: 'write' });
    await api(reader, 'POST', '/folders', 403, token, { name: 'Verboten', parentId: rootId });
    await api(reader, 'PATCH', '/files/' + foreign, 403, token, { name: 'Verboten.txt' });
    await api(reader, 'DELETE', '/files/' + own, 403, token);
    await action(reader, 'Eigen.txt', 'Umbenennen');
    await dialog(reader).getByLabel('Dateiname').fill('Eigen-neu.txt');
    await submit(reader, 'Datei umbenennen');

    await button(reader.getByRole('navigation', { name: 'Ordnerpfad' }), 'Übersicht').click();
    await action(reader, rootName, 'Löschen');
    await button(dialog(reader), 'Ordner löschen').click();
    await dialog(reader).getByRole('alert').filter({ hasText: 'Keine Berechtigung' }).waitFor();
    await button(dialog(reader), 'Abbrechen').click();
    await row(reader, rootName).waitFor();

    await revoke(uploadGrant);
    await row(reader, rootName).waitFor({ state: 'detached', timeout: 45000 });
    await row(reader, 'Eigen-neu.txt').waitFor();
    await api(reader, 'GET', '/files/' + foreign + '/download', 403, token);

    const writeGrant = await grant(rootName, 'write');
    await refresh(reader);
    await open(reader, rootName);
    await open(reader, 'Unterordner');
    await upload(reader, 'Eigene-schreibbar.txt');
    await action(reader, 'Eigene-schreibbar.txt', 'Löschen');
    await submit(reader, 'Datei löschen');
    await row(reader, 'Eigene-schreibbar.txt').waitFor({ state: 'detached' });
    await action(reader, 'Fremd.txt', 'Umbenennen');
    await dialog(reader).getByLabel('Dateiname').fill('Fremd-neu.txt');
    await submit(reader, 'Datei umbenennen');
    await row(reader, 'Fremd-neu.txt').waitFor();
    await api(reader, 'DELETE', '/files/' + foreign, 403, token);
    await button(reader.getByRole('navigation', { name: 'Ordnerpfad' }), 'Übersicht').click();
    await revoke(writeGrant);
    await refresh(reader);

    const deletionGrant = await grant(rootName, 'read', { deleteFolders: true, deleteFiles: true });
    await refresh(reader);
    await open(reader, rootName);
    await open(reader, 'Unterordner');
    await action(reader, 'Eigen-neu.txt', 'Löschen');
    await submit(reader, 'Datei löschen');
    await row(reader, 'Eigen-neu.txt').waitFor({ state: 'detached' });

    await button(reader.getByRole('navigation', { name: 'Ordnerpfad' }), 'Übersicht').click();
    await action(reader, rootName, 'Löschen');
    await submit(reader, 'Ordner löschen');
    await row(reader, rootName).waitFor({ state: 'detached' });
    await api(reader, 'GET', '/files/' + foreign + '/download', 404, token);
    await api(reader, 'DELETE', '/shares/' + deletionGrant, 403, token);
    await button(reader, 'Abmelden').click();
    await button(reader, 'Anmelden').waitFor();
    await api(reader, 'GET', '/folders', 401);
  } finally {
    await browser.close();
  }
});
