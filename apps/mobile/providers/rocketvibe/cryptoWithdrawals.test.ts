import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {CryptoAccount,CryptoWithdrawalBridge} from '../../modules/crypto-native/index.ts';
import type {Directory,OperationReceipt,RevokeDevice} from './protocol.generated.ts';
import {CryptoIdentityAccess} from './cryptoIdentity.ts';
import {CryptoStorageAccess} from './cryptoStorage.ts';
import {CryptoWithdrawalAccess,type WithdrawalStatus} from './cryptoWithdrawals.ts';
import {NativeTransport} from './transport.ts';

const scope:CryptoAccount={origin:'https://example.org',instance:'instance',dataEpoch:'epoch',user:'alice',device:'desktop'};
const target={device:'phone',incarnation:'bb'.repeat(16),fingerprint:'cc'.repeat(32),revision:'1',expires_at:'1800000000'};
const request:RevokeDevice={scope:{instance_id:'instance',data_epoch:'epoch'},operation_id:'withdraw-'+'12'.repeat(32),
  incarnation:'aa'.repeat(16),device_revision:'9007199254740993',signed:'original-public-proof'};
const receipt:OperationReceipt={scope:request.scope,operation_id:request.operation_id,kind:'revoke_device',device_id:scope.device,
  incarnation:request.incarnation,device_revision:request.device_revision,root_fingerprint:'dd'.repeat(32),key_package_refs:[]};
const directory:Directory={scope:request.scope,identity:null,devices:[],revocations:[],next_revocation:null};
function fixture() {
  let pending=false,prepared=0;
  const actions:string[]=[];
  let status:WithdrawalStatus={controls_root:true,devices:[target],withdrawn:[],pending:null};
  const bridge:CryptoWithdrawalBridge={
    open:async()=>({handle:'view',phase:'ready',accountFingerprint:'ee'.repeat(32),incarnation:request.incarnation}),
    status:async()=>({phase:'ready',accountFingerprint:'ee'.repeat(32),incarnation:request.incarnation}),
    close:async()=>{},initialize:async()=>{throw Error('Unexpected initialization');},removed:async()=>{},
    identityView:async()=>{throw Error('Unused');},identityBegin:async()=>{throw Error('Unused');},identityRenew:async()=>{throw Error('Unused');},
    identityPreview:async()=>{throw Error('Unused');},identityApprove:async()=>{throw Error('Unused');},identityInstall:async()=>{throw Error('Unused');},
    identityPending:async()=>{throw Error('Unused');},identityAcknowledge:async()=>{throw Error('Unused');},
    withdrawalAction:async(_handle,own,json)=>{
      assert.deepEqual(JSON.parse(own),directory);const input=JSON.parse(json) as Record<string,unknown>;
      actions.push(String(input.action));
      if(input.action==='view')return JSON.stringify(status);
      if(input.action==='preview')return JSON.stringify({...target,id:'ff'.repeat(16),root_fingerprint:'dd'.repeat(32)});
      if(input.action==='prepare'){
        assert.equal(input.id,'ff'.repeat(16));assert.equal(prepared++,0);pending=true;
        status={...status,devices:[],withdrawn:[target],pending:target};return JSON.stringify(request);
      }
      if(input.action==='pending'){assert.equal(pending,true);return JSON.stringify(request);}
      assert.equal(input.action,'acknowledge');assert.deepEqual(input.receipt,receipt);pending=false;
      status={...status,pending:null};return JSON.stringify(status);
    },
  };
  const open=async(transport:NativeTransport,visible=()=>true)=>{
    const identity=new CryptoIdentityAccess(await CryptoStorageAccess.open(bridge,async()=>scope,visible),bridge,transport);
    return {identity,access:new CryptoWithdrawalAccess(identity,bridge,transport)};
  };
  return {bridge,actions,open,prepared:()=>prepared};
}
test('lost withdrawal response recovers the original native request by receipt after reopening without another POST',async()=>{
  const f=fixture();let accepted=false,posts=0;
  const transport=new NativeTransport(scope.origin,async(url,options)=>{
    const path=new URL(String(url)).pathname;
    if(path.includes('/users/'))return Response.json(directory);
    if(path.includes('/operations/'))return accepted?Response.json(receipt):Response.json({code:'not_found',request_id:'missing'},{status:404});
    if(path.endsWith('/revocations')){posts++;assert.deepEqual(JSON.parse(String(options?.body)),request);accepted=true;throw TypeError('Lost response');}
    throw Error(path);
  });transport.restore('token');
  const first=await f.open(transport);
  const preview=await first.access.preview(target);assert.equal(posts,0);
  await assert.rejects(first.access.confirm(preview.id));
  assert.equal((await first.access.view()).pending?.device,'phone');
  await first.identity.close();
  const next=await f.open(transport);
  assert.equal((await next.access.resume()).pending,null);
  assert.equal(posts,1);assert.equal(f.prepared(),1);
  await next.identity.close();
});
test('receipt errors preserve the intention and a closed account never publishes its prepared original',async()=>{
  const f=fixture();let posts=0,visible=true;
  const transport=new NativeTransport(scope.origin,async(url)=>{
    const path=new URL(String(url)).pathname;
    if(path.includes('/users/'))return Response.json(directory);
    if(path.includes('/operations/'))return Response.json({code:'temporary_failure',request_id:'retry'},{status:503});
    posts++;throw Error('Unexpected POST');
  });transport.restore('token');
  const view=await f.open(transport,()=>visible);
  await assert.rejects(view.access.confirm('ff'.repeat(16)));
  assert.equal((await view.access.view()).pending?.device,'phone');assert.equal(posts,0);
  visible=false;await assert.rejects(view.access.resume());assert.equal(posts,0);
  await view.identity.close();
});
test('substituted previews and invalid status revisions are refused before confirmation',async()=>{
  const f=fixture();
  const transport=new NativeTransport(scope.origin,async()=>Response.json(directory));transport.restore('token');
  const view=await f.open(transport);
  f.bridge.withdrawalAction=async()=>JSON.stringify({...target,id:'ff'.repeat(16),incarnation:'99'.repeat(16),root_fingerprint:'dd'.repeat(32)});
  await assert.rejects(view.access.preview(target));
  f.bridge.withdrawalAction=async()=>JSON.stringify({controls_root:true,devices:[{...target,revision:9007199254740993}],withdrawn:[],pending:null});
  await assert.rejects(view.access.view());
  assert.equal(f.prepared(),0);await view.identity.close();
});
