import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {NativeError,NativeTransport} from './transport.ts';
import {decodeNative} from './validation.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const registration=decodeNative('RegisterDevice',fixture.parity.e2ee_register_device);
const receipt=decodeNative('OperationReceipt',fixture.parity.e2ee_operation_receipt);
const directory=decodeNative('Directory',fixture.parity.e2ee_directory);

test('current group grants stay typed, private and readable during crypto cooldown',async()=>{
  const roster=decodeNative('GroupRoster',fixture.parity.e2ee_group_roster);
  const requests:{url:string;options?:RequestInit}[]=[];
  const transport=new NativeTransport('https://example.org',async(url,options)=>{
    requests.push({url:String(url),options});
    return new URL(String(url)).pathname.endsWith('/roster')?Response.json(roster):Response.json({code:'crypto_busy',request_id:'busy'},{status:429,headers:{'retry-after':'30'}});
  });
  transport.restore('saved-token');
  await assert.rejects(transport.registerCryptoDevice(registration),e=>e instanceof NativeError&&e.status===429);
  assert.deepEqual(await transport.cryptoGroupRoster('fixture/room'),roster);
  assert.equal(new URL(requests[1].url).pathname,'/api/v1/e2ee/rooms/fixture%2Froom/roster');
  assert.equal(requests[1].options?.method,'GET');
  assert.equal(new Headers(requests[1].options?.headers).get('authorization'),'Bearer saved-token');
  assert.equal(requests[1].options?.redirect,'error');
  assert.equal(roster.group?.revision,'9007199254740993');
  assert.equal(roster.members[0].access_version,'fixture-access');
  assert.deepEqual(decodeNative('GroupRoster',{...roster,group:null}).group,null);
  assert.throws(()=>decodeNative('GroupRoster',{...roster,members:[{...roster.members[0],activation_version:1}]}));
  assert.throws(()=>decodeNative('GroupRoster',{...roster,group:{...roster.group,epoch:9007199254740992}}));
  assert.throws(()=>decodeNative('GroupRoster',{...roster,welcome:'forbidden'}));
});

test('signed group transport preserves large revisions, targeted Welcome and original retry',async()=>{
  const input=decodeNative('GroupSubmission',fixture.parity.e2ee_group_submission);
  const state=decodeNative('GroupState',fixture.parity.e2ee_group_state);
  const events=decodeNative('GroupEventPage',fixture.parity.e2ee_group_events);
  const available=decodeNative('AvailableKeyPackage',fixture.parity.e2ee_available_key_package);
  const requests:{url:string;options?:RequestInit}[]=[];
  let lost=true;
  const transport=new NativeTransport('https://example.org',async(url,options)=>{
    requests.push({url:String(url),options});
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/state'))return Response.json(state);
    if(path.endsWith('/events'))return Response.json(events);
    if(path.includes('/key-packages/'))return Response.json(available);
    if(path.includes('/operations/'))return Response.json(state.receipt);
    if(lost){lost=false;throw new TypeError('Lost group receipt');}
    return Response.json(state.receipt);
  });
  transport.restore('saved-token');
  await assert.rejects(transport.submitCryptoGroup('fixture-room',input));
  assert.deepEqual(await transport.submitCryptoGroup('fixture-room',input),state.receipt);
  assert.equal(requests[0].options?.body,requests[1].options?.body);
  assert.deepEqual(await transport.cryptoGroupState('fixture-room'),state);
  assert.deepEqual(await transport.cryptoGroupEvents('fixture-room','9007199254740992'),events);
  assert.equal(new URL(requests[3].url).searchParams.get('after'),'9007199254740992');
  assert.equal(events.events[0].receipt.revision,'9007199254740993');
  assert.deepEqual(await transport.cryptoGroupOperation('fixture-room',input.operation_id),state.receipt);
  assert.deepEqual(await transport.availableCryptoKeyPackage('fixture-room','fixture-user','fixture-device'),available);
  assert.throws(()=>decodeNative('GroupState',{...state,receipt:{...state.receipt,epoch:9007199254740992}}));
  assert.throws(()=>decodeNative('GroupEventPage',{...events,events:[{...events.events[0],private_key:'forbidden'}]}));
});

test('E2EE transport replays the original public intent after lost acknowledgement',async()=>{
  const requests:{url:string;options?:RequestInit}[]=[];
  let lost=true;
  const transport=new NativeTransport('https://example.org',async(url,options)=>{
    requests.push({url:String(url),options});
    if(String(url).includes('/users/'))return Response.json(directory);
    if(String(url).includes('/operations/'))return Response.json(receipt);
    if(lost){lost=false;throw new TypeError('Lost acknowledgement');}
    return Response.json(receipt);
  });
  transport.restore('saved-token');
  await assert.rejects(transport.registerCryptoDevice(registration));
  assert.deepEqual(await transport.registerCryptoDevice(registration),receipt);
  assert.equal(requests[0].options?.body,requests[1].options?.body);
  assert.deepEqual(JSON.parse(requests[0].options?.body as string),registration);
  assert.equal((await transport.cryptoDirectory('fixture-user','9007199254740993')).devices[0].revision,'9007199254740993');
  assert.deepEqual(await transport.cryptoOperation(receipt.operation_id),receipt);
  assert.equal(new URL(requests[2].url).searchParams.get('after'),'9007199254740993');
  for(const request of requests){
    assert.equal(request.options?.redirect,'error');
    assert.equal(new Headers(request.options?.headers).get('authorization'),'Bearer saved-token');
  }
  assert.throws(()=>decodeNative('RegisterDevice',{...registration,private_key:'secret'}));
  assert.throws(()=>decodeNative('Directory',{...directory,devices:[{...directory.devices[0],revision:9007199254740992}]}));
});

test('crypto throttling leaves receipt reads available and identity conflicts keep the HTTP session',async()=>{
  let calls=0;let identityConflict=false;let revoked=false;
  const transport=new NativeTransport('https://example.org',async(url)=>{
    calls++;
    if(String(url).includes('/operations/'))return Response.json(receipt);
    if(identityConflict)return Response.json({code:'crypto_identity_changed',request_id:'conflict'},{status:409});
    return Response.json({code:'crypto_busy',request_id:'busy'},{status:429,headers:{'retry-after':'2'}});
  });
  transport.restore('saved-token');transport.surJetonRefuse=()=>{revoked=true;};
  await assert.rejects(transport.registerCryptoDevice(registration),e=>e instanceof NativeError&&e.status===429&&e.retryAfter===2);
  await assert.rejects(transport.publishKeyPackages({scope:registration.scope,operation_id:'packages',device_revision:'1',packages:['AA']}),e=>e instanceof NativeError&&e.status===429);
  assert.equal(calls,1);
  assert.deepEqual(await transport.cryptoOperation(receipt.operation_id),receipt);
  identityConflict=true;
  const second=new NativeTransport('https://example.org',async()=>Response.json({code:'crypto_identity_changed',request_id:'conflict'},{status:409}));
  second.restore('saved-token');second.surJetonRefuse=()=>{revoked=true;};
  await assert.rejects(second.registerCryptoDevice(registration),e=>e instanceof NativeError&&e.status===409);
  assert.equal(revoked,false);
});
