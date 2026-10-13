import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {CryptoAccount,CryptoHistoryBackupBridge} from '../../modules/crypto-native/index.ts';
import {CryptoHistoryBackupAccess,type HistoryBackupStatus} from './cryptoHistoryBackup.ts';
import {CryptoIdentityAccess} from './cryptoIdentity.ts';
import {CryptoStorageAccess} from './cryptoStorage.ts';
import {NativeTransport} from './transport.ts';

// Transport and orchestration only: the Rust bridge tests check the real
// code, sealing, checkpoints and import.
const wire={instance_id:'instance',data_epoch:'epoch'};
const scope:CryptoAccount={origin:'https://example.org',instance:'instance',dataEpoch:'epoch',user:'alice',device:'desktop'};
const directory={scope:wire,identity:null,devices:[],revocations:[],next_revocation:null};
const generation='ab'.repeat(16),period='cd'.repeat(32);
const code='rvh1-'+'11'.repeat(32)+'-'+'22'.repeat(4);
const request={scope:wire,operation_id:'history-key-op',publication:'cHVibGljYXRpb24'};
const receipt={scope:wire,operation_id:'history-key-op',device_id:'desktop',incarnation:'01'.repeat(16),device_revision:'1',
  root_fingerprint:'ef'.repeat(32),generation,generation_revision:'1',package_digest:'12'.repeat(32)};
function native(pages:number,periodRecords:number) {
  const actions:string[]=[];
  let value:HistoryBackupStatus={holds_key:false,generation:null,receipt:null,pending:false,code_saved:false,cancel_requested:false};
  let uploads=0,imported=0;
  const bridge:CryptoHistoryBackupBridge={
    open:async()=>({handle:'view',phase:'ready',accountFingerprint:'ee'.repeat(32),incarnation:'01'.repeat(16)}),
    status:async()=>({phase:'ready',accountFingerprint:'ee'.repeat(32),incarnation:'01'.repeat(16)}),
    close:async()=>{},initialize:async()=>{throw Error('Unexpected initialization');},removed:async()=>{},
    identityView:async()=>{throw Error('Unused');},identityBegin:async()=>{throw Error('Unused');},identityRenew:async()=>{throw Error('Unused');},identityPreview:async()=>{throw Error('Unused');},identityApprove:async()=>{throw Error('Unused');},identityInstall:async()=>{throw Error('Unused');},identityPending:async()=>{throw Error('Unused');},identityAcknowledge:async()=>{throw Error('Unused');},
    historyBackupAction:async(_handle,own,json)=>{
      assert.deepEqual(JSON.parse(own),directory);const input=JSON.parse(json);actions.push(input.action);
      switch(input.action){
        case 'view':return JSON.stringify(value);
        case 'preview':assert.equal(input.remote.active,null);return JSON.stringify({id:'01'.repeat(16),generation_revision:null});
        case 'prepare':assert.equal(input.id,'01'.repeat(16));value={...value,pending:true};return JSON.stringify(value);
        case 'code':assert(value.pending);return JSON.stringify({code});
        case 'confirm_saved':value={...value,code_saved:true};return JSON.stringify(value);
        case 'pending':assert(value.code_saved);return JSON.stringify(request);
        case 'acknowledge':assert.deepEqual(input.receipt,receipt);value={...value,pending:false,holds_key:true,generation,receipt};return JSON.stringify(value);
        case 'join':assert.equal(input.code,code);assert.equal(input.remote.active.receipt.generation,generation);value={...value,holds_key:true,generation};return JSON.stringify(value);
        case 'upload':assert.equal(input.remote.active.receipt.generation,generation);return JSON.stringify({upload:uploads<pages?{period,input:{scope:wire,start:String(uploads),records:['cmVjb3Jk'],checkpoint:'Y2hlY2twb2ludA'}}:null});
        case 'uploaded':assert.deepEqual(input.receipt,{period,count:String(uploads+1)});uploads++;return '{"recorded":true}';
        case 'next':assert.equal(input.listed.period,period);return JSON.stringify({after:imported<periodRecords?String(imported):null});
        case 'import':assert.equal(input.page.start,String(imported));imported+=input.page.records.length;return JSON.stringify({after:imported<periodRecords?String(imported):null});
        default:throw Error(`Unexpected native action ${input.action}`);
      }
    },
  };
  const open=async(transport:NativeTransport)=>{
    const storage=await CryptoStorageAccess.open(bridge,async()=>scope,()=>true);
    const identity=new CryptoIdentityAccess(storage,bridge,transport);
    return {identity,backup:new CryptoHistoryBackupAccess(identity,bridge,transport)};
  };
  return {open,actions};
}
function server(state:{published:boolean;posts:number;bodies:string[]}):NativeTransport {
  const transport=new NativeTransport(scope.origin,async(url,options)=>{
    const {pathname:path,searchParams}=new URL(String(url));const method=options?.method??'GET';
    state.bodies.push(String(url)+String(options?.body??''));
    if(path.includes('/users/'))return Response.json(directory);
    if(path==='/api/v1/e2ee/history-backup'&&method==='GET')return Response.json({scope:wire,active:state.published?{publication:request.publication,receipt}:null});
    if(path==='/api/v1/e2ee/history-backup'&&method==='POST'){state.posts++;state.published=true;throw TypeError('Lost reply');}
    if(path.startsWith('/api/v1/e2ee/history-backup/operations/'))return state.published?Response.json(receipt):Response.json({code:'not_found',request_id:'missing'},{status:404});
    if(path==='/api/v1/e2ee/history-backup/periods')return Response.json({scope:wire,generation:searchParams.get('generation'),periods:[{period,checkpoint:'Y2hlY2twb2ludA'}],next:null});
    if(path.endsWith('/records')&&method==='PUT'){const body=JSON.parse(String(options?.body));return Response.json({period,count:String(Number(body.start)+1)});}
    if(path.endsWith('/records')){const from=Number(searchParams.get('after'));return Response.json({period,start:String(from),records:from===0?['YQ','Yg']:['Yw'],next:null});}
    throw Error(`Unexpected route ${method} ${path}`);
  });
  transport.restore('saved-token');return transport;
}

test('enabling publishes once after the code is saved, then uploads and restores page by page',async()=>{
  const state={published:false,posts:0,bodies:[] as string[]};
  const n=native(2,3);const {backup}=await n.open(server(state));
  const preview=await backup.preview();
  assert.equal((await backup.prepare(preview.id)).pending,true);
  assert.equal(await backup.code(),code);
  assert.equal(state.posts,0);
  // The publication's reply is lost; resuming finds the receipt by operation.
  await assert.rejects(backup.confirmSaved());
  assert.equal(state.posts,1);
  const done=await backup.resume();
  assert.equal(done.holds_key,true);assert.equal(done.generation,generation);assert.equal(state.posts,1);
  assert.equal(await backup.sync(),2);
  assert.equal(await backup.restore(),3);
  for(const body of state.bodies)assert(!body.includes(code));
});

test('another device joins the active generation with the code',async()=>{
  const state={published:true,posts:0,bodies:[] as string[]};
  const n=native(0,0);const {backup}=await n.open(server(state));
  await assert.rejects(backup.join('rvh1-short'));
  const joined=await backup.join(code);
  assert.equal(joined.generation,generation);
  assert.equal(await backup.sync(),0);
  assert.equal(await backup.restore(),0);
  assert.deepEqual(n.actions.filter(a=>a==='join'),['join']);
});
