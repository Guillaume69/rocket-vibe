import assert from 'node:assert/strict';
import { test } from 'node:test';

import { callingUrl } from './client.ts';
import { callSignal } from './index.ts';
import { CALL_APP, CHAT_APP, DECLINE_BODY, callPush, registration } from './trouter.ts';

const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64').replace(/=+$/, '');
const push = (body: unknown) => ({ id: 1, method: 'POST', url: '/v4/f/abc/', body: JSON.stringify(body) });

test('a ring names its caller and decline link; the conversation events after it end it', () => {
  const gp = {
    callNotification: {
      from: { id: '8:orgid:caller', displayName: 'Adà Lovelace' },
      to: { id: '8:orgid:me' },
      links: { reject: 'https://api.flightproxy.teams.microsoft.com/api/v2/ep/cc/forked/x/reject?i=1', attach: 'https://x/attach' },
    },
    conversationInvitation: { conversationController: 'https://x/conv/1', isMultiParty: false, isBroadcast: false },
    debugContent: { callId: '589ac9cc-0000-4000-8000-000000000000' },
    groupContext: null,
  };
  assert.deepEqual(callPush(push({ evt: 107, gp: base64(gp) })), {
    kind: 'ring', callId: '589ac9cc-0000-4000-8000-000000000000', callerMri: '8:orgid:caller', callerName: 'Adà Lovelace',
    reject: 'https://api.flightproxy.teams.microsoft.com/api/v2/ep/cc/forked/x/reject?i=1', multiParty: false, thread: null,
  });
  const group = { ...gp, conversationInvitation: { isMultiParty: true }, groupContext: { threadId: '19:abc@thread.v2' } };
  assert.equal((callPush(push({ evt: 107, gp: base64(group) })) as { thread: string }).thread, '19:abc@thread.v2');
  assert.deepEqual(callPush(push({ evt: 115, cp: 'gzip' })), { kind: 'moved' });
  assert.deepEqual(callPush(push({ evt: 116, cp: 'gzip' })), { kind: 'moved' });
  assert.equal(callPush(push({ evt: 1 })), null);
  assert.equal(callPush(push({ resourceType: 'NewMessage' })), null);
  assert.equal(DECLINE_BODY.callEnd.code, 603);
});

test('a ring rings on its 1:1 or its group conversation, never my own', () => {
  const me = '8:orgid:f1c9871e-4fe6-43b1-aa6f-5151f41cb073';
  const ring = { kind: 'ring' as const, callId: 'c1', callerMri: '8:orgid:e91438dc-73eb-4dd2-9689-2d77b9bd5fcc', callerName: 'Fairouz', reject: null, multiParty: false, thread: null };
  const oneOnOne = '19:e91438dc-73eb-4dd2-9689-2d77b9bd5fcc_f1c9871e-4fe6-43b1-aa6f-5151f41cb073@unq.gbl.spaces';
  assert.deepEqual(callSignal(ring, me), { kind: 'ring', rid: oneOnOne, messageId: 'c1', callId: oneOnOne, callerId: ring.callerMri, callerName: 'Fairouz' });
  assert.equal(callSignal({ ...ring, multiParty: true }, me), null, 'a group call the push names no conversation for');
  assert.equal(callSignal({ ...ring, multiParty: true, thread: '19:g@thread.v2' }, me)?.kind, 'ring');
  assert.equal(callSignal({ ...ring, callerMri: me }, me), null);
  assert.deepEqual(callSignal({ kind: 'moved' }, me), { kind: 'rung-over' });
});

test('calls are registered beside chat on the same path; a decline only goes to Teams calling hosts', () => {
  const chat = registration('a', 'https://x.trouter.teams.microsoft.com/v4/f/p/', CHAT_APP);
  const calls = registration('b', 'https://x.trouter.teams.microsoft.com/v4/f/p/', CALL_APP);
  assert.equal((calls.clientDescription as { appId: string }).appId, 'SkypeSpacesWeb');
  assert.deepEqual(chat.transports, calls.transports);
  assert.ok(callingUrl('https://api.flightproxy.teams.microsoft.com/api/v2/ep/cc/forked/x/reject?i=1'));
  assert.ok(callingUrl('https://cc-euwe-01-prod-aks.cc.skype.com/cc/v1/forked/x/reject'));
  for (const bad of ['http://api.flightproxy.teams.microsoft.com/reject', 'https://teams.microsoft.com.evil.example/reject', 'https://user@api.flightproxy.teams.microsoft.com/reject']) {
    assert.ok(!callingUrl(bad), bad);
  }
});
