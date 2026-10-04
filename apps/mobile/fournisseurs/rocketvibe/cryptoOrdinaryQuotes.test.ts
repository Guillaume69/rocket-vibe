import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {NativeChat} from './chat.ts';
import {NativeStore} from './store.ts';
import {NativeError,type NativeTransport} from './transport.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import type {CryptoConversationBridge} from '../../modules/crypto-native/index.ts';
import type {Message,Room,SendMessage} from './protocol.generated.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',genre:'rocketvibe' as const,
  siteUrl:null,nativeInstanceId:fixture.discovery.instance_id as string,nativeDataEpoch:fixture.discovery.data_epoch as string};
const scope={instance_id:session.nativeInstanceId,data_epoch:session.nativeDataEpoch};
const privateRoom='fixture-room',privateWords='private words retained only in native memory',admission='ab'.repeat(32);
const selection={...scope,reference:{room_id:privateRoom,message_id:'private-source',revision:'9007199254740993'},membership_version:'private-grant',crypto_admission:admission};
function room(id:string,grant:string,encrypted=false):Room {
  return {id,name:id,kind:'private',revision:'1',encrypted,read_state:{room_id:id,revision:'1',membership_version:grant,favorite_revision:'1',root_position:'0',reply_position:'0',unread_roots:'0',unread_replies:'0',mentions:'0',group_mentions:'0',favorite:false}};
}
async function setup() {
  const h=nativeTestDatabase(),store=new NativeStore(h.adapter,creerFileEcritures(),session);
  await store.applySnapshot({protocol_version:1,rooms:[room(privateRoom,'private-grant',true),room('ordinary','ordinary-grant')],messages:[],cursor:'initial'});
  h.db.prepare('UPDATE native_room_access SET can_send=1').run();
  const state=fixture.parity.e2ee_group_state;
  const roster={scope,room_id:privateRoom,authority_version:'authority',members:[{user_id:session.userId,access_version:'access',activation_version:'active'}],group:state.receipt};
  const page={scope,room_id:privateRoom,incarnation:state.receipt.incarnation,after:'0',through:'0',events:[],next:null};
  const receipts=new Map<string,Message>(),wire:SendMessage[]=[],commands:string[]=[];
  let serial=0,lose=false,visible=true,sourceAdmission=admission,retained=true;
  let onSource:()=>Promise<void>=async()=>{};
  const transport={baseUrl:session.baseUrl,
    discover:async()=>({...fixture.discovery,capabilities:{...Object.fromEntries(Object.keys(fixture.discovery.capabilities).map(k=>[k,false])),e2ee:true,device_sessions:true}}),
    me:async()=>fixture.session.user,changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
    deviceSessions:async()=>[{id:'phone',current:true}],
    cryptoDirectory:async()=>({scope,identity:null,devices:[],revocations:[],next_revocation:null}),
    cryptoGroupRoster:async()=>roster,cryptoGroupState:async()=>state,cryptoDelivery:async()=>page,
    send:async(rid:string,input:SendMessage)=>{
      assert.equal(rid,'ordinary');wire.push(structuredClone(input));assert.ok(!JSON.stringify(input).includes(privateWords));
      let receipt=receipts.get(input.operation_id);
      if(!receipt){receipt={id:input.operation_id,room_id:rid,text:input.text,author:fixture.session.user,created_at:'2026-10-05T00:00:00Z',position:'20',revision:'20',
        quotes:(input.quotes??[]).map(reference=>({reference,view_position:'20',source_membership_version:'private-grant',excerpt:null}))};receipts.set(input.operation_id,receipt);}
      if(lose){lose=false;throw new NativeError(0,'network_or_protocol_error');}return receipt;
    },
  } as unknown as NativeTransport;
  const makeChat=()=>new NativeChat(session,store,()=>`ordinary-operation-${++serial}`,{transport,socket:()=>{
    const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
    queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
  }});
  let chat=makeChat();await chat.connect();
  const bridge={
    open:async()=>({handle:'private-reader',phase:'ready',accountFingerprint:'ef'.repeat(32),incarnation:'cd'.repeat(16)}),close:async()=>{},
    peerView:async()=>({id:'ef'.repeat(16),statusJson:JSON.stringify({user:session.userId,devices:[]})}),
    conversationAction:async(_handle:string,_directory:string,input:string)=>{
      const request=JSON.parse(input),c=request.command;assert.equal(request.thread,null);commands.push(c.action);
      if(c.action==='journal_request')return JSON.stringify({after:'0',through:null});
      if(c.action==='receive'){assert.deepEqual(c.page,page);return 'null';}
      assert.equal(c.action,'sources','an ordinary quote reader must not prepare, send, edit or save a draft');
      await onSource();return JSON.stringify({room_id:privateRoom,admission:sourceAdmission,after:selection.reference.revision,messages:retained?[{
        id:'private-source',operation:'private-operation',author:session.userId,position:selection.reference.revision,observed_at:'1700000000',status:'journaled',
        document:{operation_id:'private-operation',text:privateWords,reply_to:null,quotes:[],cards:[]}}]:[]});
    },
  } as unknown as CryptoConversationBridge;
  return {h,store,bridge,wire,receipts,commands,get chat(){return chat;},get visible(){return visible;},
    hide(){visible=false;},expire(){sourceAdmission='cd'.repeat(32);},evict(){retained=false;},lose(){lose=true;},
    onSource(action:()=>Promise<void>){onSource=action;},async restart(){chat.stop();await store.state();chat=makeChat();await chat.connect();},
    async close(){chat.stop();await store.state();h.db.close();}};
}

test('ordinary native quotes use the private reader, persist references only and replay the accepted original after response loss',async()=>{
  const x=await setup();try {
    await assert.rejects(x.chat.send('ordinary','',{membership:'ordinary-grant'},[selection]),/current native source reader/);
    const reader=await x.chat.cryptoQuoteReader(x.bridge,'ordinary','ordinary-grant',()=>x.visible);
    assert.equal((await reader.project([{id:'parent',references:[selection.reference]}])).parent[0].text,privateWords);await reader.close();
    x.lose();const id=await x.chat.sendQuoted(x.bridge,'ordinary','',{membership:'ordinary-grant'},[selection],null,()=>x.visible);
    assert.equal((await x.store.pending())[0].id,id);assert.equal(x.receipts.size,1);
    const saved=JSON.stringify({messages:x.h.db.prepare('SELECT * FROM messages').all(),sources:x.h.db.prepare('SELECT * FROM native_quote_sources').all(),outbox:x.h.db.prepare('SELECT * FROM native_outbox_quotes').all()});
    assert.ok(!saved.includes(privateWords));assert.ok(!saved.includes(admission));
    x.evict();const reads=x.commands.length;await x.restart();
    assert.equal(x.commands.length,reads,'pending originals need no new source preview');
    assert.equal(x.receipts.size,1);assert.equal(x.wire.length,2);assert.deepEqual(x.wire[1],x.wire[0]);
    assert.equal((await x.store.pending()).length,0);assert.equal((await x.store.messages('ordinary')).length,1);
  } finally {await x.close();}
});

test('private reference enqueue rejects stale admission, eviction, late suspension, source withdrawal and session closure',async()=>{
  for(const scenario of ['admission','evicted','suspended','withdrawn','stopped'] as const) {
    const x=await setup();try {
      if(scenario==='admission')x.expire();if(scenario==='evicted')x.evict();
      if(scenario==='suspended')x.onSource(async()=>{x.hide();});
      if(scenario==='stopped')x.onSource(async()=>{x.chat.stop();});
      if(scenario==='withdrawn')x.onSource(async()=>{await x.store.applyBatch({protocol_version:1,changes:[{type:'room_removed',data:{room_id:privateRoom}}],cursor:'removed',has_more:false});});
      await assert.rejects(x.chat.sendQuoted(x.bridge,'ordinary','',{membership:'ordinary-grant'},[selection],null,()=>x.visible));
      assert.equal(x.wire.length,0);assert.equal((await x.store.pending()).length,0);
      assert.equal(x.h.db.prepare("SELECT count(*) AS n FROM messages WHERE rid='ordinary'").get()!.n,0);
    } finally {await x.close();}
  }
});
