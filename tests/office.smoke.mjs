import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const adminPassword = process.env.OFFICE_TEST_ADMIN_PASSWORD ?? 'integration-admin-password';
const main = 'http://schemas.openxmlformats.org';
const rel = main + '/officeDocument/2006/relationships';
const packageRel = main + '/package/2006/relationships';
const word = main + '/wordprocessingml/2006/main';
const sheet = main + '/spreadsheetml/2006/main';

function fixture(ext) {
  const isWord = ext === 'docx';
  const primary = isWord ? 'word/document.xml' : 'xl/workbook.xml';
  const type = isWord ? 'wordprocessingml.document' : 'spreadsheetml.sheet';
  const files = {
    '[Content_Types].xml': `<Types xmlns="${main}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${primary}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/>${isWord ? '' : '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'}</Types>`,
    '_rels/.rels': `<Relationships xmlns="${packageRel}"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="${primary}"/></Relationships>`,
  };
  if (isWord) {
    files[primary] = `<w:document xmlns:w="${word}"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Original</w:t></w:r></w:p></w:body></w:document>`;
  } else {
    files[primary] = `<workbook xmlns="${sheet}" xmlns:r="${rel}"><sheets><sheet name="Tabelle1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    files['xl/_rels/workbook.xml.rels'] = `<Relationships xmlns="${packageRel}"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
    files['xl/worksheets/sheet1.xml'] = `<worksheet xmlns="${sheet}"><sheetData><row r="1"><c r="A1"><v>3</v></c><c r="B1"><f>A1*2</f><v>6</v></c></row></sheetData></worksheet>`;
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])));
}

test('Chromium edits both Office formats and downloads saved OOXML', { timeout: 180_000 }, async () => {
  const folderName = 'Office Test ' + randomUUID().slice(0, 8);
  const auth = await fetch(process.env.UI_URL + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.test', password: adminPassword }),
  });
  assert.equal(auth.status, 200);
  const { token } = await auth.json();
  const headers = { Authorization: 'Bearer ' + token };
  const root = await fetch(process.env.UI_URL + '/api/folders', { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderName }),
  });
  assert.equal(root.status, 201);
  const { id: folder } = await root.json();
  const ids = {};
  for (const ext of ['docx', 'xlsx']) {
    const form = new FormData();
    form.append('file', new Blob([fixture(ext)]), 'Test.' + ext);
    const response = await fetch(process.env.UI_URL + '/api/folders/' + folder + '/files', { method: 'POST', headers, body: form });
    assert.equal(response.status, 201);
    ids[ext] = (await response.json()).id;
  }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
    const failures = [];
    page.on('response', res => { if (res.status() >= 400) failures.push(res.status() + ' ' + new URL(res.url()).pathname); });
    await page.goto(process.env.UI_URL);
    await page.getByLabel('E-Mail', { exact: true }).fill('admin@example.test');
    await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();

    for (const ext of ['docx', 'xlsx']) {
      await page.getByRole('navigation', { name: 'Ordnerbaum' }).getByRole('button', { name: folderName, exact: true }).click();
      const row = page.locator('.row').filter({ hasText: 'Test.' + ext });
      await row.locator('summary').click();
      await row.getByRole('button', { name: 'Im Browser bearbeiten' }).click();
      const frame = page.frameLocator('.office-frame iframe');
      try {
        await page.getByRole('button', { name: 'Speichern und schließen' }).waitFor({ timeout: 36_000 });
        const visibleFiles = await (await fetch(process.env.UI_URL + '/api/files', { headers })).json();
        assert.equal(visibleFiles.find(file => file.id === ids[ext]).locked_by_email, 'admin@example.test');
        assert.equal((await fetch(process.env.UI_URL + '/api/files/' + ids[ext] + '/editor', { method: 'POST', headers })).status, 409);
        const surface = frame.locator('#editor_sdk');
        await surface.waitFor();
        if (ext === 'docx') {
          await surface.click({ position: { x: 300, y: 200 } });
          await page.keyboard.press('Control+End');
          await page.keyboard.press('End');
          await page.keyboard.type(' MedconemyEdit');
        } else {
          await surface.click({ position: { x: 100, y: 75 } });
          await page.keyboard.press('Control+Home');
          await page.keyboard.press('8');
          await page.keyboard.press('Enter');
        }
        // Wait until the editor has propagated the input before destroying its iframe.
        await delay(1800);
        await page.getByRole('button', { name: 'Speichern und schließen' }).click();
        await page.getByText('Datei gespeichert.', { exact: true }).waitFor({ timeout: 48_000 });
        const after = await (await fetch(process.env.UI_URL + '/api/files', { headers })).json();
        assert.equal(after.find(file => file.id === ids[ext]).locked_by_email, null);
      } catch (error) {
        throw new Error(ext + ': ' + (await page.getByRole('status').allTextContents()).join(' / ') +
          '\nFehlgeschlagene Browser-Requests: ' + failures.join(', ') + '\n' + error.message);
      }
      const result = await fetch(process.env.UI_URL + '/api/files/' + ids[ext] + '/download', { headers });
      assert.equal(result.status, 200);
      const entries = unzipSync(new Uint8Array(await result.arrayBuffer()));
      if (ext === 'docx') {
        const xml = strFromU8(entries['word/document.xml']);
        assert.match(xml, /MedconemyEdit/);
        assert.match(xml, /<w:b[ />]/);
      } else {
        const xml = strFromU8(entries['xl/worksheets/sheet1.xml']);
        assert.match(xml, /<c\b[^>]*\br="A1"[^>]*>\s*<v>8<\/v>/);
        assert.match(xml, /<f[^>]*>A1\*2<\/f>/);
      }
    }
  } finally { await browser.close(); }
});

test('a failed Office load releases the file lock', { timeout: 90000 }, async () => {
  const base = process.env.UI_URL;
  const auth = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.test', password: adminPassword }) });
  const { token } = await auth.json();
  const headers = { authorization: `Bearer ${token}` };
  const folderName = 'Office Fehler ' + randomUUID();
  const folder = await (await fetch(base + '/api/folders', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: folderName }) })).json();
  const body = new FormData(); body.append('file', new Blob([fixture('docx')]), 'Fehler.docx');
  const file = await (await fetch(base + `/api/folders/${folder.id}/files`, { method: 'POST', headers, body })).json();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('**/web-apps/apps/api/documents/api.js', route => route.abort());
    await page.goto(base);
    await page.getByLabel('E-Mail', { exact: true }).fill('admin@example.test');
    await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await page.getByRole('navigation', { name: 'Ordnerbaum' }).getByRole('button', { name: folderName, exact: true }).click();
    const row = page.locator('.row').filter({ hasText: 'Fehler.docx' });
    await row.locator('summary').click();
    const released = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/editor\/[^/]+\/close$/.test(new URL(response.url()).pathname));
    await row.getByRole('button', { name: 'Im Browser bearbeiten' }).click();
    assert.equal((await released).status(), 204);
    const retry = await fetch(base + `/api/files/${file.id}/editor`, { method: 'POST', headers });
    assert.equal(retry.status, 201);
    const session = await retry.json();
    assert.equal((await fetch(base + `/api/editor/${session.id}/close`, { method: 'POST', headers })).status, 204);
  } finally { await browser.close(); }
});
