import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {CryptoAccount,CryptoGroupBridge} from '../../modules/crypto-native/index.ts';
import {CryptoIdentityAccess} from './cryptoIdentity.ts';
import {CryptoGroupAccess,type GroupTransport} from './cryptoGroups.ts';
import {CryptoStorageAccess} from './cryptoStorage.ts';
import {NativeError} from './transport.ts';
import type {Directory,GroupReceipt,GroupRoster,GroupSubmission,OperationReceipt,PublishKeyPackages} from './protocol.generated.ts';

const scope:CryptoAccount={origin:'https://example.org',instance:'instance',dataEpoch:'epoch',user:'alice',device:'phone'};
const fp='ab'.repeat(32),incarnation='cd'.repeat(16),previewId='ef'.repeat(16);
async function setup() {
  let current=scope,visible=true,pending:{operation:string;fingerprint:string;cancelling:boolean;superseded:boolean}|null=null;
  let accepted=false,loseResponse=false,readOnly=false,loseRoom=false,packagePending=false;
  let posts=0,packagePosts=0,packagePrepares=0,retries=0,cancelWrites=0;
  const nativeCalls:string[]=[];
  const forbidden=async()=>{throw Error('No identity or pin creation from groups');};
  const roster:GroupRoster={scope:{instance_id:'instance',data_epoch:'epoch'},room_id:'room',authority_version:'authority',
    members:[{user_id:'alice',access_version:'access',activation_version:'active'}],group:null};
  const ack:GroupReceipt={scope:roster.scope,room_id:'room',incarnation,operation_id:'original',revision:'9007199254740993',epoch:'1',fingerprint:fp};
  const packet:GroupSubmission={scope:roster.scope,operation_id:'original',transition:'YWJj',commit:null,tree:'YWJj',welcomes:[]};
  const publication:PublishKeyPackages={scope:roster.scope,operation_id:'packages-original',device_revision:'1',packages:['YWJj']};
  const publicationReceipt:OperationReceipt={scope:roster.scope,operation_id:publication.operation_id,kind:'publish_key_packages',device_id:'phone',
    incarnation,device_revision:'1',root_fingerprint:fp,key_package_refs:['YWJj']};
  const bridge:CryptoGroupBridge={open:async()=>({handle:'native-group',phase:'ready',accountFingerprint:fp,incarnation}),
    status:forbidden,initialize:forbidden,retire:forbidden,close:async()=>{},
    identityView:forbidden,identityBegin:forbidden,identityRenew:forbidden,identityPreview:forbidden,identityApprove:forbidden,
    identityInstall:forbidden,identityPending:forbidden,identityAcknowledge:forbidden,
    peerView:async()=>({id:previewId,statusJson:JSON.stringify({user:'alice',fingerprint:fp,previous_fingerprint:'',trust:'unknown',devices:[]})}),
    peerPin:forbidden,peerPreview:forbidden,peerApprove:forbidden,
    groupAction:async(_h,_own,input)=>{const command=JSON.parse(input) as Record<string,unknown>;nativeCalls.push(String(command.action));
      switch(command.action) {
        case 'view':return JSON.stringify({accepted:null,participants:[],pending});
        case 'preview':return JSON.stringify({id:previewId,kind:'genesis',fingerprint:fp,recipients:[]});
        case 'confirm':pending={operation:'original',fingerprint:fp,cancelling:false,superseded:false};return JSON.stringify({pending});
        case 'pending':return JSON.stringify(pending);
        case 'retry':retries++;return JSON.stringify(packet);
        case 'acknowledge':pending=null;return 'null';
        case 'cancel':assert(pending);pending.cancelling=true;cancelWrites++;return JSON.stringify({original:packet,settlement:null});
        case 'settle':pending=null;return 'null';
        case 'packages_pending':return JSON.stringify(packagePending?{operation:publication.operation_id}:null);
        case 'packages_prepare':packagePrepares++;packagePending=true;return 'null';
        case 'packages_retry':return JSON.stringify(publication);
        case 'packages_acknowledge':packagePending=false;return 'null';
        default:throw Error('Unexpected native action');
      }
    }};
  const directory:Directory={scope:roster.scope,identity:null,devices:[],revocations:[],next_revocation:null};
  const identityRemote={cryptoDirectory:async()=>directory,cryptoOperation:forbidden,registerCryptoDevice:forbidden};
  const remote:GroupTransport={cryptoGroupRoster:async()=>roster,cryptoGroupState:forbidden,cryptoGroupEvents:forbidden,
    cryptoGroupOperation:async()=>{if(!accepted)throw new NativeError(404,'not_found');return ack;},
    submitCryptoGroup:async(_room,original)=>{assert.deepEqual(original,packet);posts++;accepted=true;
      if(loseResponse)throw new NativeError(0,'network_error');return ack;},
    cancelCryptoGroup:async()=>{assert.equal(pending?.cancelling,true);return {kind:'cancelled',data:{scope:roster.scope,room_id:'room',incarnation,
      operation_id:'original',device_id:'phone',fingerprint:fp}};},availableCryptoKeyPackage:forbidden,
    cryptoOperation:async()=>{if(!packagePosts)throw new NativeError(404,'not_found');return publicationReceipt;},
    publishKeyPackages:async original=>{assert.deepEqual(original,publication);packagePosts++;if(loseResponse)throw new NativeError(0,'network_error');return publicationReceipt;}};
  const storage=await CryptoStorageAccess.open(bridge,async()=>current,()=>visible);
  const identity=new CryptoIdentityAccess(storage,bridge,identityRemote);
  const access=new CryptoGroupAccess(identity,bridge,remote,'room',async mutation=>{
    if(loseRoom){visible=false;throw new NativeError(403,'room_access_denied');}
    if(mutation && readOnly)throw new NativeError(403,'room_access_denied');
  });
  return {access,remote,nativeCalls,ack,get posts(){return posts;},get packagePosts(){return packagePosts;},get packagePrepares(){return packagePrepares;},
    get retries(){return retries;},get cancelWrites(){return cancelWrites;},
    loseResponse:()=>{loseResponse=true;},readOnly:()=>{readOnly=true;},loseRoom:()=>{loseRoom=true;},
    switchDevice:()=>{current={...scope,device:'replacement'};}};
}
test('group viewing and native preview do not create identities, pins, packages or group submissions; lost response resumes GET before POST',async()=>{
  const f=await setup();const view=await f.access.read();assert.deepEqual(f.nativeCalls,['view']);assert.equal(f.posts,0);
  const consent=await f.access.preview(view,[]);assert.equal(f.posts,0);assert.equal(f.packagePrepares,0);
  f.loseResponse();await assert.rejects(f.access.confirm(consent),/network_error/);assert.equal(f.posts,1);
  assert(f.nativeCalls.includes('confirm'));assert.equal(f.retries,1);
  await f.access.resume();assert.equal(f.posts,1);assert.equal(f.retries,1);
  assert.equal((await f.access.read()).pending,null);await f.access.close();
});
test('package publication recovers its original receipt without preparing a second batch or repeating its POST',async()=>{
  const f=await setup();f.loseResponse();await assert.rejects(f.access.publishPackages(),/network_error/);
  assert.equal(f.packagePosts,1);assert.equal(f.packagePrepares,1);
  await f.access.publishPackages();assert.equal(f.packagePosts,1);assert.equal(f.packagePrepares,1);await f.access.close();
});
test('read-only room permits resolving an accepted receipt but refuses a fresh group POST',async()=>{
  const f=await setup();const consent=await f.access.preview(await f.access.read(),[]);
  f.remote.submitCryptoGroup=async()=>{throw new NativeError(0,'network_error');};
  await assert.rejects(f.access.confirm(consent));f.readOnly();
  await assert.rejects(f.access.resume(),/room_access_denied/);assert.equal(f.posts,0);
  f.remote.cryptoGroupOperation=async()=>f.ack;await f.access.resume();await f.access.close();
});
test('cancellation is checkpointed before HTTP and device or room changes prevent late native commands',async()=>{
  const f=await setup();const consent=await f.access.preview(await f.access.read(),[]);
  f.remote.submitCryptoGroup=async()=>{throw new NativeError(0,'network_error');};await assert.rejects(f.access.confirm(consent));
  await f.access.cancel();assert.equal(f.cancelWrites,1);assert.equal((await f.access.read()).pending,null);
  const before=f.nativeCalls.length;f.switchDevice();await assert.rejects(f.access.read(),/crypto_scope_changed/);assert.equal(f.nativeCalls.length,before);
  const other=await setup();other.loseRoom();await assert.rejects(other.access.read(),/room_access_denied/);assert.equal(other.nativeCalls.length,0);await other.access.close();
});
