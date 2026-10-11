import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MmClient } from './client.ts';
import { mattermostActivity } from './activity.ts';
import { fakeServer } from './testing.ts';

for (const plainErrors of [false, true]) test('own activity preserves the entire custom status '+(plainErrors?'kChat':'Mattermost'), async () => {
  const custom = {text:'At lunch',emoji:'sandwich',duration:'today',expires_at:'2099-01-01T12:00:00Z'};
  const original = JSON.stringify(custom);
  let status = 'online';
  const server = fakeServer(call => {
    assert.equal(call.headers.Authorization, 'Bearer fixture-token');
    assert.equal(call.path, '/users/me/status', 'no custom-status endpoint can be changed');
    if (call.method === 'PUT') {
      assert.deepEqual(call.body, {user_id:'me',status:'dnd'});
      status='dnd';
    }
    return {body:{user_id:'me',status}};
  });
  const own = mattermostActivity(new MmClient(server.base,'fixture-token',{fetch:server.fetcher,plainErrors}), 'me');
  assert.equal(await own.read(), 'online');
  assert.equal(await own.set('busy'), 'busy');
  assert.equal(await own.read(), 'busy');
  assert.equal(JSON.stringify(custom),original);
  assert.deepEqual(server.calls.map(c=>c.method),['GET','PUT','GET']);
});

test('own activity refuses another account response and a failed write',async()=>{
  const wrong=fakeServer(()=>({body:{user_id:'other',status:'online'}}));
  await assert.rejects(mattermostActivity(new MmClient(wrong.base,'tok',{fetch:wrong.fetcher}),'me').read(),/Unexpected activity/);
  const denied=fakeServer(()=>({status:403,body:{id:'api.status.forbidden',message:'Forbidden'}}));
  await assert.rejects(mattermostActivity(new MmClient(denied.base,'tok',{fetch:denied.fetcher}),'me').set('away'),/Forbidden/);
});
