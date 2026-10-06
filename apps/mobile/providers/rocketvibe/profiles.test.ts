import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {NativeError,NativeTransport} from './transport.ts';
import {decodeNative} from './validation.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));

test('profile transports preserve public/private contracts and reject forged commands',async()=>{
  const calls:{url:URL;options:RequestInit}[]=[];
  const transport=new NativeTransport('http://localhost:3400',async(input,options)=>{
    const url=new URL(String(input));calls.push({url,options:options!});
    const value=url.pathname==='/api/v1/me/profile'?fixture.own_profile:options?.method==='PATCH'?fixture.profile_receipt:fixture.own_profile.profile;
    return new Response(JSON.stringify(value));
  });transport.restore('native-test-token');
  assert.equal((await transport.ownProfile()).profile.user.id,'alice-id');
  assert.equal((await transport.userProfile('id/with?path')).bio,'Salut');
  assert.equal(calls.at(-1)!.url.pathname,'/api/v1/users/id%2Fwith%3Fpath');
  await transport.lookupProfile('alice & bob?');assert.equal(calls.at(-1)!.url.searchParams.get('username'),'alice & bob?');
  await transport.updateProfile(fixture.update_profile);assert.equal(calls.at(-1)!.options.method,'PATCH');
  assert.deepEqual(JSON.parse(calls.at(-1)!.options.body as string),fixture.update_profile);
  await transport.updatePreferences(fixture.update_preferences);assert.equal(calls.at(-1)!.url.pathname,'/api/v1/me/preferences');
  assert.throws(()=>decodeNative('UpdateProfile',{...fixture.update_profile,user_id:'other'}));
  assert.throws(()=>decodeNative('UpdateProfile',{...fixture.update_profile,status:'admin'}));
  assert.throws(()=>decodeNative('UpdatePreferences',{...fixture.update_preferences,desktop_notifications:'unknown'}));
});

test('avatar transport sends binary bytes without a credential URL and bounds downloads',async()=>{
  let request:RequestInit|undefined,url:URL|undefined;
  const transport=new NativeTransport('http://localhost:3400',async(input,options)=>{
    url=new URL(String(input));request=options;
    return options?.method==='GET'?new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}}):new Response(JSON.stringify(fixture.profile_receipt));
  });transport.restore('native-test-token');
  await transport.setAvatar(fixture.avatar_command,{mime:'image/png',bytes:new Uint8Array([7,8,9])});
  assert.equal(request!.method,'PUT');assert.deepEqual(new Uint8Array(request!.body as ArrayBuffer),new Uint8Array([7,8,9]));
  assert.deepEqual(request!.headers,{'content-type':'image/png',authorization:'Bearer native-test-token'});
  assert.equal(url!.searchParams.get('operation_id'),'avatar-operation');assert.equal(url!.searchParams.has('token'),false);
  await transport.setAvatar(fixture.avatar_command);assert.equal(request!.method,'DELETE');assert.equal(request!.body,undefined);
  assert.deepEqual(await transport.avatarBytes('asset'),new Uint8Array([1,2,3]));
  await assert.rejects(transport.setAvatar(fixture.avatar_command,{mime:'image/png',bytes:new Uint8Array(2*1024*1024+1)}),/avatar_too_large/);
  let rejected=false;
  const huge=new NativeTransport('http://localhost:3400',async()=>new Response(new Uint8Array(1),{headers:{'content-type':'image/png','content-length':String(2*1024*1024+1)}}));
  huge.restore('token');huge.onTokenRejected=()=>{rejected=true;};
  await assert.rejects(huge.avatarBytes('asset'),/invalid_avatar/);assert.equal(rejected,false);
});

test('profile mutations share a server cooldown while reads remain available',async()=>{
  let calls=0;
  const transport=new NativeTransport('http://localhost:3400',async(_input,options)=>{
    calls++;
    if(options?.method==='GET')return new Response(JSON.stringify(fixture.own_profile));
    return new Response(JSON.stringify({code:'profile_rate_limited',request_id:'budget-request'}),{status:429,headers:{'retry-after':'60'}});
  });transport.restore('native-test-token');
  const throttled=(error:unknown)=>error instanceof NativeError && error.status===429 && error.requestId==='budget-request';
  await assert.rejects(transport.updateProfile(fixture.update_profile),throttled);
  await assert.rejects(transport.setAvatar(fixture.avatar_command),throttled);
  assert.equal(calls,1);await transport.ownProfile();assert.equal(calls,2);
});
