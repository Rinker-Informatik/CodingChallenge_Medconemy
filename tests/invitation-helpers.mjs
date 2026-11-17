import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function invitationToken(email) {
  for (let i = 0; i < 40; i++) {
    const inbox = await (await fetch(process.env.MAIL_URL + '/api/v1/messages')).json();
    const message = inbox.messages?.find(item => item.Subject === 'Einladung zu Medconemy' && item.To?.some(to => to.Address.toLowerCase() === email.toLowerCase()));
    if (message) {
      const detail = await (await fetch(process.env.MAIL_URL + '/api/v1/message/' + message.ID)).json();
      const token = detail.Text.match(/#token=([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(token, 'Einladungslink fehlt');
      return token;
    }
    await delay(250);
  }
  throw new Error('Einladungs-E-Mail fehlt');
}
export async function acceptInvitation(email, password) {
  const token = await invitationToken(email);
  const response = await fetch(process.env.UI_URL + '/api/auth/accept-invitation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password }) });
  assert.equal(response.status, 204);
  return token;
}
