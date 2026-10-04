import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import type {CryptoAccount,CryptoConversationBridge} from '../../modules/crypto-native/index.ts';
import {CryptoConversationAccess,type ConversationTransport,type CryptoConversationView} from './cryptoConversations.ts';
import {CryptoGroupAccess,type GroupTransport} from './cryptoGroups.ts';
import {CryptoIdentityAccess} from './cryptoIdentity.ts';
import {CryptoStorageAccess} from './cryptoStorage.ts';
import {NativeError} from './transport.ts';
import {decodeNative} from './validation.ts';
import {lignesPrivees} from './cryptoProjection.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const packet=decodeNative('ApplicationSubmission',fixture.parity.e2ee_application_submission);
const ack=decodeNative('ApplicationReceipt',fixture.parity.e2ee_application_receipt);
const state=decodeNative('GroupState',fixture.parity.e2ee_group_state);
const scope:CryptoAccount={origin:'https://example.org',instance:packet.scope.instance_id,dataEpoch:packet.scope.data_epoch,user:'alice',device:'phone'};
const fp='ab'.repeat(32);
async function setup(thread:string|null=null) {
  let current=scope,closed=false,readOnly=false,accepted=false,cancelling=false,cancelled=false,prepared=false,draft='';
  let posts=0,retries=0,prepares=0,cancels=0,nativeDrafts=0,scopeReads=0,admission=fp,lose=false;
  const forbidden=async()=>{throw Error('No identity, pin, group or plaintext SQL operation');};
  const roster={scope:packet.scope,room_id:ack.room_id,authority_version:'authority',members:[{user_id:scope.user,access_version:'access',activation_version:'active'}],group:state.receipt};
  const page={scope:packet.scope,room_id:ack.room_id,incarnation:state.receipt.incarnation,after:'0',through:'0',events:[],next:null};
  const row=()=>({id:packet.operation_id,operation:packet.operation_id,author:scope.user,
    document:{operation_id:packet.operation_id,text:'private text',reply_to:thread,quotes:[],cards:[]},position:null,observed_at:'1700000000',status:cancelled?'cancelled':cancelling?'cancelling':accepted?'accepted':'pending'});
  let root=thread?{id:thread,operation:'root-op',author:'bob',document:{operation_id:'root-op',text:'retained root',reply_to:null,quotes:[],cards:[]},position:'1',observed_at:'1700000000',status:'journaled'}:null;
  const bridge:CryptoConversationBridge={open:async()=>({handle:'native-conversation',phase:'ready',accountFingerprint:fp,incarnation:'cd'.repeat(16)}),
    status:forbidden,initialize:forbidden,retire:forbidden,close:async()=>{closed=true;},identityView:forbidden,identityBegin:forbidden,
    identityPreview:forbidden,identityApprove:forbidden,identityInstall:forbidden,identityPending:forbidden,identityAcknowledge:forbidden,
    peerView:async()=>({id:'ef'.repeat(16),statusJson:JSON.stringify({user:'alice',fingerprint:fp,previous_fingerprint:'',trust:'unknown',devices:[]})}),
    peerPin:forbidden,peerPreview:forbidden,peerApprove:forbidden,groupAction:forbidden,
    conversationAction:async(handle,_directory,input)=>{assert.equal(handle,'native-conversation');if(closed)throw new NativeError(0,'session_closed');
      const request=JSON.parse(input);assert.equal(request.thread,thread);assert.deepEqual(request.roster,roster);assert.deepEqual(request.state,state);
      const c=request.command;
      switch(c.action) {
        case 'journal_request':return JSON.stringify({after:'0',through:null});
        case 'receive':assert.deepEqual(c.page,page);return 'null';
        case 'view':return JSON.stringify({admission,after:thread?'2':'0',catching_up:false,has_older:false,can_send:!thread || root!==null,draft,messages:prepared?[row()]:[],root,retained_replies:thread?{[thread]:1}:{}});
        case 'draft':if(c.text===null)return JSON.stringify(draft);draft=c.text;nativeDrafts++;return 'null';
        case 'prepare':assert.equal(c.text,'private text');prepares++;prepared=true;return JSON.stringify({operation:packet.operation_id});
        case 'pending':assert.equal(c.operation,packet.operation_id);return JSON.stringify({operation:c.operation,status:cancelled?'cancelled':cancelling?'cancelling':'pending'});
        case 'retry':retries++;return JSON.stringify(packet);
        case 'acknowledge':assert.deepEqual(c.receipt,ack);return 'null';
        case 'cancel':cancelling=true;return JSON.stringify(packet);
        case 'settle':cancelled=c.settlement.kind==='cancelled';cancelling=false;return 'null';
        case 'restore':assert.equal(cancelled,true);draft='private text';return 'null';
        default:throw Error('Unexpected private command');
      }
    }};
  const identity=new CryptoIdentityAccess(await CryptoStorageAccess.open(bridge,async()=>{scopeReads++;return current;},()=>!closed),bridge,
    {cryptoDirectory:async()=>({scope:packet.scope,identity:null,devices:[],revocations:[],next_revocation:null}),cryptoOperation:forbidden,registerCryptoDevice:forbidden});
  const remote:GroupTransport & ConversationTransport={cryptoGroupRoster:async()=>roster,cryptoGroupState:async()=>state,
    cryptoGroupEvents:forbidden,cryptoGroupOperation:forbidden,submitCryptoGroup:forbidden,cancelCryptoGroup:forbidden,
    availableCryptoKeyPackage:forbidden,cryptoOperation:forbidden,publishKeyPackages:forbidden,
    cryptoDelivery:async()=>page,
    cryptoMessageOperation:async()=>{if(!accepted)throw new NativeError(404,'not_found');return ack;},
    submitCryptoMessage:async(_room,input)=>{assert.deepEqual(input,packet);posts++;accepted=true;if(lose)throw new NativeError(0,'network_or_protocol_error');return ack;},
    cancelCryptoMessage:async(_room,input)=>{assert.deepEqual(input,packet);assert.equal(cancelling,true);cancels++;
      if(lose){lose=false;throw new NativeError(0,'network_or_protocol_error');}
      return {kind:'cancelled',data:{scope:ack.scope,room_id:ack.room_id,operation_id:ack.operation_id,header:ack.header,fingerprint:ack.fingerprint}};}};
  const group=new CryptoGroupAccess(identity,bridge,remote,ack.room_id,async mutation=>{if(mutation && readOnly)throw new NativeError(403,'room_access_denied');});
  const access=new CryptoConversationAccess(group,bridge,remote,ack.room_id,thread);
  return {access,remote,get posts(){return posts;},get retries(){return retries;},get prepares(){return prepares;},get cancels(){return cancels;},get nativeDrafts(){return nativeDrafts;},get scopeReads(){return scopeReads;},
    lose:()=>{lose=true;},readOnly:()=>{readOnly=true;},switchDevice:()=>{current={...scope,device:'replacement'};},changeAdmission:()=>{admission='cd'.repeat(32);},
    wrongRoot:()=>{if(root)root={...root,id:'foreign-root'};},evictRoot:()=>{root=null;}};
}
test('private viewing does not initialize keys; lost send resumes its receipt without another POST, including read-only',async()=>{
  const f=await setup();await f.access.refresh();assert.equal(f.posts,0);assert.equal(f.prepares,0);
  f.lose();assert.equal(await f.access.send('private text'),packet.operation_id);assert.equal(f.posts,1);
  f.readOnly();await f.access.resume(packet.operation_id);assert.equal(f.posts,1);assert.equal(f.retries,1);assert.equal(f.prepares,1);
  await f.access.close();await assert.rejects(f.access.refresh(),/session_closed/);
});
test('receipt failures and device changes never authorize a new private POST',async()=>{
  const f=await setup();await f.access.refresh();f.remote.cryptoMessageOperation=async()=>{throw new NativeError(404,'different_route');};
  await assert.rejects(f.access.send('private text'));assert.equal(f.posts,0);assert.equal(f.retries,0);
  f.remote.cryptoMessageOperation=async()=>{throw new NativeError(502,'gateway_unavailable');};
  await f.access.resume(packet.operation_id).catch(()=>{});assert.equal(f.posts,0);
  f.switchDevice();await assert.rejects(f.access.resume(packet.operation_id),/crypto_scope_changed/);assert.equal(f.posts,0);
  assert.equal(f.access.isClosed,true);await assert.rejects(f.access.saveDraft('late writer'));assert.equal(f.nativeDrafts,0);await f.access.close();
});
test('abandonment checkpoints before HTTP, survives lost outcome and restores only a cancelled draft',async()=>{
  const f=await setup();f.remote.submitCryptoMessage=async()=>{throw new NativeError(0,'network_or_protocol_error');};
  await f.access.send('private text');f.lose();await assert.rejects(f.access.cancel(packet.operation_id));
  await f.access.resume(packet.operation_id);assert.equal(f.cancels,2);assert.equal(f.prepares,1);
  await f.access.restore(packet.operation_id);assert.equal(await f.access.draft(),'private text');await f.access.close();
});
test('each local keystroke uses the bound native coffer without HTTP and the writer becomes terminal on close',async()=>{
  const f=await setup();await f.access.refresh();const reads=f.scopeReads;
  await Promise.all([f.access.saveDraft('one'),f.access.saveDraft('two')]);assert.equal(f.scopeReads,reads);assert.equal(f.nativeDrafts,2);
  assert.equal(await f.access.draft(),'two');await f.access.close();await assert.rejects(f.access.saveDraft('late'));assert.equal(f.nativeDrafts,2);
});
test('a new admission cannot reuse a retained private viewer',async()=>{
  const f=await setup();await f.access.refresh();f.changeAdmission();await assert.rejects(f.access.refresh(),/crypto_scope_changed/);
  await assert.rejects(f.access.saveDraft('old view'));assert.equal(f.nativeDrafts,0);
});
test('render-only rows retain exact journal ordering above JS safe integers and clear immediately',()=>{
  const base={operation:'op',author:'alice',document:{operation_id:'op',text:'private',reply_to:null,quotes:[],cards:[]},observed_at:'1700000000',status:'journaled' as const};
  const view:CryptoConversationView={admission:fp,after:'9007199254740993',catching_up:false,has_older:false,can_send:true,draft:'',root:null,retained_replies:{newer:2},messages:[
    {...base,id:'older',position:'9007199254740992'}, {...base,id:'newer',position:'9007199254740993'}]};
  const rows=lignesPrivees(view,'room');assert.deepEqual(rows.map(v=>v.id),['newer','older']);assert.equal(rows[0].texte,'private');assert.equal(rows[0].filReponses,2);
  assert.deepEqual(lignesPrivees(null,'room'),[]);
});

test('private thread routing keeps the root separate, drafts local and rejects a root from another thread',async()=>{
  const f=await setup('retained-root');const first=await f.access.refresh();
  assert.equal(first.root?.id,'retained-root');assert.equal(first.can_send,true);assert.equal(f.posts,0);
  await f.access.saveDraft('thread-only');assert.equal(await f.access.draft(),'thread-only');
  await f.access.send('private text');const view=await f.access.refresh();
  assert.equal(view.messages[0].document.reply_to,'retained-root');
  assert.deepEqual(lignesPrivees(view,'room',true).map(v=>v.id),['retained-root',packet.operation_id]);
  f.wrongRoot();await assert.rejects(f.access.refresh(),/crypto_integrity_failed/);await f.access.close();
});
test('evicting a private root keeps available replies readable and disables new sends',async()=>{
  const f=await setup('retained-root');await f.access.send('private text');f.evictRoot();
  const view=await f.access.refresh();assert.equal(view.can_send,false);assert.equal(view.root,null);
  assert.equal(lignesPrivees(view,'room',true)[0].filId,'retained-root');await f.access.close();
});
