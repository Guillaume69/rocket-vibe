import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createWriteQueue} from '../../db/writeQueue.ts';
import {NativeChat} from './chat.ts';
import {NativeStore} from './store.ts';
import {NativeTransport} from './transport.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {decodeNative} from './validation.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));

test('search transport encodes literal text and checks the shared wire contract',async()=>{
  let called='';
  const transport=new NativeTransport('http://localhost:3400',async(input)=>{
    called=String(input);return new Response(JSON.stringify(fixture.search_page),{status:200});
  });
  transport.restore('search-test-token');
  const q='alpha & OR café?';
  const page=await transport.searchMessages('room',q,'9007199254740993');
  const url=new URL(called);assert.equal(url.pathname,'/api/v1/rooms/room/messages/search');
  assert.equal(url.searchParams.get('q'),q);assert.equal(url.searchParams.get('before'),'9007199254740993');
  assert.equal(page.membership_version,'current-grant');
  assert.equal(decodeNative('SearchMessages',fixture.search_messages).q,'hello');
  assert.throws(()=>decodeNative('SearchPage',{...fixture.search_page,has_more:'false'}));
  assert.throws(()=>decodeNative('SearchMessages',{q:'alpha',other:'room'}));
});

test('actual SQLite runner leaves results ephemeral and rejects stale grants, scope and session loss',async()=>{
  const session={baseUrl:'http://localhost:3400',authToken:'token',userId:fixture.session.user.id,username:'alice',kind:'rocketvibe' as const,siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,createWriteQueue(),session);
  const room={...fixture.room,read_state:{...fixture.parity.read_state,membership_version:'grant',room_id:fixture.room.id}};
  await store.applySnapshot({protocol_version:1,rooms:[room],messages:[],cursor:'initial'});
  let page={membership_version:'grant',messages:[fixture.message],has_more:false};
  let hold:Promise<void>|null=null,release:()=>void=()=>{};
  const transport={discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,search:true}}),me:async()=>fixture.session.user,
    changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=> 'ws://localhost/fake',
    searchMessages:async()=>{if(hold)await hold;return page;},
  } as unknown as NativeTransport;
  const chat=new NativeChat(session,store,()=>{throw new Error('Read-only search');},{transport,socket:()=>{
    const socket={readyState:1,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
    queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
  }});
  try {
    await chat.connect();
    assert.equal((await chat.searchMessages(room.id,'hello'))[0].id,fixture.message.id);
    assert.equal((await store.messages(room.id,100)).length,0);assert.equal((await store.state())?.cursor,'initial');
    page={...page,membership_version:'old'};await assert.rejects(chat.searchMessages(room.id,'hello'),/delivery_revalidate/);
    page={...page,membership_version:'grant',messages:[{...fixture.message,room_id:'other'}]};await assert.rejects(chat.searchMessages(room.id,'hello'),/invalid_search_page/);
    page={...page,messages:[{...fixture.message,deleted:true}]};await assert.rejects(chat.searchMessages(room.id,'hello'),/invalid_search_page/);
    page={...page,messages:[fixture.message,fixture.message]};await assert.rejects(chat.searchMessages(room.id,'hello'),/invalid_search_page/);
    page={...page,messages:[fixture.message]};
    const stable=chat.searchVersion;
    await store.applyBatch({protocol_version:1,cursor:'read-marker',has_more:false,changes:[{type:'room_upsert',data:room}]});
    assert.equal(chat.searchVersion,stable,'read-state refresh keeps an authorized search usable');
    await store.applyBatch({protocol_version:1,cursor:'mutation',has_more:false,changes:[{type:'message_upsert',data:{...fixture.message,revision:(BigInt(fixture.message.revision)+1n).toString(),text:'edited'}}]});
    assert.notEqual(chat.searchVersion,stable,'editing invalidates a displayed search');
    hold=new Promise(resolve=>{release=resolve;});
    const version=chat.searchVersion,pending=chat.searchMessages(room.id,'hello');
    await new Promise(resolve=>setImmediate(resolve));chat.suspend();assert.notEqual(chat.searchVersion,version);release();
    await assert.rejects(pending);hold=null;
    await assert.rejects(chat.searchMessages(room.id,'hello'));
  } finally {release();chat.stop();await new Promise(resolve=>setImmediate(resolve));db.close();}
});
