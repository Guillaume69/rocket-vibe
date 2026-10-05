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
import {privateRows} from './cryptoProjection.ts';
import {privateQuoteCards,type PrivateQuoteRoom} from './cryptoQuotes.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const packet=decodeNative('ApplicationSubmission',fixture.parity.e2ee_application_submission);
const ack=decodeNative('ApplicationReceipt',fixture.parity.e2ee_application_receipt);
const state=decodeNative('GroupState',fixture.parity.e2ee_group_state);
const scope:CryptoAccount={origin:'https://example.org',instance:packet.scope.instance_id,dataEpoch:packet.scope.data_epoch,user:'alice',device:'phone'};
const fp='ab'.repeat(32);
async function setup(thread:string|null=null,mixed=false) {
  let current=scope,closed=false,readOnly=false,accepted=false,cancelling=false,cancelled=false,prepared=false,draft='';
  let posts=0,retries=0,prepares=0,cancels=0,nativeDrafts=0,scopeReads=0,admission=fp,lose=false;
  let membership:string|null='member';
  let sourceRetained=true,preparedText='private text';
  let publicMembership:string|null='plain-grant',publicText='ordinary source words';
  let publicRevision='10',publicReads=0,changePublicAt=Infinity;
  let selectedQuotes: import('./protocol.generated.ts').QuoteReference[]=[];
  let amended:Record<string,unknown>|null=null,amends=0,searched:unknown=null;
  const reactions:{emoji:string;present:boolean}[]=[];
  const source={id:'private-source',operation:'source-op',author:scope.user,
    document:{operation_id:'source-op',text:'private quoted reply',reply_to:'source-root',quotes:mixed?[{room_id:'plain-room',message_id:'plain-source',revision:'10'}]:[],cards:[]},position:'9007199254740993',observed_at:'1700000000',status:'journaled'};
  const forbidden=async()=>{throw Error('No identity, pin, group or plaintext SQL operation');};
  const roster={scope:packet.scope,room_id:ack.room_id,authority_version:'authority',members:[{user_id:scope.user,access_version:'access',activation_version:'active'}],group:state.receipt};
  const page={scope:packet.scope,room_id:ack.room_id,incarnation:state.receipt.incarnation,after:'0',through:'0',events:[],next:null};
  const row=()=>({id:packet.operation_id,operation:packet.operation_id,author:scope.user,
    document:{operation_id:packet.operation_id,text:preparedText,reply_to:thread,quotes:selectedQuotes,cards:[]},position:null,observed_at:'1700000000',status:cancelled?'cancelled':cancelling?'cancelling':accepted?'accepted':'pending'});
  let root=thread?{id:thread,operation:'root-op',author:'bob',document:{operation_id:'root-op',text:'retained root',reply_to:null,quotes:[],cards:[]},position:'1',observed_at:'1700000000',status:'journaled'}:null;
  const bridge:CryptoConversationBridge={open:async()=>({handle:'native-conversation',phase:'ready',accountFingerprint:fp,incarnation:'cd'.repeat(16)}),
    status:forbidden,initialize:forbidden,removed:forbidden,close:async()=>{closed=true;},identityView:forbidden,identityBegin:forbidden,identityRenew:forbidden,
    identityPreview:forbidden,identityApprove:forbidden,identityInstall:forbidden,identityPending:forbidden,identityAcknowledge:forbidden,
    peerView:async()=>({id:'ef'.repeat(16),statusJson:JSON.stringify({user:'alice',fingerprint:fp,previous_fingerprint:'',trust:'unknown',devices:[]})}),
    peerPin:forbidden,peerPreview:forbidden,peerApprove:forbidden,groupAction:forbidden,
    conversationAction:async(handle,_directory,input)=>{assert.equal(handle,'native-conversation');if(closed)throw new NativeError(0,'session_closed');
      const request=JSON.parse(input);assert.equal(request.thread,thread);assert.deepEqual(request.roster,roster);assert.deepEqual(request.state,state);
      const c=request.command;
      switch(c.action) {
        case 'journal_request':return JSON.stringify({after:'0',through:null});
        case 'receive':assert.deepEqual(c.page,page);return 'null';
        case 'view':return JSON.stringify({admission,after:thread?'2':'0',catching_up:false,has_older:false,can_send:!thread || root!==null,draft,messages:prepared?[row()]:amended?[amended]:[],root,retained_replies:thread?{[thread]:1}:{}});
        case 'draft':if(c.text===null)return JSON.stringify(draft);draft=c.text;nativeDrafts++;return 'null';
        case 'select_quote':assert.equal(c.message,source.id);return JSON.stringify({selection:{reference:{room_id:ack.room_id,message_id:source.id,revision:source.position},
          instance_id:scope.instance,data_epoch:scope.dataEpoch,membership_version:c.membership,crypto_admission:admission},author:source.author,text:source.document.text});
        case 'sources':return JSON.stringify({room_id:ack.room_id,admission,after:source.position,messages:sourceRetained?[source]:[]});
        case 'prepare':assert.ok(c.text==='private text' || c.text==='');preparedText=c.text;selectedQuotes=(c.quotes??[]).map((q:import('./quotes.ts').NativeQuoteSelection)=>q.reference);
          assert.deepEqual(c.public_sources,(c.quotes??[]).some((q:import('./quotes.ts').NativeQuoteSelection)=>q.reference.room_id==='plain-room')?
            [{room_id:'plain-room',membership_version:publicMembership,references:[{room_id:'plain-room',message_id:'plain-source',revision:publicRevision}]}]:[]);
          assert.ok(!JSON.stringify(c).includes(publicText));prepares++;prepared=true;return JSON.stringify({operation:packet.operation_id});
        case 'pending':assert.equal(c.operation,packet.operation_id);return JSON.stringify({operation:c.operation,status:cancelled?'cancelled':cancelling?'cancelling':'pending'});
        case 'retry':retries++;return JSON.stringify(packet);
        case 'acknowledge':assert.deepEqual(c.receipt,ack);return 'null';
        case 'cancel':cancelling=true;return JSON.stringify(packet);
        case 'settle':cancelled=c.settlement.kind==='cancelled';cancelling=false;return 'null';
        case 'restore':assert.equal(cancelled,true);draft='private text';return 'null';
        case 'react':assert.equal(c.target,source.id);reactions.push({emoji:c.emoji,present:c.present});return JSON.stringify({operation:packet.operation_id});
        case 'search':assert.equal(c.limit,50);return JSON.stringify(searched??{admission,messages:[source],truncated:false});
        case 'amend':assert.equal(c.target,source.id);assert.ok(c.text===null || c.text==='edited text');amends++;return JSON.stringify({operation:packet.operation_id});
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
  const access=new CryptoConversationAccess(group,bridge,remote,ack.room_id,thread,'member',async room=>room===ack.room_id?membership:null,
    async(room,ids)=>{if(room==='plain-room' && ++publicReads===changePublicAt)publicMembership='replacement-grant';
      return mixed && room==='plain-room' && publicMembership!==null?{membership:publicMembership,messages:ids.includes('plain-source')?[{id:'plain-source',excerpt:{author:{id:'bob',username:'bob',display_name:'Bob'},text:publicText,created_at:'2026-10-04T08:00:00Z',revision:publicRevision,membership_version:publicMembership,references:[]}}]:[]}:null;});
  const target={...source,document:{...source.document,text:'edited text',reply_to:null,quotes:[]},edited:true};
  return {access,remote,get amends(){return amends;},reactions,answer:(value:unknown)=>{searched=value;},
    showAmendment:(amendment:unknown)=>{amended={...target,amendment};},get posts(){return posts;},get retries(){return retries;},get prepares(){return prepares;},get cancels(){return cancels;},get nativeDrafts(){return nativeDrafts;},get scopeReads(){return scopeReads;},
    lose:()=>{lose=true;},readOnly:()=>{readOnly=true;},switchDevice:()=>{current={...scope,device:'replacement'};},changeAdmission:()=>{admission='cd'.repeat(32);},
    wrongRoot:()=>{if(root)root={...root,id:'foreign-root'};},evictRoot:()=>{root=null;},evictSource:()=>{sourceRetained=false;},withdrawSource:()=>{membership=null;},
    editPublic:()=>{publicText='edited ordinary words';publicRevision='11';},withdrawPublic:()=>{publicMembership=null;},
    rejoinPublic:()=>{publicMembership='replacement-grant';},changePublicDuringSend:()=>{changePublicAt=publicReads+2;}};
}

test('mixed quote-only authoring sends references without ordinary excerpts and recovers the accepted original',async()=>{
  const f=await setup(null,true);await f.access.refresh();
  const clear=await f.access.selectSourceQuote('plain-room','plain-source'),privateSource=await f.access.selectQuote('private-source');
  assert.equal(clear.selection.crypto_admission,undefined);assert.equal(clear.text,'ordinary source words');
  assert.equal((await f.access.previewQuote(clear.selection))?.author,'bob');
  f.lose();await f.access.send('',[privateSource.selection,clear.selection]);
  const view=await f.access.refresh();assert.deepEqual(view.messages[0].document.quotes,[privateSource.selection.reference,clear.selection.reference]);
  assert.equal(view.quote_cards?.[packet.operation_id][1].text,'ordinary source words');
  await f.access.resume(packet.operation_id);assert.equal(f.posts,1);assert.equal(f.prepares,1);await f.access.close();
});

test('ordinary quote authoring rejects changed revision, membership, withdrawal and a private admission downgrade before preparing',async()=>{
  for(const change of ['editPublic','rejoinPublic','withdrawPublic','changePublicDuringSend'] as const) {
    const f=await setup(null,true);const selected=await f.access.selectSourceQuote('plain-room','plain-source');f[change]();
    await assert.rejects(f.access.send('',[selected.selection]));assert.equal(f.prepares,0);assert.equal(f.posts,0);await f.access.close();
  }
  const f=await setup(null,true);const {selection}=await f.access.selectQuote('private-source');
  const {crypto_admission:_admission,...downgraded}=selection;
  assert.equal(await f.access.previewQuote(downgraded),null);await assert.rejects(f.access.send('',[downgraded]));
  assert.equal(f.prepares,0);assert.equal(f.posts,0);await f.access.close();
});

test('ordinary references cannot cross account scope, become private or duplicate an encrypted intention',async()=>{
  const f=await setup(null,true);const {selection}=await f.access.selectSourceQuote('plain-room','plain-source');
  for(const altered of [{...selection,instance_id:'foreign'}, {...selection,data_epoch:'foreign'},
    {...selection,crypto_admission:fp}, {...selection,reference:{...selection.reference,revision:'0'}}]) {
    await assert.rejects(f.access.send('',[altered]));
  }
  await assert.rejects(f.access.send('',[selection,selection]));assert.equal(f.prepares,0);assert.equal(f.posts,0);
  f.switchDevice();await assert.rejects(f.access.send('',[selection]));assert.equal(f.posts,0);await f.access.close();
});

test('an ordinary quote reader gets verified private sources without opening a draft or preparing an intention',async()=>{
  const f=await setup();const sources=await f.access.readQuoteSources(true);
  assert.equal(sources?.messages[0].document.text,'private quoted reply');assert.equal(sources?.admission,fp);
  assert.equal(f.nativeDrafts,0);assert.equal(f.prepares,0);assert.equal(f.posts,0);
  f.changeAdmission();await assert.rejects(f.access.readQuoteSources(),/crypto_scope_changed/);assert.equal(f.access.isClosed,true);
});

test('an encrypted reader resolves mixed private and ordinary source cards without persisting private descendants',async()=>{
  const f=await setup(null,true);await f.access.refresh();const selected=await f.access.selectQuote('private-source');
  await f.access.send('',[selected.selection]);
  const first=await f.access.refresh();assert.equal(first.quote_cards?.[packet.operation_id][0].attachments?.[0].text,'ordinary source words');
  f.editPublic();const edited=await f.access.refresh();assert.equal(edited.quote_cards?.[packet.operation_id][0].attachments?.[0].text,'edited ordinary words');
  f.withdrawPublic();const withdrawn=await f.access.refresh();const child=withdrawn.quote_cards?.[packet.operation_id][0].attachments?.[0];
  assert.equal(child?.native_unavailable,true);assert.equal(child?.text,'');assert.equal(child?.author_name,undefined);
  assert.equal(f.posts,1);assert.equal(f.prepares,1);
});

test('private quote-only send keeps typed references, masks evicted sources and resumes the accepted original',async()=>{
  const f=await setup();await f.access.refresh();const selected=await f.access.selectQuote('private-source');
  assert.equal(selected.selection.reference.revision,'9007199254740993');
  assert.equal((await f.access.previewQuote(selected.selection))?.text,'private quoted reply');
  f.lose();await f.access.send('',[selected.selection]);assert.equal(f.prepares,1);assert.equal(f.posts,1);
  let view=await f.access.refresh();assert.equal(view.messages[0].document.text,'');
  assert.equal(view.quote_cards?.[packet.operation_id][0].text,'private quoted reply');
  assert.ok(privateRows(view,ack.room_id)[0].attachments?.includes('private quoted reply'));
  f.evictSource();assert.equal(await f.access.previewQuote(selected.selection),null);
  view=await f.access.refresh();const card=view.quote_cards?.[packet.operation_id][0];
  assert.equal(card?.native_unavailable,true);assert.equal(card?.text,'');assert.equal(card?.author_name,undefined);
  f.readOnly();await f.access.resume(packet.operation_id);assert.equal(f.posts,1);assert.equal(f.prepares,1);await f.access.close();
});
test('private selections cannot cross scope, admission, membership, revision or duplicate references',async()=>{
  const f=await setup();const {selection}=await f.access.selectQuote('private-source');
  for(const changed of [ {...selection,instance_id:'other'}, {...selection,data_epoch:'other'}, {...selection,membership_version:'other'},
    {...selection,crypto_admission:'cd'.repeat(32)}, {...selection,reference:{...selection.reference,revision:'9007199254740992'}} ]) {
    await assert.rejects(f.access.send('',[changed]));
  }
  await assert.rejects(f.access.send('',[selection,selection]));assert.equal(f.prepares,0);assert.equal(f.posts,0);
  f.withdrawSource();assert.equal(await f.access.previewQuote(selection),null);await assert.rejects(f.access.send('',[selection]));
  assert.equal(f.prepares,0);await f.access.close();
});
test('private cards bound each source, unicode, nested depth and room-qualified cycles',()=>{
  const ref=(room_id:string,message_id:string)=>({room_id,message_id,revision:'1'});
  const root=ref('a','same'),child=ref('b','same'),hidden=ref('withdrawn','secret');
  const row=(id:string,text:string,quotes:ReturnType<typeof ref>[])=>({id,operation:id,author:'alice',position:'1',observed_at:'1',status:'journaled' as const,
    document:{operation_id:id,text,quotes,reply_to:null,cards:[]}});
  const sources=new Map<string,PrivateQuoteRoom|null>([
    ['a',{room:'a',membership:'a',admission:fp,observation:{roster:decodeNative('GroupRoster',fixture.parity.e2ee_group_roster),state},messages:[row('same','🐾'.repeat(1025),[child,hidden,root])]}],
    ['b',{room:'b',membership:'b',admission:fp,observation:{roster:decodeNative('GroupRoster',fixture.parity.e2ee_group_roster),state},messages:[row('same','visible child',[ref('b','third')]),row('third','hidden third level',[])]}],
    ['withdrawn',null],
  ]);
  const card=privateQuoteCards([root],sources)[0];assert.equal(Array.from(card.text).length,1024);
  assert.equal(card.attachments?.[0].text,'visible child');assert.equal(card.attachments?.[0].attachments,undefined);
  for(const index of [1,2]) {assert.equal(card.attachments?.[index].native_unavailable,true);assert.equal(card.attachments?.[index].author_name,undefined);}
  sources.set('a',null);assert.equal(privateQuoteCards([root],sources)[0].attachments,undefined);
});
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
  const rows=privateRows(view,'room');assert.deepEqual(rows.map(v=>v.id),['newer','older']);assert.equal(rows[0].text,'private');assert.equal(rows[0].threadCount,2);
  assert.deepEqual(privateRows(null,'room'),[]);
});

test('private thread routing keeps the root separate, drafts local and rejects a root from another thread',async()=>{
  const f=await setup('retained-root');const first=await f.access.refresh();
  assert.equal(first.root?.id,'retained-root');assert.equal(first.can_send,true);assert.equal(f.posts,0);
  await f.access.saveDraft('thread-only');assert.equal(await f.access.draft(),'thread-only');
  await f.access.send('private text');const view=await f.access.refresh();
  assert.equal(view.messages[0].document.reply_to,'retained-root');
  assert.deepEqual(privateRows(view,'room',true).map(v=>v.id),['retained-root',packet.operation_id]);
  f.wrongRoot();await assert.rejects(f.access.refresh(),/crypto_integrity_failed/);await f.access.close();
});
test('evicting a private root keeps available replies readable and disables new sends',async()=>{
  const f=await setup('retained-root');await f.access.send('private text');f.evictRoot();
  const view=await f.access.refresh();assert.equal(view.can_send,false);assert.equal(view.root,null);
  assert.equal(privateRows(view,'room',true)[0].threadId,'retained-root');await f.access.close();
});

test('an encrypted edit or deletion uses the outbox of a send and shows on its target',async()=>{
  const f=await setup();await f.access.refresh();
  await assert.rejects(()=>f.access.amend('private-source','  '));await assert.rejects(()=>f.access.amend('bad id',null));
  assert.equal(f.amends,0);
  assert.equal(await f.access.amend('private-source','edited text'),packet.operation_id);
  assert.equal(f.posts,1);assert.equal(f.retries,1);
  await f.access.amend('private-source',null);assert.equal(f.amends,2);
  f.showAmendment({operation:'amend-op',status:'pending'});
  const view=await f.access.refresh();
  assert.equal(view.messages[0].edited,true);assert.deepEqual(view.messages[0].amendment,{operation:'amend-op',status:'pending'});
  assert.notEqual(privateRows(view,ack.room_id)[0].editedAt,null);
  for(const forged of [{operation:'source-op',status:'pending'},{operation:'amend-op',status:'accepted'},{operation:'bad id',status:'pending'}]) {
    f.showAmendment(forged);await assert.rejects(()=>f.access.refresh());
  }
});

test('encrypted reactions use canonical names, show marked as mine and search stays on the device',async()=>{
  const f=await setup();await f.access.refresh();
  await f.access.react('private-source',':+1:',true);await f.access.react('private-source','thumbsup',false);
  await assert.rejects(()=>f.access.react('private-source','not-an-emoji',true));
  assert.deepEqual(f.reactions,[{emoji:'thumbsup',present:true},{emoji:'thumbsup',present:false}]);
  f.showAmendment(null);
  const reacted={...(await f.access.refresh()).messages[0],reactions:[{emoji:'thumbsup',users:[scope.user,'bob']}]};
  const rows=privateRows({...(await f.access.refresh()),messages:[reacted]},ack.room_id,false,{id:scope.user,username:'alice-name'});
  assert.deepEqual(JSON.parse(rows[0].reactions!),{':thumbsup:':{usernames:['alice-name','bob']}});
  const found=await f.access.search('quoted');
  assert.deepEqual(found.messages.map(m=>m.id),['private-source']);assert.equal(found.truncated,false);
  for(const bad of [{emoji:'Thumbs Up',users:['bob']},{emoji:'heart',users:[]},{emoji:'heart',users:['bob','bob']}]) {
    f.answer({admission:fp,messages:[{...reacted,reactions:[bad]}],truncated:false});
    await assert.rejects(()=>f.access.search('quoted'));
  }
  await assert.rejects(()=>f.access.search('  '));
});
