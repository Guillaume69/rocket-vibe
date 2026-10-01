import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { NativeError, NativeTransport } from './transport.ts';
import { decodeNative } from './validation.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json', import.meta.url), 'utf8'));

describe('native protocol contract', () => {
  test('the Rust fixture is understood without rounding sequence numbers', () => {
    assert.equal(decodeNative('Message',fixture.message).position,'9007199254740993');
    assert.equal(decodeNative('Room',fixture.room).revision,'9007199254740993');
    assert.equal(decodeNative('Discovery',fixture.discovery).product,'rocketvibe');
    assert.equal(decodeNative('SyncBatch',fixture.sync_batch).changes[0].type,'room_removed');
  });
  test('malformed messages, unknown events and forged input fields are rejected', () => {
    assert.throws(() => decodeNative('Message',{...fixture.message,position:9007199254740992}));
    assert.throws(() => decodeNative('Change',{type:'unexpected',data:{}}));
    assert.throws(() => decodeNative('SendMessage',{...fixture.send_message,author_id:'someone-else'}));
  });
  test('authenticated requests keep the token on the configured origin and forbid redirects', async () => {
    const requests: {url:string; options?: RequestInit}[] = [];
    const fetcher: typeof fetch = async (url, options) => {
      requests.push({url:String(url),options});
      return Response.json(String(url).endsWith('/auth/login') ? fixture.session : fixture.message);
    };
    const client = new NativeTransport('https://example.org/chat/',fetcher);
    await client.login('alice','password');
    await client.send('room-id',fixture.send_message);
    assert.equal(requests[1].url,'https://example.org/chat/api/v1/rooms/room-id/messages');
    assert.equal(requests[1].options?.redirect,'error');
    assert.equal(new Headers(requests[1].options?.headers).get('authorization'),'Bearer fixture-token');
    assert.equal(new Headers(requests[0].options?.headers).has('authorization'),false);
  });
  test('an unrecognized native version is not silently treated as Rocket.Chat', async () => {
    const client = new NativeTransport('https://example.org',async () => Response.json({...fixture.discovery,protocol_versions:[99]}));
    await assert.rejects(client.discover(),/Unsupported RocketVibe/);
  });
  test('server errors stay structured and missing sessions never send a request', async () => {
    let calls = 0;
    const client = new NativeTransport('https://example.org',async () => { calls++; return Response.json(fixture.error,{status:401}); });
    await assert.rejects(client.snapshot(),(e: unknown) => e instanceof NativeError && e.code==='session_rejected');
    assert.equal(calls,0);
    await assert.rejects(client.login('alice','wrong'),(e: unknown) => e instanceof NativeError && e.status===401);
  });
  test('a recognized 429 suppresses early retries without rejecting the saved session', async t => {
    t.mock.timers.enable({apis:['Date']});
    let calls = 0;
    let revoked = false;
    const client = new NativeTransport('https://example.org',async url => {
      calls++;
      return String(url).endsWith('/me') ? Response.json(fixture.session.user)
        : Response.json({code:'ticket_limit',request_id:'test'},{status:429,headers:{'retry-after':'30'}});
    });
    client.restore('saved-token');
    client.surJetonRefuse = () => { revoked = true; };
    const limited = (e: unknown) => e instanceof NativeError && e.status === 429 && e.retryAfter === 30;
    await assert.rejects(client.socketUrl('cursor'),limited);
    await assert.rejects(client.socketUrl('cursor'),limited);
    assert.equal(calls,1);
    assert.equal(revoked,false);
    assert.equal((await client.me()).id,fixture.session.user.id);
    assert.equal(calls,2);
    t.mock.timers.tick(30_000);
    await assert.rejects(client.socketUrl('cursor'),limited);
    assert.equal(calls,3,'the cooldown must expire and allow a new request');
  });
  test('a malformed 429 does not install a server cooldown', async () => {
    let calls = 0;
    const client = new NativeTransport('https://example.org',async () => {
      calls++;
      return Response.json({message:'proxy error'},{status:429,headers:{'retry-after':'999999'}});
    });
    for (let n=0;n<2;n++) await assert.rejects(client.login('alice','wrong'),
      (e: unknown) => e instanceof NativeError && e.status === 0);
    assert.equal(calls,2);
  });
  test('action cooldown spans edits, deletes and reactions while keeping message reads available',async t => {
    t.mock.timers.enable({apis:['Date']});
    const verbs:string[]=[];
    const client=new NativeTransport('https://example.org',async (_,options) => {
      const verb=options?.method ?? 'GET'; verbs.push(verb);
      return verb==='GET'?Response.json(fixture.message):Response.json({code:'message_action_limit',request_id:'action-request'},{status:429,headers:{'retry-after':'1'}});
    });
    client.restore('saved-token');
    const input={operation_id:'action-id',expected_revision:'1'};
    const limited=(error:unknown)=>error instanceof NativeError && error.status===429 && error.requestId==='action-request' && error.retryAfter===1;
    await assert.rejects(client.editMessage('message-id',{...input,content:{kind:'plain',markdown:'Edited',mentions:[],quotes:[],files:[]}}),limited);
    assert.equal((await client.message('message-id')).id,fixture.message.id);
    await assert.rejects(client.deleteMessage('message-id',input),limited);
    await assert.rejects(client.setReaction('message-id',{operation_id:'reaction-id',emoji:'heart',present:true}),limited);
    assert.deepEqual(verbs,['PATCH','GET']);
    t.mock.timers.tick(1000);
    await assert.rejects(client.deleteMessage('message-id',input),limited);
    assert.deepEqual(verbs,['PATCH','GET','DELETE']);
  });
});
