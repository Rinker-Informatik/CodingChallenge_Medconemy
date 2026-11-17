import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const api = process.env.API_URL;
const mail = process.env.MAIL_URL;
if (!api || !mail) throw new Error('API_URL und MAIL_URL fehlen. Bitte tests/run-integration.sh verwenden.');

async function ready(url) {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await delay(1000);
  }
  throw new Error(`${url} wurde nicht bereit: ${lastError}`);
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), ...options });
  const text = await response.text();
  assert.ok(response.ok, `${options.method || 'GET'} ${url}: HTTP ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

function post(url, body, token) {
  return jsonRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}

test('Freigabe eines Bereichs benachrichtigt den neuen Nutzer in Mailpit', { timeout: 270_000 }, async () => {
  await ready(`${mail}/api/v1/messages`);
  const deadline = Date.now() + 120_000;
  let login;
  while (Date.now() < deadline) {
    try {
      login = await post(`${api}/auth/login`, { email: 'admin@example.test', password: 'integration-admin-password' });
      break;
    } catch { await delay(1000); }
  }
  assert.ok(login?.token, 'Backend wurde nicht rechtzeitig bereit oder Admin-Anmeldung schlug fehl');
  const recipient = `integration-${randomUUID()}@example.test`;
  const password = 'integration-user-password';
  const user = await post(`${api}/users`, { email: recipient, password }, login.token);
  const folder = await post(`${api}/folders`, { name: 'Integrationstest', parentId: null }, login.token);
  const share = await post(`${api}/shares`, { userId: user.id, folderId: folder.id, permission: 'read' }, login.token);
  assert.equal(share.notified, true, 'Backend meldet fehlgeschlagenen SMTP-Versand');
  const userLogin = await post(`${api}/auth/login`, { email: recipient, password });
  const folders = await jsonRequest(`${api}/folders`, { headers: { authorization: `Bearer ${userLogin.token}` } });
  assert.ok(folders.some(item => item.id === folder.id), 'Freigegebener Bereich für Nutzer nicht sichtbar');
  const mailDeadline = Date.now() + 15_000;
  let message;
  while (Date.now() < mailDeadline && !message) {
    const inbox = await jsonRequest(`${mail}/api/v1/messages`);
    message = inbox.messages?.find(item => item.To?.some(to => to.Address.toLowerCase() === recipient.toLowerCase()));
    if (!message) await delay(250);
  }
  assert.ok(message, `Keine Mail für ${recipient} in Mailpit gefunden`);
  const detail = await jsonRequest(`${mail}/api/v1/message/${encodeURIComponent(message.ID)}`);
  assert.equal(detail.Subject, 'Bereich freigegeben');
  assert.match(detail.Text, new RegExp(folder.id));
  assert.ok(detail.To.some(to => to.Address.toLowerCase() === recipient.toLowerCase()));
});

test('Einzelfreigabe, Ordnervererbung und direkte Zugriffe werden serverseitig begrenzt', { timeout: 120_000 }, async () => {
  const { token: admin } = await post(`${api}/auth/login`, { email: 'admin@example.test', password: 'integration-admin-password' });
  const password = 'integration-user-password';
  const user = await post(`${api}/users`, { email: `access-${randomUUID()}@example.test`, password }, admin);
  const { token } = await post(`${api}/auth/login`, { email: user.email, password });
  const root = await post(`${api}/folders`, { name: 'Access root', parentId: null }, admin);
  const child = await post(`${api}/folders`, { name: 'Access child', parentId: root.id }, admin);
  const upload = async (folder, name) => {
    const form = new FormData();
    form.append('file', new Blob([name]), name);
    return jsonRequest(`${api}/folders/${folder.id}/files`, { method: 'POST', headers: { authorization: `Bearer ${admin}` }, body: form });
  };
  const shared = await upload(root, 'shared.txt');
  const hidden = await upload(child, 'hidden.txt');
  const headers = { authorization: `Bearer ${token}` };
  const direct = await post(`${api}/shares`, { userId: user.id, fileId: shared.id, permission: 'read' }, admin);
  assert.deepEqual((await jsonRequest(`${api}/files`, { headers })).map(file => file.id), [shared.id]);
  assert.deepEqual(await jsonRequest(`${api}/folders`, { headers }), []);
  assert.equal((await fetch(`${api}/files/${shared.id}/download`, { headers })).status, 200);
  assert.equal((await fetch(`${api}/files/${hidden.id}/download`, { headers })).status, 403);
  assert.equal((await fetch(`${api}/folders/${child.id}`, { method: 'DELETE', headers })).status, 403);
  await jsonRequest(`${api}/shares/${direct.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${admin}` } });
  await post(`${api}/shares`, { userId: user.id, folderId: root.id, permission: 'read' }, admin);
  assert.deepEqual(new Set((await jsonRequest(`${api}/folders`, { headers })).map(folder => folder.id)), new Set([root.id, child.id]));
  assert.deepEqual(new Set((await jsonRequest(`${api}/files`, { headers })).map(file => file.id)), new Set([shared.id, hidden.id]));
  assert.equal((await fetch(`${api}/files/${hidden.id}/download`, { headers })).status, 200);
});

test('Sicherheit: Authentifizierung, Rechteausweitung und Objektzugriff', { timeout: 120_000 }, async () => {
  const { token: admin } = await post(`${api}/auth/login`, { email: 'admin@example.test', password: 'integration-admin-password' });
  const password = 'security-test-password';
  const user = await post(`${api}/users`, { email: `security-${randomUUID()}@example.test`, password }, admin);
  const { token } = await post(`${api}/auth/login`, { email: user.email, password });
  const folder = await post(`${api}/folders`, { name: 'Private security test', parentId: null }, admin);
  const form = new FormData();
  form.append('file', new Blob(['private']), 'private.txt');
  const file = await jsonRequest(`${api}/folders/${folder.id}/files`, { method: 'POST', headers: { authorization: `Bearer ${admin}` }, body: form });
  const probe = async (method, path, expected, bearer, body) => {
    const response = await fetch(`${api}${path}`, { method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, expected, `${method} ${path}: ${await response.text()}`);
  };
  await probe('GET', '/files', 401);
  await probe('GET', '/files', 401, 'invalid.token.signature');
  await probe('GET', `/files/${file.id}/download`, 403, token);
  await probe('PATCH', `/files/${file.id}`, 403, token, { name: 'stolen.txt' });
  await probe('DELETE', `/files/${file.id}`, 403, token);
  await probe('DELETE', `/folders/${folder.id}`, 403, token);
  await probe('POST', '/shares', 403, token, { userId: user.id, fileId: file.id, permission: 'write' });
  await probe('POST', '/users', 403, token, { email: `elevate-${randomUUID()}@example.test`, password, isAdmin: true });
  await probe('PATCH', `/users/${user.id}`, 403, token, { accountType: 'internal', isAdmin: true });
  await probe('GET', `/users/${user.id}/shares`, 403, token);
  await probe('POST', '/auth/login', 400, undefined, { email: "' OR 1=1 --", password });
  await probe('POST', '/folders', 400, admin, { name: '../escape', parentId: null });
  assert.deepEqual(await jsonRequest(`${api}/files`, { headers: { authorization: `Bearer ${token}` } }), []);
});

test('Bearbeitungssperre schützt vor konkurrierenden Schreibzugriffen', { timeout: 120_000 }, async () => {
  const { token: admin } = await post(`${api}/auth/login`, { email: 'admin@example.test', password: 'integration-admin-password' });
  const folder = await post(`${api}/folders`, { name: 'Lock test', parentId: null }, admin);
  const form = new FormData();
  form.append('file', new Blob(['original']), 'lock.txt');
  const file = await jsonRequest(`${api}/folders/${folder.id}/files`, { method: 'POST', headers: { authorization: `Bearer ${admin}` }, body: form });
  const auth = { authorization: `Bearer ${admin}` };
  const lock = await post(`${api}/files/${file.id}/edit-lock`, {}, admin);
  const lockedFiles = await jsonRequest(`${api}/files`, { headers: auth });
  assert.equal(lockedFiles.find(item => item.id === file.id).locked_by_email, 'admin@example.test');
  const competing = await fetch(`${api}/files/${file.id}/edit-lock`, { method: 'POST', headers: auth });
  assert.equal(competing.status, 409);
  assert.equal((await fetch(`${api}/files/${file.id}`, { method: 'DELETE', headers: auth })).status, 409);
  assert.equal((await fetch(`${api}/folders/${folder.id}`, { method: 'DELETE', headers: auth })).status, 409);
  assert.equal((await fetch(`${api}/files/${file.id}`, { method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'changed.txt' }) })).status, 409);
  const replace = async lockToken => {
    const content = new FormData();
    content.append('file', new Blob(['updated']), 'lock.txt');
    return fetch(`${api}/files/${file.id}/content`, { method: 'PUT', headers: { ...auth, ...(lockToken ? { 'x-edit-lock': lockToken } : {}) }, body: content });
  };
  assert.equal((await replace()).status, 409);
  assert.equal((await replace(randomUUID())).status, 409);
  assert.equal((await fetch(`${api}/files/${file.id}/edit-lock`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ token: lock.token }) })).status, 204);
  assert.equal((await replace(lock.token)).status, 204);
  assert.equal((await fetch(`${api}/files/${file.id}/edit-lock`, { method: 'DELETE', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ token: lock.token }) })).status, 204);
  const unlockedFiles = await jsonRequest(`${api}/files`, { headers: auth });
  assert.equal(unlockedFiles.find(item => item.id === file.id).locked_by_email, null);
  const next = await post(`${api}/files/${file.id}/edit-lock`, {}, admin);
  assert.equal((await replace(lock.token)).status, 409);
  assert.equal((await replace(next.token)).status, 204);
});

test('Bestehende Objektfreigaben abrufen und Passwort-Zurücksetzen mailen', { timeout: 120_000 }, async () => {
  const { token: admin } = await post(`${api}/auth/login`, { email: 'admin@example.test', password: 'integration-admin-password' });
  const email = `reset-${randomUUID()}@example.test`;
  const user = await post(`${api}/users`, { email, password: 'integration-user-password' }, admin);
  const folder = await post(`${api}/folders`, { name: 'Object grants', parentId: null }, admin);
  const share = await post(`${api}/shares`, { userId: user.id, folderId: folder.id, permission: 'read' }, admin);
  const headers = { authorization: `Bearer ${admin}` };
  const shares = await jsonRequest(`${api}/folders/${folder.id}/shares`, { headers });
  assert.equal(shares.find(item => item.id === share.id)?.email, email);
  const result = await post(`${api}/users/${user.id}/invitation`, {}, admin);
  assert.equal(result.notified, true);
  const deadline = Date.now() + 15_000;
  let message;
  while (Date.now() < deadline && !message) {
    const inbox = await jsonRequest(`${mail}/api/v1/messages`);
    message = inbox.messages?.find(item => item.Subject === 'Passwort für Medconemy zurücksetzen' && item.To?.some(to => to.Address.toLowerCase() === email));
    if (!message) await delay(250);
  }
  assert.ok(message, 'E-Mail zum Zurücksetzen fehlt');
  const detail = await jsonRequest(`${mail}/api/v1/message/${message.ID}`);
  assert.match(detail.Text, /neues Passwort/);
  assert.doesNotMatch(detail.Text, /eingeladen/);
});

test('Interne Weitergabe bleibt auf aktuelle eigene Rechte begrenzt, auch über mehrere Stufen', { timeout: 120_000 }, async () => {
  const { token: admin } = await post(`${api}/auth/login`, { email: 'admin@example.test', password: 'integration-admin-password' });
  const password = 'delegation-test-password';
  const create = async type => {
    const user = await post(`${api}/users`, { email: `delegation-${randomUUID()}@example.test`, password, accountType: type }, admin);
    return { ...user, ...(await post(`${api}/auth/login`, { email: user.email, password })) };
  };
  const a = await create('internal'), b = await create('internal'), c = await create('external'), outsider = await create('external');
  const root = await post(`${api}/folders`, { name: 'Delegation root', parentId: null }, admin);
  const child = await post(`${api}/folders`, { name: 'Delegation child', parentId: root.id }, admin);
  const secret = await post(`${api}/folders`, { name: 'Hidden target', parentId: null }, admin);
  const form = new FormData(); form.append('file', new Blob(['delegated content']), 'delegated.txt');
  const file = await jsonRequest(`${api}/folders/${child.id}/files`, { method: 'POST', headers: { authorization: `Bearer ${admin}` }, body: form });
  const rootShare = await post(`${api}/shares`, { userId: a.id, folderId: root.id, permission: 'write', deleteFiles: true, deleteFolders: true }, admin);
  const request = async (method, path, token, body, expected) => {
    const response = await fetch(`${api}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text(); assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  await request('POST', '/shares', a.token, { userId: b.id, folderId: secret.id, permission: 'read' }, 403);
  await request('POST', '/shares', outsider.token, { userId: b.id, folderId: root.id, permission: 'read' }, 403);
  const delegated = await request('POST', '/shares', a.token, { userId: b.id, folderId: child.id, permission: 'write', deleteFiles: true, deleteFolders: true }, 201);
  const next = await request('POST', '/shares', b.token, { userId: c.id, fileId: file.id, permission: 'write', deleteFiles: true }, 201);
  await request('POST', '/shares', b.token, { userId: a.id, folderId: child.id, permission: 'read' }, 201);
  await request('PATCH', `/shares/${rootShare.id}`, a.token, { permission: 'read' }, 404);
  await request('DELETE', `/shares/${delegated.id}`, b.token, undefined, 404);
  let files = await request('GET', '/files', c.token, undefined, 200);
  assert.equal(files.find(item => item.id === file.id).rights.write, true);
  await request('PATCH', `/shares/${rootShare.id}`, admin, { permission: 'read' }, 204);
  files = await request('GET', '/files', c.token, undefined, 200);
  const downgraded = files.find(item => item.id === file.id).rights;
  assert.equal(downgraded.read, true); assert.equal(downgraded.write, false); assert.equal(downgraded.deleteFiles, false);
  await request('PATCH', `/shares/${next.id}`, b.token, { permission: 'write' }, 403);
  await request('PATCH', `/users/${b.id}`, admin, { accountType: 'external' }, 204);
  assert.equal((await request('GET', '/files', c.token, undefined, 200)).some(item => item.id === file.id), false);
  await request('PATCH', `/users/${b.id}`, admin, { accountType: 'internal' }, 204);
  assert.equal((await request('GET', '/files', c.token, undefined, 200)).some(item => item.id === file.id), true);
  await request('PATCH', `/users/${b.id}/status`, admin, { isActive: false }, 204);
  assert.equal((await request('GET', '/files', c.token, undefined, 200)).some(item => item.id === file.id), false);
  await request('PATCH', `/users/${b.id}/status`, admin, { isActive: true }, 204);
  assert.equal((await request('GET', '/files', c.token, undefined, 200)).some(item => item.id === file.id), true);
  await request('DELETE', `/shares/${rootShare.id}`, admin, undefined, 204);
  files = await request('GET', '/files', c.token, undefined, 200);
  assert.equal(files.some(item => item.id === file.id), false);
  assert.equal((await request('GET', '/folders', a.token, undefined, 200)).some(item => item.id === child.id), false);
  await request('GET', `/files/${file.id}/download`, c.token, undefined, 403);
  await request('DELETE', `/shares/${delegated.id}`, a.token, undefined, 204);
});

test('Dateiversionen bleiben lesbar und werden als neuer Stand wiederhergestellt', { timeout: 120_000 }, async () => {
  const { token: admin } = await post(`${api}/auth/login`, { email: 'admin@example.test', password: 'integration-admin-password' });
  const password = 'version-reader-password';
  const reader = await post(`${api}/users`, { email: `versions-${randomUUID()}@example.test`, password }, admin);
  const { token: readToken } = await post(`${api}/auth/login`, { email: reader.email, password });
  const folder = await post(`${api}/folders`, { name: 'Versionsprüfung', parentId: null }, admin);
  const upload = async (method, path, content) => {
    const body = new FormData(); body.append('file', new Blob([content]), 'version.txt');
    return fetch(`${api}${path}`, { method, headers: { authorization: `Bearer ${admin}` }, body });
  };
  const file = await (await upload('POST', `/folders/${folder.id}/files`, 'erste Version')).json();
  assert.equal((await upload('PUT', `/files/${file.id}/content`, 'zweite Version')).status, 204);
  const headers = { authorization: `Bearer ${admin}` };
  const history = await jsonRequest(`${api}/files/${file.id}/versions`, { headers });
  assert.equal(history.length, 1); assert.equal(history[0].version, 1); assert.equal('object_key' in history[0], false);
  assert.equal(await (await fetch(`${api}/files/${file.id}/versions/${history[0].id}/download`, { headers })).text(), 'erste Version');
  assert.equal((await fetch(`${api}/files/${file.id}/versions`, { headers: { authorization: `Bearer ${readToken}` } })).status, 403);
  await post(`${api}/shares`, { userId: reader.id, fileId: file.id, permission: 'read' }, admin);
  assert.equal((await fetch(`${api}/files/${file.id}/versions/${history[0].id}/restore`, { method: 'POST', headers: { authorization: `Bearer ${readToken}` } })).status, 403);
  assert.equal((await fetch(`${api}/files/${file.id}/versions/${history[0].id}/restore`, { method: 'POST', headers })).status, 204);
  assert.equal(await (await fetch(`${api}/files/${file.id}/download`, { headers })).text(), 'erste Version');
  const after = await jsonRequest(`${api}/files/${file.id}/versions`, { headers });
  assert.equal(after.length, 2);
  const second = after.find(item => item.version === 2);
  assert.equal(await (await fetch(`${api}/files/${file.id}/versions/${second.id}/download`, { headers })).text(), 'zweite Version');
});

test('Papierkorb schützt gelöschte Inhalte und stellt Versionen, Freigaben und Ordner wieder her', { timeout: 120_000 }, async () => {
  const { token: admin } = await post(`${api}/auth/login`, { email: 'admin@example.test', password: 'integration-admin-password' });
  const password = 'trash-reader-password';
  const reader = await post(`${api}/users`, { email: `trash-${randomUUID()}@example.test`, password }, admin);
  const { token: readerToken } = await post(`${api}/auth/login`, { email: reader.email, password });
  const root = await post(`${api}/folders`, { name: 'Papierkorb Test', parentId: null }, admin);
  const child = await post(`${api}/folders`, { name: 'Unterordner', parentId: root.id }, admin);
  const upload = async (method, path, content) => {
    const form = new FormData(); form.append('file', new Blob([content]), 'notiz.txt');
    return fetch(`${api}${path}`, { method, headers: { authorization: `Bearer ${admin}` }, body: form });
  };
  const file = await (await upload('POST', `/folders/${child.id}/files`, 'erste')).json();
  assert.equal((await upload('PUT', `/files/${file.id}/content`, 'zweite')).status, 204);
  await post(`${api}/shares`, { userId: reader.id, fileId: file.id, permission: 'read' }, admin);
  const headers = { authorization: `Bearer ${admin}` }, readerHeaders = { authorization: `Bearer ${readerToken}` };
  assert.equal((await fetch(`${api}/files/${file.id}`, { method: 'DELETE', headers })).status, 204);
  assert.equal((await fetch(`${api}/files/${file.id}/download`, { headers })).status, 404);
  assert.equal((await fetch(`${api}/files/${file.id}/versions`, { headers: readerHeaders })).status, 404);
  const trash = await jsonRequest(`${api}/trash`, { headers });
  const item = trash.find(entry => entry.target_id === file.id); assert.ok(item);
  assert.equal(new Date(item.expires_at).getTime() - new Date(item.deleted_at).getTime(), 30 * 24 * 60 * 60 * 1000);
  assert.equal((await jsonRequest(`${api}/trash`, { headers: readerHeaders })).some(entry => entry.id === item.id), false);
  assert.equal((await fetch(`${api}/trash/${item.id}/restore`, { method: 'POST', headers: readerHeaders })).status, 404);
  assert.equal((await fetch(`${api}/trash/${item.id}/restore`, { method: 'POST', headers })).status, 204);
  assert.ok((await jsonRequest(`${api}/activity`, { headers })).some(event => event.object_id === file.id && event.action === 'Datei wiederhergestellt'));
  assert.equal(await (await fetch(`${api}/files/${file.id}/download`, { headers: readerHeaders })).text(), 'zweite');
  assert.equal((await jsonRequest(`${api}/files/${file.id}/versions`, { headers })).length, 1);
  assert.equal((await fetch(`${api}/folders/${child.id}`, { method: 'DELETE', headers })).status, 204);
  assert.equal((await fetch(`${api}/folders/${root.id}`, { method: 'DELETE', headers })).status, 204);
  const entries = await jsonRequest(`${api}/trash`, { headers });
  const childTrash = entries.find(entry => entry.target_id === child.id), rootTrash = entries.find(entry => entry.target_id === root.id);
  assert.equal((await fetch(`${api}/trash/${childTrash.id}/restore`, { method: 'POST', headers })).status, 404);
  assert.equal((await fetch(`${api}/trash/${rootTrash.id}/restore`, { method: 'POST', headers })).status, 204);
  assert.equal((await fetch(`${api}/trash/${childTrash.id}/restore`, { method: 'POST', headers })).status, 204);
  assert.equal(await (await fetch(`${api}/files/${file.id}/download`, { headers: readerHeaders })).text(), 'zweite');
});

test('Ablauf einer Freigabe begrenzt weitergegebene Rechte und lässt unabhängige Freigaben bestehen', { timeout: 120_000 }, async () => {
  const { token: admin } = await post(`${api}/auth/login`, { email: 'admin@example.test', password: 'integration-admin-password' });
  const password = 'expiration-password';
  const create = async type => { const user = await post(`${api}/users`, { email: `expiry-${randomUUID()}@example.test`, password, accountType: type }, admin); return { ...user, ...(await post(`${api}/auth/login`, { email: user.email, password })) }; };
  const a = await create('internal'), b = await create('external');
  const folder = await post(`${api}/folders`, { name: 'Expiry test', parentId: null }, admin);
  const form = new FormData(); form.append('file', new Blob(['expiry']), 'expiry.txt');
  const file = await (await fetch(`${api}/folders/${folder.id}/files`, { method: 'POST', headers: { authorization: `Bearer ${admin}` }, body: form })).json();
  const source = await post(`${api}/shares`, { userId: a.id, folderId: folder.id, permission: 'read', expiresAt: new Date(Date.now() + 3600000).toISOString() }, admin);
  await post(`${api}/shares`, { userId: b.id, fileId: file.id, permission: 'read' }, a.token);
  const list = async () => jsonRequest(`${api}/files`, { headers: { authorization: `Bearer ${b.token}` } });
  assert.ok((await list()).some(item => item.id === file.id));
  const headers = { authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${api}/shares/${source.id}`, { method: 'PATCH', headers, body: JSON.stringify({ permission: 'read', expiresAt: new Date(Date.now() - 1000).toISOString() }) })).status, 204);
  assert.equal((await list()).some(item => item.id === file.id), false);
  assert.equal((await fetch(`${api}/files/${file.id}/download`, { headers: { authorization: `Bearer ${b.token}` } })).status, 403);
  await post(`${api}/shares`, { userId: b.id, folderId: folder.id, permission: 'read' }, admin);
  assert.ok((await list()).some(item => item.id === file.id));
  const shares = await jsonRequest(`${api}/folders/${folder.id}/shares`, { headers });
  assert.ok(shares.find(item => item.id === source.id).expiresAt);
});

test('Kontodeaktivierung, Sitzungswiderruf und Passwortwechsel widerrufen alte Tokens', { timeout: 120_000 }, async () => {
  const { token: admin } = await post(`${api}/auth/login`, { email: 'admin@example.test', password: 'integration-admin-password' });
  const password = 'session-test-password';
  const user = await post(`${api}/users`, { email: `sessions-${randomUUID()}@example.test`, password, accountType: 'internal' }, admin);
  const { token } = await post(`${api}/auth/login`, { email: user.email, password });
  const adminHeaders = { authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
  const bearer = token => ({ authorization: `Bearer ${token}` });
  const status = (id, isActive, headers = adminHeaders) => fetch(`${api}/users/${id}/status`, { method: 'PATCH', headers, body: JSON.stringify({ isActive }) });
  assert.equal((await status(user.id, false, { ...bearer(token), 'content-type': 'application/json' })).status, 403);
  const me = await jsonRequest(`${api}/me`, { headers: bearer(admin) });
  assert.equal((await status(me.id, false)).status, 409);
  assert.equal((await status(user.id, false)).status, 204);
  assert.equal((await fetch(`${api}/me`, { headers: bearer(token) })).status, 401);
  assert.equal((await fetch(`${api}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) })).status, 401);
  assert.equal((await status(user.id, true)).status, 204);
  assert.equal((await fetch(`${api}/me`, { headers: bearer(token) })).status, 401);
  let fresh = (await post(`${api}/auth/login`, { email: user.email, password })).token;
  assert.equal((await fetch(`${api}/users/${user.id}/sessions/revoke`, { method: 'POST', headers: adminHeaders })).status, 204);
  assert.equal((await fetch(`${api}/me`, { headers: bearer(fresh) })).status, 401);
  fresh = (await post(`${api}/auth/login`, { email: user.email, password })).token;
  await post(`${api}/users/${user.id}/invitation`, {}, admin);
  let message; const deadline = Date.now() + 15000;
  while (!message && Date.now() < deadline) {
    const inbox = await jsonRequest(`${mail}/api/v1/messages`);
    message = inbox.messages.find(item => item.Subject === 'Passwort für Medconemy zurücksetzen' && item.To?.some(to => to.Address.toLowerCase() === user.email));
    if (!message) await delay(250);
  }
  assert.ok(message);
  const detail = await jsonRequest(`${mail}/api/v1/message/${message.ID}`);
  const reset = detail.Text.match(/#token=([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(reset);
  assert.equal((await fetch(`${api}/auth/accept-invitation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: reset, password: 'new-session-test-password' }) })).status, 204);
  assert.equal((await fetch(`${api}/me`, { headers: bearer(fresh) })).status, 401);
  assert.ok((await post(`${api}/auth/login`, { email: user.email, password: 'new-session-test-password' })).token);
});

test('Aktivitätsprotokoll ist auf aktuelle Objektberechtigungen begrenzt', { timeout: 120_000 }, async () => {
  const { token: admin } = await post(`${api}/auth/login`, { email: 'admin@example.test', password: 'integration-admin-password' });
  const password = 'activity-test-password';
  const reader = await post(`${api}/users`, { email: `activity-${randomUUID()}@example.test`, password }, admin);
  const { token } = await post(`${api}/auth/login`, { email: reader.email, password });
  const folder = await post(`${api}/folders`, { name: 'Aktivität ' + randomUUID(), parentId: null }, admin);
  const form = new FormData(); form.append('file', new Blob(['audit']), 'audit.txt');
  const file = await (await fetch(`${api}/folders/${folder.id}/files`, { method: 'POST', headers: { authorization: `Bearer ${admin}` }, body: form })).json();
  const headers = { authorization: `Bearer ${token}` }, adminHeaders = { authorization: `Bearer ${admin}` };
  const activity = async headers => jsonRequest(`${api}/activity`, { headers });
  assert.equal((await activity(headers)).some(item => item.object_id === file.id), false);
  const share = await post(`${api}/shares`, { userId: reader.id, fileId: file.id, permission: 'read' }, admin);
  let visible = await activity(headers);
  assert.ok(visible.some(item => item.object_id === file.id && item.action === 'Datei hochgeladen'));
  assert.ok(visible.some(item => item.object_id === file.id && item.action === 'Freigabe erteilt'));
  assert.equal((await fetch(`${api}/shares/${share.id}`, { method: 'DELETE', headers: adminHeaders })).status, 204);
  assert.equal((await activity(headers)).some(item => item.object_id === file.id), false);
  assert.ok((await activity(adminHeaders)).some(item => item.object_id === file.id && item.action === 'Freigabe widerrufen'));
});

test('Doppelte Uploadnamen erfordern eine Auswahl und Ersetzen prüft Rechte und Sperre', { timeout: 120_000 }, async () => {
  const { token: admin } = await post(`${api}/auth/login`, { email: 'admin@example.test', password: 'integration-admin-password' });
  const password = 'collision-password';
  const user = await post(`${api}/users`, { email: `collision-${randomUUID()}@example.test`, password }, admin);
  const { token } = await post(`${api}/auth/login`, { email: user.email, password });
  const folder = await post(`${api}/folders`, { name: 'Kollisionen', parentId: null }, admin);
  await post(`${api}/shares`, { userId: user.id, folderId: folder.id, permission: 'upload' }, admin);
  const upload = (bearer, name, content, extra = {}) => {
    const body = new FormData(); body.append('file', new Blob([content]), name);
    return fetch(`${api}/folders/${folder.id}/files`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, ...extra }, body });
  };
  const first = await (await upload(admin, 'gleich.txt', 'alt')).json();
  assert.equal((await upload(admin, 'gleich.txt', 'neu')).status, 409);
  assert.equal((await upload(admin, 'gleich.txt', 'weitere', { 'X-Upload-Keep': 'true' })).status, 201);
  assert.equal((await upload(admin, 'neu.txt', 'umbenannt')).status, 201);
  const simultaneous = await Promise.all([upload(admin, 'parallel.txt', 'eins'), upload(admin, 'parallel.txt', 'zwei')]);
  assert.deepEqual(simultaneous.map(response => response.status).sort(), [201, 409]);
  assert.equal((await upload(token, 'gleich.txt', 'fremd', { 'X-Upload-Replace': first.id })).status, 403);
  const lock = await post(`${api}/files/${first.id}/edit-lock`, {}, admin);
  assert.equal((await upload(admin, 'gleich.txt', 'gesperrt', { 'X-Upload-Replace': first.id })).status, 409);
  const headers = { authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${api}/files/${first.id}/edit-lock`, { method: 'DELETE', headers, body: JSON.stringify({ token: lock.token }) })).status, 204);
  const replaced = await upload(admin, 'gleich.txt', 'ersetzt', { 'X-Upload-Replace': first.id });
  assert.equal(replaced.status, 201); assert.equal((await replaced.json()).id, first.id);
  assert.equal((await jsonRequest(`${api}/files/${first.id}/versions`, { headers })).length, 1);
  assert.equal(await (await fetch(`${api}/files/${first.id}/download`, { headers })).text(), 'ersetzt');
});
