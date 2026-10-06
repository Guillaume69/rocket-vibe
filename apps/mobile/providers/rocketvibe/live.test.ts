import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {NativeLive} from './live.ts';
import {decodeNative} from './validation.ts';
import {NativeChat} from './chat.ts';
import {NativeStore} from './store.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {createWriteQueue} from '../../db/writeQueue.ts';
import type {LiveState} from './protocol.generated.ts';
import type {NativeTransport} from './transport.ts';
import type {DdpEvent} from '../../lib/ddp.ts';
import {PresenceEngine} from '../../lib/presence.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const peer={id:'bob',username:'bob',display_name:'Bob'};
const photo:LiveState={ttl_ms:8000,limited:false,presence:[{user:peer,status:'online'}],rooms:[{room_id:fixture.room.id,membership_version:'grant',direct_peer:peer,typing:[{user:peer}]}]};

test('native live frames expire without a stop event and identical photos only renew the lease',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const live=new NativeLive(),events:DdpEvent[]=[];let updates=0,losses=0;
  live.onEvent(e=>events.push(e));live.subscribe(()=>updates++);live.onLoss(()=>losses++);
  live.apply(photo);assert.equal(updates,1);
  t.mock.timers.tick(5000);live.apply(photo);assert.equal(updates,1);
  t.mock.timers.tick(7999);assert.equal(live.state?.presence[0].status,'online');
  t.mock.timers.tick(1);assert.equal(live.state,null);assert.equal(losses,1);
  assert.deepEqual(events.at(-1)?.args,['bob',[]]);
  live.apply(photo);live.apply({...photo,limited:true});assert.equal(live.state,null);
  live.apply({...photo,ttl_ms:8001});assert.equal(live.state,null);
  live.apply(photo,8000);assert.equal(live.state,null);
});

test('room and thread activity remain separate and native presence forgets an expired photo',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const live=new NativeLive(),events:DdpEvent[]=[],presence=new PresenceEngine();
  live.subscribe(()=>presence.replace(live.state?.presence??null));live.onEvent(e=>events.push(e));
  live.apply({...photo,rooms:[{...photo.rooms[0],typing:[{user:peer,root_id:'root'}]}]});
  assert.equal(events[0].eventKey,`${fixture.room.id}/thread/root/user-activity`);
  assert.equal(presence.statusOf(peer.id),'online');
  live.apply({...photo,presence:[]});assert.equal(presence.statusOf(peer.id),'offline');
  assert.deepEqual(events.at(-2)?.args,['bob',[]]);
  live.clear();assert.equal(presence.statusOf(peer.id),null);
  assert.equal(decodeNative('LiveFrame',fixture.live_frame).data.ttl_ms,8000);
  assert.throws(()=>decodeNative('SetPresence',{status:'unknown'}));
  assert.throws(()=>decodeNative('LiveFrame',{type:'live',data:{...photo,ttl_ms:'8000'}}));
});

test('actual native runner never persists live frames, fences old grants and serializes typing stop',async()=>{
  const session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:fixture.session.user.id,username:'alice',kind:'rocketvibe' as const,siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,createWriteQueue(),session);
  const room={...fixture.room,read_state:{...fixture.parity.read_state,membership_version:'grant',room_id:fixture.room.id}};
  await store.applySnapshot({protocol_version:1,rooms:[room],messages:[],cursor:'initial'});
  const calls:{active:boolean;membership_version:string}[]=[],presence:string[]=[];
  let release:()=>void=()=>{},started:()=>void=()=>{};
  const activeStarted=new Promise<void>(resolve=>{started=resolve;});
  const transport={discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,typing:true,presence:true}}),me:async()=>fixture.session.user,
    changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async(_cursor:string,live:boolean)=>{assert(live);return 'ws://localhost/fake';},
    setPresence:async(status:string)=>{presence.push(status);},setTyping:async(_room:string,input:{active:boolean;membership_version:string})=>{
      calls.push(input);if(input.active){started();await new Promise<void>(resolve=>{release=resolve;});}
    }} as unknown as NativeTransport;
  let socket:WebSocket;
  const chat=new NativeChat(session,store,()=>{throw new Error('No durable send');},{transport,socket:()=>{
    socket={readyState:1,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
    queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
  }});
  try{
    await chat.connect();
    socket!.onmessage?.(new MessageEvent('message',{data:JSON.stringify({type:'live',data:photo})}));
    for(let i=0;i<20 && !chat.live.state;i++)await new Promise(r=>setImmediate(r));
    assert.equal(chat.live.state?.presence[0].status,'online');
    assert.equal((await store.state())?.cursor,'initial');assert.equal((await store.messages(room.id,100)).length,0);
    const active=chat.setTyping(room.id,true,undefined,'grant');await activeStarted;
    await chat.setTyping(room.id,true,undefined,'grant');await chat.setTyping(room.id,false,undefined,'grant');
    release();await active;assert.deepEqual(calls.map(c=>c.active),[true,false]);
    await chat.setTyping(room.id,true,undefined,'old-grant');assert.equal(calls.length,2);
    socket!.onmessage?.(new MessageEvent('message',{data:JSON.stringify({type:'live',data:{...photo,rooms:[{...photo.rooms[0],membership_version:'old-grant'}]}})}));
    for(let i=0;i<20 && chat.live.state;i++)await new Promise(r=>setImmediate(r));
    assert.equal(chat.live.state,null);
    chat.live.apply(photo);chat.suspend();assert.equal(chat.live.state,null);
    for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
    assert.deepEqual(presence,['online','offline']);
  } finally{release();chat.stop();await new Promise(r=>setImmediate(r));db.close();}
});
