import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import type {CryptoAccount,CryptoRecoveryBridge} from '../../modules/crypto-native/index.ts';
import {CryptoRecoveryAccess,type BackupStatus} from './cryptoRecovery.ts';
import {CryptoIdentityAccess} from './cryptoIdentity.ts';
import {CryptoStorageAccess} from './cryptoStorage.ts';
import {decodeNative} from './validation.ts';
import {NativeTransport} from './transport.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const request=decodeNative('PublishRootBackup',fixture.parity.e2ee_publish_root_backup);
const remoteState=decodeNative('RootBackupState',fixture.parity.e2ee_root_backup);
const receipt=remoteState.active!.receipt;
const cancelled=decodeNative('RootBackupSettlement',fixture.parity.e2ee_root_backup_settlement);
const scope:CryptoAccount={origin:'https://example.org',instance:request.scope.instance_id,dataEpoch:request.scope.data_epoch,user:'backup-fixture-user',device:receipt.device_id};
const directory={scope:request.scope,identity:null,devices:[],revocations:[],next_revocation:null};
const code='rvk1-'+'11'.repeat(32)+'-'+'22'.repeat(4); // Transport-only mock; Rust tests check real codes.
function native() {
  let value:BackupStatus={controls_root:true,root_fingerprint:receipt.root_fingerprint,receipt:null,pending:false,code_saved:false,cancel_requested:false};
  const actions:string[]=[];
  const bridge:CryptoRecoveryBridge={
    open:async()=>({handle:'view',phase:'ready',accountFingerprint:'ee'.repeat(32),incarnation:receipt.incarnation}),
    status:async()=>({phase:'ready',accountFingerprint:'ee'.repeat(32),incarnation:receipt.incarnation}),
    close:async()=>{},initialize:async()=>{throw Error('Unexpected initialization');},retire:async()=>{},
    identityView:async()=>{throw Error('Unused');},identityBegin:async()=>{throw Error('Unused');},identityRenew:async()=>{throw Error('Unused');},identityPreview:async()=>{throw Error('Unused');},identityApprove:async()=>{throw Error('Unused');},identityInstall:async()=>{throw Error('Unused');},identityPending:async()=>{throw Error('Unused');},identityAcknowledge:async()=>{throw Error('Unused');},
    recoveryAction:async(_handle,own,json)=>{
      assert.deepEqual(JSON.parse(own),directory);const input=JSON.parse(json);actions.push(input.action);
      switch(input.action){
        case 'view':return JSON.stringify(value);
        case 'preview_backup':return JSON.stringify({id:'ab'.repeat(16),root_fingerprint:receipt.root_fingerprint,backup_revision:receipt.backup_revision});
        case 'prepare_backup':assert.equal(input.id,'ab'.repeat(16));value={...value,pending:true};return JSON.stringify(value);
        case 'code':assert(value.pending);return JSON.stringify({code});
        case 'confirm_saved':value={...value,code_saved:true};return JSON.stringify(value);
        case 'pending':assert(value.pending&&value.code_saved&&!value.cancel_requested);return JSON.stringify(request);
        case 'request_cancel':value={...value,cancel_requested:true};return JSON.stringify(request);
        case 'pending_cancel':assert(value.cancel_requested);return JSON.stringify(request);
        case 'acknowledge':assert.deepEqual(input.receipt,receipt);value={...value,pending:false,receipt};return JSON.stringify(value);
        case 'settle_cancel':assert.deepEqual(input.result,cancelled);value={...value,pending:false,cancel_requested:false};return JSON.stringify(value);
        case 'preview_restore':assert.equal(input.code,code);assert.equal(input.fingerprint,receipt.root_fingerprint);return JSON.stringify({id:'cd'.repeat(16),root_fingerprint:receipt.root_fingerprint,backup_id:receipt.backup_id});
        case 'restore':assert.equal(input.id,'cd'.repeat(16));return '{"restored":true}';
        default:throw Error('Unexpected native action');
      }
    },
  };
  const open=async(transport:NativeTransport,visible=()=>true)=>{
    const storage=await CryptoStorageAccess.open(bridge,async()=>scope,visible);
    const identity=new CryptoIdentityAccess(storage,bridge,transport);
    return {identity,recovery:new CryptoRecoveryAccess(identity,bridge,transport)};
  };
  return {open,actions};
}
test('code stays outside HTTP and lost publication resumes the original by GET after reopening',async()=>{
  const n=native();let posts=0,accepted=false;const calls:{url:string;body:unknown}[]=[];
  const transport=new NativeTransport(scope.origin,async(url,options)=>{
    const path=new URL(String(url)).pathname;calls.push({url:String(url),body:options?.body});
    if(path.includes('/users/'))return Response.json(directory);
    if(path.includes('/operations/'))return accepted?Response.json(receipt):Response.json({code:'not_found',request_id:'missing'},{status:404});
    if(options?.method==='POST'){posts++;assert.deepEqual(JSON.parse(String(options.body)),request);accepted=true;throw TypeError('Lost reply');}
    return Response.json(remoteState);
  });transport.restore('saved-token');
  const first=await n.open(transport);const preview=await first.recovery.previewBackup();await first.recovery.prepareBackup(preview.id);
  assert.equal(posts,0);assert.equal(await first.recovery.code(),code);assert.equal(posts,0);
  await assert.rejects(first.recovery.confirmSaved());assert.equal(posts,1);first.identity.close();
  const second=await n.open(transport);assert.equal((await second.recovery.resume()).pending,false);assert.equal(posts,1);
  for(const call of calls)assert(!call.url.includes(code)&&!String(call.body).includes(code));
});
test('abandonment survives a lost reply and reopening without becoming another publication',async()=>{
  const n=native();let cancels=0,posts=0;const bodies:unknown[]=[];
  const transport=new NativeTransport(scope.origin,async(url,options)=>{
    const path=new URL(String(url)).pathname;if(path.includes('/users/'))return Response.json(directory);
    if(path.endsWith('/cancel')){cancels++;bodies.push(options?.body);if(cancels===1)throw TypeError('Lost cancellation');return Response.json(cancelled);}
    if(options?.method==='POST')posts++;
    return Response.json(remoteState);
  });transport.restore('saved-token');
  const first=await n.open(transport);const preview=await first.recovery.previewBackup();await first.recovery.prepareBackup(preview.id);
  await assert.rejects(first.recovery.cancel());first.identity.close();const second=await n.open(transport);
  assert.equal((await second.recovery.resume()).pending,false);assert.equal(posts,0);assert.equal(cancels,2);assert.equal(bodies[0],bodies[1]);
  assert(!n.actions.includes('pending'));
});
test('restore code reaches only the native engine and a closed view cannot confirm',async()=>{
  const n=native();let visible=true;const requests:string[]=[];
  const transport=new NativeTransport(scope.origin,async(url,options)=>{
    requests.push(String(url)+String(options?.body));return Response.json(String(url).includes('/users/')?directory:remoteState);
  });transport.restore('saved-token');const view=await n.open(transport,()=>visible);
  const preview=await view.recovery.previewRestore(code,receipt.root_fingerprint);assert.equal(preview.backup_id,receipt.backup_id);
  visible=false;await assert.rejects(view.recovery.restore(preview.id));assert(!n.actions.includes('restore'));
  for(const request of requests)assert(!request.includes(code));
});
