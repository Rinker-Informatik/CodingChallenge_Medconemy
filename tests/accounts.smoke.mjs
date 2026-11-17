import { acceptInvitation, invitationToken } from './invitation-helpers.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

const url = process.env.UI_URL;
const adminPassword = process.env.OFFICE_TEST_ADMIN_PASSWORD ?? 'integration-admin-password';

async function request(method, path, expected, token, payload) {
  const multipart = payload instanceof FormData;
  const response = await fetch(url + '/api' + path, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(payload && !multipart ? { 'Content-Type': 'application/json' } : {}),
    },
    body: multipart ? payload : payload ? JSON.stringify(payload) : undefined,
  });
  const text = await response.text();
  assert.equal(response.status, expected, method + ' ' + path + ' ' + text);
  return text ? JSON.parse(text) : undefined;
}
const signIn = (email, password) => request('POST', '/auth/login', 200, undefined, { email, password });

test('an administrator invites another administrator who activates their account and manages users', { timeout: 90000 }, async () => {
  const email = `admin-${randomUUID()}@example.test`;
  const password = 'new-administrator-password';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.getByLabel('E-Mail', { exact: true }).fill('admin@example.test');
    await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await page.getByRole('button', { name: 'Nutzerverwaltung', exact: true }).click();
    const accounts = page.locator('.account-page');
    await accounts.getByLabel('E-Mail für neues Konto').fill(email);
    await accounts.getByLabel('Administrator', { exact: true }).check();
    await accounts.getByRole('button', { name: 'Konto anlegen', exact: true }).click();
    await accounts.locator('.account-row').filter({ hasText: email }).getByText('Intern · Admin').waitFor();

    const token = await invitationToken(email);
    const invited = await browser.newPage();
    await invited.goto(`${url}/passwort-setzen#token=${token}`);
    await invited.getByLabel('Neues Passwort', { exact: true }).fill(password);
    await invited.getByLabel('Passwort bestätigen', { exact: true }).fill(password);
    await invited.getByRole('button', { name: 'Passwort speichern' }).click();
    await invited.getByLabel('E-Mail', { exact: true }).fill(email);
    await invited.getByLabel('Passwort', { exact: true }).fill(password);
    await invited.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await invited.getByRole('button', { name: 'Nutzerverwaltung', exact: true }).click();
    await invited.locator('.account-page').getByText(email, { exact: true }).waitFor();
    const { token: adminToken } = await signIn(email, password);
    const created = await request('POST', '/users', 201, adminToken, { email: `created-${randomUUID()}@example.test`, password });
    assert.equal(created.isAdmin, false);
    const replay = await fetch(url + '/api/auth/accept-invitation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password }) });
    assert.equal(replay.status, 400);
  } finally { await browser.close(); }
});

test('admin manages account type and object permissions from the account dialog', { timeout: 90000 }, async () => {
  const tag = randomUUID().slice(0, 8);
  const reuseGuest = process.env.MEDCONEMY_DEMO_GUEST === 'true';
  const guest = reuseGuest ? 'gast.nordlicht@example.test' : `account-${tag}@example.test`;
  const guestPassword = reuseGuest ? 'demo-nordlicht-gast' : 'temporary-test-password';
  const { token } = await signIn('admin@example.test', adminPassword);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  let folder;
  try {
    const folderName = 'Kontentest ' + tag;
    folder = await request('POST', '/folders', 201, token, { name: folderName });
    const upload = new FormData();
    upload.append('file', new Blob(['Kontentest']), 'Probe.txt');
    const file = await request('POST', '/folders/' + folder.id + '/files', 201, token, upload);
    const page = await browser.newPage({ viewport: { width: 956, height: 871 } });
    await page.goto(url);
    await page.getByLabel('E-Mail', { exact: true }).fill('admin@example.test');
    await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();

    // Preserve native menu actions while testing click-away for both row types.
    const folderRow = page.locator('.row').filter({ hasText: folderName });
    await folderRow.locator('summary').click();
    await folderRow.getByRole('button', { name: 'Freigeben', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Dateien und Ordner', exact: true }).click();
    assert.equal(await folderRow.locator('details').getAttribute('open'), null);
    await folderRow.getByRole('button', { name: folderName, exact: true }).click();
    const fileRow = page.locator('.row').filter({ hasText: 'Probe.txt' });
    await fileRow.locator('summary').click();
    await fileRow.getByRole('button', { name: 'Umbenennen', exact: true }).waitFor();
    await page.getByRole('heading', { name: folderName, exact: true }).click();
    await fileRow.locator('summary[aria-expanded=false]').waitFor();

    const dialog = page.getByRole('dialog');
    const button = name => dialog.getByRole('button', { name, exact: true });
    const confirmed = text => dialog.getByRole('status').filter({ hasText: text }).waitFor();
    const openAccounts = () => page.getByRole('button', { name: 'Nutzerverwaltung', exact: true }).click();
    const accountPage = page.locator('.account-page');
    await openAccounts();
    if (!reuseGuest) {
      await accountPage.getByLabel('E-Mail für neues Konto').fill(guest);
      await accountPage.locator('select[name=accountType]').selectOption('internal');
      await accountPage.getByRole('button', { name: 'Konto anlegen', exact: true }).click();
      await accountPage.getByText(guest, { exact: true }).waitFor();
      await acceptInvitation(guest, guestPassword);
    }
    const manage = async () => {
      await accountPage.getByRole('button', { name: 'Freigaben für ' + guest + ' verwalten' }).click();
      await dialog.getByRole('heading', { name: 'Kontotyp und Freigaben' }).waitFor();
    };
    await manage();
    await dialog.locator('select[name=accountType]').selectOption('external');
    await button('Kontotyp speichern').click();
    await confirmed('Kontotyp gespeichert.');
    await button('Zurück zu den Konten').click();
    const accountRow = accountPage.locator('.account-row').filter({ hasText: guest });
    await accountRow.getByText('Extern · Mitglied').waitFor();
    await manage();

    const { token: restricted } = await signIn(guest, guestPassword);
    const account = await request('GET', '/me', 200, restricted);
    assert.equal(account.account_type, 'external');
    await request('GET', '/users/' + account.id + '/shares', 403, restricted);
    await request('PATCH', '/users/' + account.id, 403, restricted, { accountType: 'internal' });

    async function grant(kind, id, permission) {
      await button('Freigabe hinzufügen').click();
      await dialog.getByLabel('Datei oder Ordner').selectOption(kind + ':' + id);
      await dialog.getByLabel('Berechtigung').selectOption(permission);
      await button('Freigabe hinzufügen').click();
      await confirmed('Freigabe erteilt.');
    }
    await grant('folder', folder.id, 'read');
    const direct = dialog.locator('.account-row').filter({ hasText: folderName });
    await direct.getByText('Ordner · Lesen', { exact: true }).waitFor();
    let visible = await request('GET', '/files', 200, restricted);
    assert.equal(visible.find(item => item.id === file.id).rights.write, false);

    await direct.getByRole('button', { name: 'Ändern', exact: true }).click();
    await dialog.getByLabel('Berechtigung').selectOption('write');
    await dialog.getByLabel('Dateien ausdrücklich zum Löschen freigeben').check();
    await button('Freigabe ändern').click();
    await confirmed('Freigabe geändert.');
    visible = await request('GET', '/files', 200, restricted);
    const rights = visible.find(item => item.id === file.id).rights;
    assert.equal(rights.write, true);
    assert.equal(rights.deleteFiles, true);

    await grant('file', file.id, 'read');
    const directFile = dialog.locator('.account-row').filter({ hasText: 'Probe.txt' });
    await directFile.getByText('Datei · Lesen', { exact: true }).waitFor();
    await directFile.getByRole('button', { name: 'Widerrufen', exact: true }).click();
    await button('Freigabe widerrufen').click();
    await confirmed('Freigabe widerrufen.');
    assert.ok((await request('GET', '/files', 200, restricted)).some(item => item.id === file.id));

    await dialog.locator('.account-row').filter({ hasText: folderName }).getByRole('button', { name: 'Widerrufen', exact: true }).click();
    await button('Freigabe widerrufen').click();
    await confirmed('Freigabe widerrufen.');
    assert.ok(!(await request('GET', '/files', 200, restricted)).some(item => item.id === file.id));
  } finally {
    await browser.close();
    if (folder) await request('DELETE', '/folders/' + folder.id, 204, token);
  }
});

test('admin manages an existing share on the object and sends a password reset', { timeout: 90000 }, async () => {
  const suffix = randomUUID();
  const email = `object-${suffix}@example.test`;
  const { token } = await signIn('admin@example.test', adminPassword);
  const account = await request('POST', '/users', 201, token, { email, password: 'temporary-test-password' });
  const folderName = 'Objektfreigabe ' + suffix;
  const folder = await request('POST', '/folders', 201, token, { name: folderName });
  const share = await request('POST', '/shares', 201, token, { userId: account.id, folderId: folder.id, permission: 'read' });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.getByLabel('E-Mail', { exact: true }).fill('admin@example.test');
    await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    const row = page.locator('.row').filter({ hasText: folderName });
    await row.locator('summary').click();
    await row.getByRole('button', { name: 'Freigeben', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const entry = dialog.locator('.account-row').filter({ hasText: email });
    await entry.getByText('Lesen', { exact: true }).waitFor();
    assert.equal(await dialog.getByLabel('Konto').locator(`option[value="${account.id}"]`).count(), 0);
    await entry.getByRole('button', { name: 'Ändern', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Freigabe ändern', exact: true }).waitFor();
    await dialog.getByLabel('Berechtigung').selectOption('write');
    await dialog.getByLabel('Gültig bis (optional)').fill('2099-01-01T12:00');
    const update = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/shares/' + share.id);
    await dialog.getByRole('button', { name: 'Freigabe ändern', exact: true }).click();
    assert.equal((await update).request().postDataJSON().permission, 'write');
    await dialog.waitFor({ state: 'hidden' });
    const updatedShare = (await request('GET', '/folders/' + folder.id + '/shares', 200, token)).find(item => item.id === share.id);
    assert.equal(updatedShare.permission, 'write');
    assert.ok(updatedShare.expiresAt);
    await page.getByRole('button', { name: 'Nutzerverwaltung', exact: true }).click();
    await page.getByRole('button', { name: 'Passwort für ' + email + ' zurücksetzen' }).click();
    await page.getByRole('status').filter({ hasText: 'Link zum Zurücksetzen des Passworts' }).waitFor();
  } finally {
    await browser.close();
    await request('DELETE', '/folders/' + folder.id, 204, token);
  }
});

test('internal account shares a visible folder only within its rights', { timeout: 90000 }, async () => {
  const { token: admin } = await signIn('admin@example.test', adminPassword);
  const password = 'internal-test-password';
  const actor = await request('POST', '/users', 201, admin, { email: `internal-${randomUUID()}@example.test`, password, accountType: 'internal' });
  const recipient = await request('POST', '/users', 201, admin, { email: `recipient-${randomUUID()}@example.test`, password, accountType: 'external' });
  const folderName = 'Weitergabe ' + randomUUID();
  const folder = await request('POST', '/folders', 201, admin, { name: folderName });
  await request('POST', '/shares', 201, admin, { userId: actor.id, folderId: folder.id, permission: 'read' });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(); await page.goto(url);
    await page.getByLabel('E-Mail', { exact: true }).fill(actor.email);
    await page.getByLabel('Passwort', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Nutzerverwaltung', exact: true }).count(), 0);
    const row = page.locator('.row').filter({ hasText: folderName });
    await row.locator('summary').click();
    await row.getByRole('button', { name: 'Freigeben', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Konto').selectOption(recipient.id);
    await dialog.getByLabel('Berechtigung').selectOption('write');
    await dialog.getByRole('button', { name: 'Freigabe erteilen', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'nur deine eigenen Rechte' }).waitFor();
    await dialog.getByLabel('Berechtigung').selectOption('read');
    await dialog.getByRole('button', { name: 'Freigabe erteilen', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const shared = await request('GET', '/folders/' + folder.id + '/shares', 200, admin);
    assert.equal(shared.find(item => item.userId === recipient.id)?.permission, 'read');
    const { token: recipientToken } = await signIn(recipient.email, password);
    assert.ok((await request('GET', '/folders', 200, recipientToken)).some(item => item.id === folder.id));
  } finally { await browser.close(); await request('DELETE', '/folders/' + folder.id, 204, admin); }
});

test('admin promotes an existing internal account from its details', { timeout: 90000 }, async () => {
  const { token: admin } = await signIn('admin@example.test', adminPassword);
  const password = 'promote-test-password';
  const internal = await request('POST', '/users', 201, admin, { email: `promote-${randomUUID()}@example.test`, password, accountType: 'internal' });
  const external = await request('POST', '/users', 201, admin, { email: `external-${randomUUID()}@example.test`, password, accountType: 'external' });
  const { token: internalToken } = await signIn(internal.email, password);
  await request('GET', '/users', 403, internalToken);
  await request('POST', '/users/' + internal.id + '/admin', 403, internalToken);
  await request('POST', '/users/' + external.id + '/admin', 400, admin);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(); await page.goto(url);
    await page.getByLabel('E-Mail', { exact: true }).fill('admin@example.test');
    await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await page.getByRole('button', { name: 'Nutzerverwaltung', exact: true }).click();
    await page.getByRole('button', { name: 'Freigaben für ' + internal.email + ' verwalten' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Als Administrator erhält dieses Konto Vollzugriff auf alle Dateien und die Nutzerverwaltung.').waitFor();
    await dialog.getByRole('button', { name: 'Zum Administrator machen', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Konto ist jetzt Administrator.' }).waitFor();
    assert.equal((await request('GET', '/me', 200, internalToken)).is_admin, true);
    assert.ok((await request('GET', '/users', 200, internalToken)).some(account => account.id === internal.id));
    await dialog.getByRole('button', { name: 'Zurück zu den Konten', exact: true }).click();
    await page.locator('.account-row').filter({ hasText: internal.email }).getByText('Intern · Admin').waitFor();
  } finally { await browser.close(); }
});

test('administrator deactivates, reactivates and revokes sessions from account details', { timeout: 90000 }, async () => {
  const { token: admin } = await signIn('admin@example.test', adminPassword);
  const password = 'status-test-password';
  const account = await request('POST', '/users', 201, admin, { email: `status-${randomUUID()}@example.test`, password, accountType: 'internal' });
  const { token } = await signIn(account.email, password);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(); await page.goto(url);
    await page.getByLabel('E-Mail', { exact: true }).fill('admin@example.test');
    await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await page.getByRole('button', { name: 'Nutzerverwaltung', exact: true }).click();
    await page.getByRole('button', { name: 'Freigaben für ' + account.email + ' verwalten' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Konto deaktivieren', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Konto deaktiviert' }).waitFor();
    await request('GET', '/me', 401, token);
    await dialog.getByRole('button', { name: 'Konto aktivieren', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Konto aktiviert' }).waitFor();
    const { token: fresh } = await signIn(account.email, password);
    await dialog.getByRole('button', { name: 'Sitzungen widerrufen', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Sitzungen widerrufen' }).waitFor();
    await request('GET', '/me', 401, fresh);
  } finally { await browser.close(); }
});
