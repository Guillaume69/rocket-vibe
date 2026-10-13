import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {NativeError,NativeTransport} from './transport.ts';
import {decodeNative} from './validation.ts';
import {preferencesInput,profileOperation} from './profileOperations.ts';
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

test('a preferences change sends do not disturb only when it names it',async()=>{
  const quiet={start_minute:1320,end_minute:480,time_zone:'Europe/Paris'};
  const before={...fixture.own_profile.preferences,quiet_hours:quiet,muted_until:'2026-07-01T13:00:00Z'};
  // A push level change: both fields ABSENT, so the server keeps them.
  const push=preferencesInput('op-1',before,{push_enabled:true,push_mentions_only:true});
  assert.equal('quiet_hours' in push,false);assert.equal('muted_until' in push,false);
  assert.equal(push.push_mentions_only,true);assert.equal(push.expected_revision,'preferences-revision');
  assert.equal('quiet_hours' in JSON.parse(JSON.stringify(push)),false);
  // A mute: only `muted_until` goes out; the schedule stays absent.
  const mute=preferencesInput('op-2',before,{muted_until:'2026-07-01T14:00:00Z'});
  assert.equal(mute.muted_until,'2026-07-01T14:00:00Z');assert.equal('quiet_hours' in mute,false);
  // Unmute and schedule off: `null` removes.
  assert.equal(preferencesInput('op-3',before,{muted_until:null}).muted_until,null);
  const off=preferencesInput('op-4',before,{quiet_hours:null});
  assert.equal(off.quiet_hours,null);assert.equal('muted_until' in off,false);
  const on=preferencesInput('op-5',fixture.own_profile.preferences,{quiet_hours:quiet});
  assert.deepEqual(on.quiet_hours,quiet);
  // The commands survive the store's decode, null included, and the transport sends them as is.
  for(const input of [push,mute,off,on])assert.deepEqual(profileOperation({kind:'preferences',input}),{kind:'preferences',input});
  const calls:string[]=[];
  const transport=new NativeTransport('http://localhost:3400',async(_input,options)=>{calls.push(options!.body as string);return new Response(JSON.stringify(fixture.profile_receipt));});
  transport.restore('native-test-token');
  await transport.updatePreferences(off);assert.deepEqual(JSON.parse(calls[0]),off);
  await transport.updatePreferences(push);assert.equal('quiet_hours' in JSON.parse(calls[1]),false);
  assert.throws(()=>decodeNative('UpdatePreferences',{...push,quiet_hours:{start_minute:1320,end_minute:480}}));
});

test('the read receipts switch sends that field alone, and no other change carries it',async()=>{
  const before={...fixture.own_profile.preferences,quiet_hours:{start_minute:1320,end_minute:480,time_zone:'Europe/Paris'},muted_until:'2026-07-01T13:00:00Z',share_read_receipts:true};
  const off=preferencesInput('op-1',before,{share_read_receipts:false});
  assert.equal(off.share_read_receipts,false);
  assert.equal('quiet_hours' in off,false);assert.equal('muted_until' in off,false);
  // The other fields as read.
  assert.equal(off.language,before.language);assert.equal(off.push_enabled,before.push_enabled);assert.equal(off.clock_24h,before.clock_24h);
  assert.equal(preferencesInput('op-2',before,{share_read_receipts:true}).share_read_receipts,true);
  // A language change (or a push level) leaves it absent: the server keeps it.
  assert.equal('share_read_receipts' in preferencesInput('op-3',{...before,share_read_receipts:false},{language:'fr'}),false);
  assert.deepEqual(profileOperation({kind:'preferences',input:off}),{kind:'preferences',input:off});
  const calls:string[]=[];
  const transport=new NativeTransport('http://localhost:3400',async(_input,options)=>{calls.push(options!.body as string);return new Response(JSON.stringify(fixture.profile_receipt));});
  transport.restore('native-test-token');
  await transport.updatePreferences(off);assert.equal(JSON.parse(calls[0]).share_read_receipts,false);
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
