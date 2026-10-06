import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {CryptoAccount,CryptoIdentityBridge,CryptoIdentityStatus} from '../../modules/crypto-native/index.ts';
import type {Directory,OperationReceipt,RegisterDevice} from './protocol.generated.ts';
import {CryptoIdentityAccess} from './cryptoIdentity.ts';
import {CryptoStorageAccess} from './cryptoStorage.ts';
import {NativeTransport} from './transport.ts';

const scope:CryptoAccount={origin:'https://example.org',instance:'instance',dataEpoch:'epoch',user:'alice',device:'phone'};
const request:RegisterDevice={scope:{instance_id:'instance',data_epoch:'epoch'},operation_id:'enroll-original',
  expected_root_fingerprint:'aa'.repeat(32),expected_device_revision:null,revoke_previous:null,request:'original-public-request',grant:'original-public-grant'};
const receipt:OperationReceipt={scope:request.scope,operation_id:request.operation_id,kind:'register_device',device_id:'phone',
  incarnation:'bb'.repeat(16),device_revision:'1',root_fingerprint:'aa'.repeat(32),key_package_refs:[]};
const directory:Directory={scope:request.scope,identity:null,devices:[],revocations:[],next_revocation:null};
function fixture() {
  let enrolled=false,phase:CryptoIdentityStatus['phase']='registering',closed=0;
  const view=():CryptoIdentityStatus=>({phase,rootFingerprint:'aa'.repeat(32),remoteFingerprint:'aa'.repeat(32),
    requestFingerprint:'cc'.repeat(32),requestCode:'public-request',controlsRoot:false,certificateExpiresAt:null});
  const bridge:CryptoIdentityBridge={
    open:async()=>({handle:'native-view',phase:'ready',accountFingerprint:'dd'.repeat(32),incarnation:'bb'.repeat(16)}),
    status:async()=>({phase:'ready',accountFingerprint:'dd'.repeat(32),incarnation:'bb'.repeat(16)}),
    initialize:async()=>{throw Error('No implicit storage initialization');},removed:async()=>{},close:async()=>{closed++;},
    identityView:async()=>view(),identityBegin:async()=>{throw Error('No new identity during retry');},
    identityRenew:async()=>{throw Error('No renewal during registration retry');},
    identityPreview:async()=>{throw Error('No new consent during retry');},identityApprove:async()=>{throw Error('No new approval during retry');},
    identityInstall:async()=>{phase='registering';return view();},identityPending:async()=>JSON.stringify(request),
    identityAcknowledge:async(_handle,_dir,json)=>{assert.deepEqual(JSON.parse(json),receipt);phase='ready';return view();},
  };
  return {bridge,view,enrolled:()=>enrolled,accept:()=>{enrolled=true;},closed:()=>closed};
}
test('renewal creates a public request once and recovers an accepted original registration after response loss',async()=>{
  const f=fixture(),renewal={...request,operation_id:'renew-original',expected_device_revision:'1'};
  const renewed={...receipt,operation_id:renewal.operation_id,device_revision:'2'};
  let requests=0,posts=0,accepted=false;
  f.bridge.identityRenew=async(_handle,json,expected)=>{
    assert.deepEqual(JSON.parse(json),directory);assert.equal(expected,'aa'.repeat(32));requests++;
    return {...f.view(),phase:'renewing',certificateExpiresAt:'1800000000'};
  };
  f.bridge.identityPending=async()=>JSON.stringify(renewal);
  f.bridge.identityAcknowledge=async(_handle,_directory,json)=>{
    assert.deepEqual(JSON.parse(json),renewed);
    return {...f.view(),phase:'ready',certificateExpiresAt:'1802592000'};
  };
  const transport=new NativeTransport(scope.origin,async(url,options)=>{
    const path=new URL(String(url)).pathname;
    if(path.includes('/users/'))return Response.json(directory);
    if(path.includes('/operations/'))return accepted?Response.json(renewed):Response.json({code:'not_found',request_id:'missing'},{status:404});
    if(path.endsWith('/e2ee/devices')){
      posts++;assert.deepEqual(JSON.parse(String(options?.body)),renewal);accepted=true;
      throw TypeError('Lost renewal acknowledgement');
    }
    throw Error(path);
  });transport.restore('fixture-token');
  const first=new CryptoIdentityAccess(await CryptoStorageAccess.open(f.bridge,async()=>scope,()=>true),f.bridge,transport);
  assert.equal((await first.renew('aa'.repeat(32))).phase,'renewing');
  await assert.rejects(first.install('approved-renewal'));
  await first.close();
  const reopened=new CryptoIdentityAccess(await CryptoStorageAccess.open(f.bridge,async()=>scope,()=>true),f.bridge,transport);
  assert.equal((await reopened.resume()).phase,'ready');
  assert.equal(requests,1);assert.equal(posts,1);
  f.bridge.identityView=async()=>({...f.view(),certificateExpiresAt:'9007199254740993'});
  await assert.rejects(reopened.view());
  await reopened.close();
});

test('lost registration response reopens the original native intention and reads its receipt without another POST',async()=>{
  const f=fixture(),requests:{path:string;body:string|null}[]=[];
  const transport=new NativeTransport(scope.origin,async(url,options)=>{
    const path=new URL(String(url)).pathname;requests.push({path,body:typeof options?.body==='string'?options.body:null});
    if(path.includes('/users/'))return Response.json(directory);
    if(path.includes('/operations/'))return f.enrolled()?Response.json(receipt):Response.json({code:'not_found',request_id:'missing'},{status:404});
    if(path.endsWith('/e2ee/devices')) {f.accept();throw TypeError('Lost registration reply');}
    throw Error(path);
  });transport.restore('fixture-token');
  const storage=await CryptoStorageAccess.open(f.bridge,async()=>scope,()=>true);
  const first=new CryptoIdentityAccess(storage,f.bridge,transport);
  await assert.rejects(first.install('public-grant'));
  assert.equal((await first.view()).phase,'registering');
  await first.close();
  const reopened=new CryptoIdentityAccess(await CryptoStorageAccess.open(f.bridge,async()=>scope,()=>true),f.bridge,transport);
  assert.equal((await reopened.resume()).phase,'ready');
  const posts=requests.filter(r=>r.body!==null);assert.equal(posts.length,1);
  assert.deepEqual(JSON.parse(posts[0].body!),request);
  assert.equal(requests.filter(r=>r.path.includes('/operations/')).length,2);
  await reopened.close();assert.equal(f.closed(),2);
});
test('ambiguous receipt errors and a changed HTTP device prevent registration mutations',async()=>{
  for(const scenario of ['gateway-404','network','changed-device','hidden-view'] as const) {
    const f=fixture();let current=scope,visible=true,posts=0;
    const remote=new NativeTransport(scope.origin,async(url)=>{
      const path=new URL(String(url)).pathname;
      if(path.includes('/users/'))return Response.json(directory);
      if(path.includes('/operations/')) {
        if(scenario==='gateway-404')return new Response('not found',{status:404});
        if(scenario==='network')throw TypeError('Disconnected');
        if(scenario==='changed-device')current={...scope,device:'new-http-device'};
        if(scenario==='hidden-view')visible=false;
        return Response.json({code:'not_found',request_id:'missing'},{status:404});
      }
      posts++;return Response.json(receipt);
    });remote.restore('fixture-token');
    const access=new CryptoIdentityAccess(await CryptoStorageAccess.open(f.bridge,async()=>current,()=>visible),f.bridge,remote);
    await assert.rejects(access.resume());assert.equal(posts,0);assert.equal(f.view().phase,'registering');
    await access.close();assert.equal(f.closed(),1);
  }
});
test('directory collection keeps exact positions and rejects repeated cursors or a changed identity between pages',async()=>{
  for(const scenario of ['exact','repeated','changed-root'] as const) {
    const f=fixture(),seen:(string|undefined)[]=[];let verified:string='';
    f.bridge.identityView=async(_handle,wire)=>{verified=wire;return f.view();};
    const remote={
      cryptoDirectory:async(_user:string,after?:string)=>{
        seen.push(after);
        if(after===undefined)return {...directory,revocations:[{position:'9007199254740993',signed:'public-proof-one'}],next_revocation:'9007199254740993'};
        if(scenario==='repeated')return {...directory,revocations:[{position:'9007199254740993',signed:'public-proof-one'}],next_revocation:'9007199254740993'};
        return {...directory,identity:scenario==='changed-root'?{user_id:'alice',root:'other-public-root',fingerprint:'ee'.repeat(32),revision:'2'}:null,
          revocations:[{position:'9007199254740994',signed:'public-proof-two'}]};
      },cryptoOperation:async()=>receipt,registerCryptoDevice:async()=>{throw Error('Read must not mutate');},
    };
    const access=new CryptoIdentityAccess(await CryptoStorageAccess.open(f.bridge,async()=>scope,()=>true),f.bridge,remote);
    if(scenario==='exact'){
      await access.view();const complete:Directory=JSON.parse(verified);
      assert.deepEqual(complete.revocations.map(r=>r.position),['9007199254740993','9007199254740994']);
      assert.equal(complete.next_revocation,null);
    } else {await assert.rejects(access.view());assert.equal(verified,'');}
    assert.deepEqual(seen,[undefined,'9007199254740993']);await access.close();
  }
});
