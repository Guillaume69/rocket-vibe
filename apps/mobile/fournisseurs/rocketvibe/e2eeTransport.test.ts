import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {NativeError,NativeTransport} from './transport.ts';
import {decodeNative} from './validation.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const registration=decodeNative('RegisterDevice',fixture.parity.e2ee_register_device);
const receipt=decodeNative('OperationReceipt',fixture.parity.e2ee_operation_receipt);
const directory=decodeNative('Directory',fixture.parity.e2ee_directory);

test('terminal abandonment retries the original opaque intention and retains both outcomes',async()=>{
  const input=decodeNative('ApplicationSubmission',fixture.parity.e2ee_application_submission);
  const cancelled=decodeNative('ApplicationSettlement',fixture.parity.e2ee_application_settlement);
  const accepted=decodeNative('ApplicationSettlement',{kind:'accepted',data:fixture.parity.e2ee_application_receipt});
  const requests:{url:string;options?:RequestInit}[]=[];
  const transport=new NativeTransport('https://example.org',async(url,options)=>{
    requests.push({url:String(url),options});
    if(requests.length===1)throw new TypeError('Lost terminal response');
    return Response.json(requests.length===2?cancelled:accepted);
  });
  transport.restore('saved-token');
  await assert.rejects(transport.cancelCryptoMessage('fixture-room',input));
  assert.deepEqual(await transport.cancelCryptoMessage('fixture-room',input),cancelled);
  assert.deepEqual(await transport.cancelCryptoMessage('fixture-room',input),accepted);
  assert.equal(requests[0].options?.body,requests[1].options?.body);
  assert.equal(new URL(requests[1].url).pathname,`/api/v1/e2ee/rooms/fixture-room/message-operations/${input.operation_id}/cancel`);
  assert.equal(requests[1].options?.method,'POST');
  for(const field of ['plaintext','ciphertext','position','message_id']) {
    assert.throws(()=>decodeNative('ApplicationSettlement',{kind:'cancelled',data:{...fixture.parity.e2ee_application_settlement.data,[field]:'forbidden'}}));
  }
  assert.throws(()=>decodeNative('ApplicationSettlement',{kind:'missing',data:cancelled.data}));
});

test('opaque message delivery retries original bytes and preserves the fixed large watermark',async()=>{
  const input=decodeNative('ApplicationSubmission',fixture.parity.e2ee_application_submission);
  const receipt=decodeNative('ApplicationReceipt',fixture.parity.e2ee_application_receipt);
  const page=decodeNative('DeliveryPage',fixture.parity.e2ee_delivery_page);
  const requests:{url:string;options?:RequestInit}[]=[];
  let lost=true;
  const transport=new NativeTransport('https://example.org',async(url,options)=>{
    requests.push({url:String(url),options});
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/delivery'))return Response.json(page);
    if(path.includes('/message-operations/'))return Response.json(receipt);
    if(lost){lost=false;throw new TypeError('Lost message receipt');}
    return Response.json(receipt);
  });
  transport.restore('saved-token');
  await assert.rejects(transport.submitCryptoMessage('fixture-room',input));
  assert.deepEqual(await transport.submitCryptoMessage('fixture-room',input),receipt);
  assert.equal(requests[0].options?.body,requests[1].options?.body);
  assert.deepEqual(await transport.cryptoMessageOperation('fixture-room',input.operation_id),receipt);
  assert.deepEqual(await transport.cryptoDelivery('fixture-room',page.after,page.through),page);
  const requested=new URL(requests[3].url);
  assert.equal(requested.searchParams.get('after'),'9007199254740992');
  assert.equal(requested.searchParams.get('through'),'9007199254740996');
  assert.equal(page.events[1].position,'9007199254740995');
  assert.equal(page.events[1].content.kind,'message');
  for(const value of ['01','-1','9223372036854775808','1e3']) {
    await assert.rejects(transport.cryptoDelivery('fixture-room',value));
    await assert.rejects(transport.cryptoDelivery('fixture-room','0',value));
  }
  assert.equal(requests.length,4);
  assert.throws(()=>decodeNative('DeliveryPage',{...page,through:9007199254740996}));
  assert.throws(()=>decodeNative('DeliveryPage',{...page,events:[{...page.events[1],position:9007199254740995}]}));
  assert.throws(()=>decodeNative('DeliveryPage',{...page,events:[{...page.events[1],content:{...page.events[1].content,plaintext:'forbidden'}}]}));
  assert.throws(()=>decodeNative('ApplicationSubmission',{...input,text:'forbidden'}));
  for(const request of requests) {
    assert.equal(request.options?.redirect,'error');
    assert.equal(new Headers(request.options?.headers).get('authorization'),'Bearer saved-token');
  }
});

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

test('crypto success bodies are bounded before JSON decoding and never revoke the HTTP session',async()=>{
  for(const response of [
    new Response('{}',{headers:{'content-length':'4194305'}}),
    new Response('{}',{headers:{'content-length':'invalid'}}),
    new Response('x'.repeat(4*1024*1024+1)),
  ]) {
    let revoked=false;
    const transport=new NativeTransport('https://example.org',async()=>response);
    transport.restore('saved-token');
    transport.surJetonRefuse=()=>{revoked=true;};
    await assert.rejects(transport.cryptoDelivery('fixture-room','0'),error=>error instanceof NativeError&&error.code==='invalid_crypto_delivery');
    assert.equal(revoked,false);
  }
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

test('group abandonment retries the exact original packet and decodes only terminal public metadata',async()=>{
  const input=decodeNative('GroupSubmission',fixture.parity.e2ee_group_submission);
  const decision=decodeNative('GroupSettlement',fixture.parity.e2ee_group_settlement);
  const requests:{url:string;options?:RequestInit}[]=[];
  const transport=new NativeTransport('https://example.org',async(url,options)=>{
    requests.push({url:String(url),options});
    if(requests.length===1)throw new TypeError('Lost terminal decision');
    return Response.json(decision);
  });
  transport.restore('saved-token');
  await assert.rejects(transport.cancelCryptoGroup('fixture-room',input));
  assert.deepEqual(await transport.cancelCryptoGroup('fixture-room',input),decision);
  assert.equal(requests[0].options?.body,requests[1].options?.body);
  assert.deepEqual(JSON.parse(requests[1].options?.body as string),input);
  assert.equal(new URL(requests[1].url).pathname,`/api/v1/e2ee/rooms/fixture-room/operations/${input.operation_id}/cancel`);
  assert.throws(()=>decodeNative('GroupSettlement',{kind:'cancelled',data:{...decision.data,revision:'1'}}));
  assert.throws(()=>decodeNative('GroupSettlement',{kind:'cancelled',data:{...decision.data,tree:'forbidden'}}));
  assert.throws(()=>decodeNative('GroupSettlement',{kind:'cancelled',data:{...decision.data,private_key:'forbidden'}}));
  assert.throws(()=>decodeNative('GroupSettlement',{kind:'unknown',data:decision.data}));
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
