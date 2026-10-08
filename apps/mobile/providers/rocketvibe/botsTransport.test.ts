import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeError, NativeTransport } from './transport.ts';
import { decodeNative } from './validation.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json', import.meta.url), 'utf8')).bots;

test('bot management and the instance switch use typed authenticated routes', async()=>{
  const sent:{verb:string|undefined;url:string;body:string|undefined}[]=[];
  const client=new NativeTransport('https://example.org/chat',async(url,options)=>{
    assert.equal(new Headers(options?.headers).get('authorization'),'Bearer saved-token');
    const path=new URL(String(url)).pathname.replace('/chat','');
    sent.push({verb:options?.method,url:path,body:options?.body as string|undefined});
    if(options?.method==='DELETE')return new Response(null,{status:204});
    if(path==='/api/v1/bots')return Response.json(options?.method==='POST'?fixture.bot:fixture.bot_list);
    if(path==='/api/v1/bots/reference')return Response.json(fixture.bot_reference);
    if(path.endsWith('/keys'))return Response.json(options?.method==='POST'?fixture.bot_key_created:fixture.bot_key_list);
    if(path==='/api/v1/admin/settings')return Response.json(options?.method==='PATCH'?{user_bots:true}:fixture.instance_settings);
    return Response.json(fixture.bot);
  });
  client.restore('saved-token');
  assert.equal((await client.bots()).bots[0].user.bot,true);
  assert.equal((await client.createBot(fixture.create_bot)).owner.username,'alice');
  assert.deepEqual((await client.updateBot('helper-id',fixture.update_bot)).scopes,['rooms:read','messages:write']);
  await client.deleteBot('helper-id');
  assert.equal((await client.botKeys('helper-id')).keys[0].hint,'9f3a');
  assert.ok((await client.createBotKey('helper-id',fixture.create_bot_key)).key.startsWith('rvb_'));
  await client.revokeBotKey('helper-id','key id');
  assert.equal((await client.botReference()).sends_per_minute,60);
  assert.equal((await client.instanceSettings()).user_bots,false);
  assert.equal((await client.updateInstanceSettings(fixture.update_instance_settings)).user_bots,true);
  assert.deepEqual(sent.map(r=>[r.verb,r.url]),[
    ['GET','/api/v1/bots'],['POST','/api/v1/bots'],['PATCH','/api/v1/bots/helper-id'],['DELETE','/api/v1/bots/helper-id'],
    ['GET','/api/v1/bots/helper-id/keys'],['POST','/api/v1/bots/helper-id/keys'],['DELETE','/api/v1/bots/helper-id/keys/key%20id'],
    ['GET','/api/v1/bots/reference'],['GET','/api/v1/admin/settings'],['PATCH','/api/v1/admin/settings'],
  ]);
  assert.deepEqual(sent.filter(r=>r.body!==undefined).map(r=>JSON.parse(r.body!)),
    [fixture.create_bot,fixture.update_bot,fixture.create_bot_key,fixture.update_instance_settings]);
});

test('a bot photo is a raw PNG or JPEG body on the bot route, removed with DELETE', async()=>{
  const sent:{verb:string|undefined;url:string;type:string|null;body:unknown}[]=[];
  const client=new NativeTransport('https://example.org',async(url,options)=>{
    sent.push({verb:options?.method,url:new URL(String(url)).pathname,type:new Headers(options?.headers).get('content-type'),body:options?.body});
    return Response.json(options?.method==='PUT'?{...fixture.bot,avatar_file_id:'a'.repeat(64)}:fixture.bot);
  });
  client.restore('saved-token');
  const bytes=new Uint8Array([0x89,0x50,0x4e,0x47]);
  assert.equal((await client.setBotAvatar('helper id',{mime:'image/png',bytes})).avatar_file_id,'a'.repeat(64));
  assert.equal((await client.setBotAvatar('helper id')).avatar_file_id,undefined);
  assert.deepEqual(sent.map(r=>[r.verb,r.url,r.type]),[
    ['PUT','/api/v1/bots/helper%20id/avatar','image/png'],['DELETE','/api/v1/bots/helper%20id/avatar',null],
  ]);
  assert.deepEqual([...new Uint8Array(sent[0].body as ArrayBuffer)],[...bytes]);
  assert.equal(sent[1].body,undefined);
  await assert.rejects(client.setBotAvatar('helper-id',{mime:'image/jpeg',bytes:new Uint8Array(2*1024*1024+1)}),
    (error:unknown)=>error instanceof NativeError && error.code==='avatar_too_large');
  assert.equal(sent.length,2);
});

test('bot refusals keep their codes and never revoke the session', async()=>{
  let revoked=false;
  const client=new NativeTransport('https://example.org',async url=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/keys'))return Response.json({code:'reauthentication_required',request_id:'reauth'},{status:403});
    if(path.endsWith('/avatar'))return Response.json({code:'avatar_busy',request_id:'busy'},{status:429,headers:{'retry-after':'1'}});
    return Response.json({code:'bots_disabled',request_id:'closed'},{status:403});
  });
  client.restore('saved-token');client.onTokenRejected=()=>{revoked=true;};
  const code=(expected:string)=>(error:unknown)=>error instanceof NativeError && error.code===expected;
  await assert.rejects(client.createBot(fixture.create_bot),code('bots_disabled'));
  await assert.rejects(client.createBotKey('helper-id',fixture.create_bot_key),code('reauthentication_required'));
  await assert.rejects(client.setBotAvatar('helper-id',{mime:'image/png',bytes:new Uint8Array([1])}),code('avatar_busy'));
  assert.equal(revoked,false);
});

test('bot payloads are validated', ()=>{
  assert.throws(()=>decodeNative('Bot',{...fixture.bot,scopes:['admin:all']}));
  assert.throws(()=>decodeNative('BotKeyCreated',{...fixture.bot_key_created,key:12}));
  assert.equal(decodeNative('BotReference',fixture.bot_reference).groups[0].scope,undefined);
});
