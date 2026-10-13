import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {createWriteQueue} from '../../db/writeQueue.ts';
import type {Session} from '../../lib/auth.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {NativeStore} from './store.ts';
import {decodeNative} from './validation.ts';
import {NativeChat} from './chat.ts';
import type {NativeTransport} from './transport.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:'fixture-instance',nativeDataEpoch:'fixture-epoch'};
const details=()=>decodeNative('RoomDetails',fixture.parity.room_details);
test('write hints persist on disk, follow actor rights and reject older room revisions',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rv-room-access-')),path=join(directory,'account.sqlite');
  let harness=nativeTestDatabase(path);let store=new NativeStore(harness.adapter,createWriteQueue(),session);
  try {
    const original=details();original.read_only=true;original.permissions.send=true;
    await store.applySnapshot({protocol_version:1,rooms:[original.room],messages:[],cursor:'first'});
    assert.equal(await store.cacheRoomAccess(original,store.projectionToken()),true);
    assert.equal(harness.db.prepare('SELECT read_only FROM rooms WHERE rid=?').get(original.room.id)?.read_only,0);
    harness.db.close();harness=nativeTestDatabase(path,false);store=new NativeStore(harness.adapter,createWriteQueue(),session);
    assert.equal((await store.roomAccess(original.room.id))?.can_send,1);
    const fresh=structuredClone(original);fresh.room.revision=String(BigInt(original.room.revision)+1n);fresh.permissions.role='member';fresh.permissions.send=false;
    await store.applyBatch({protocol_version:1,changes:[{type:'room_upsert',data:fresh.room}],cursor:'changed',has_more:false});
    assert.equal((await store.roomAccess(original.room.id))?.can_send,null);
    assert.equal(await store.cacheRoomAccess(original,store.projectionToken()),false);
    assert.equal(await store.cacheRoomAccess(fresh,store.projectionToken()),true);
    assert.equal(harness.db.prepare('SELECT read_only FROM rooms WHERE rid=?').get(original.room.id)?.read_only,1);
    const token=store.projectionToken();
    await store.applyBatch({protocol_version:1,changes:[{type:'room_removed',data:{room_id:fresh.room.id}},{type:'room_upsert',data:fresh.room}],cursor:'rejoined',has_more:false});
    assert.equal(await store.cacheRoomAccess(fresh,token),false);
    assert.equal((await store.roomAccess(fresh.room.id))?.can_send,null);
    const restored=new NativeStore(harness.adapter,createWriteQueue(),{...session,nativeDataEpoch:'restored'});
    await restored.prepare();assert.equal(await restored.roomAccess(fresh.room.id),null);
    assert.equal(await restored.cacheRoomAccess(fresh,token),false);
  } finally {harness.db.close();rmSync(directory,{recursive:true});}
});
test('write hint and shared composer flag commit atomically',async()=>{
  const harness=nativeTestDatabase(),store=new NativeStore(harness.adapter,createWriteQueue(),session);
  try {
    const current=details();current.permissions.send=true;
    await store.applySnapshot({protocol_version:1,rooms:[current.room],messages:[],cursor:'first'});
    harness.failWhen(sql=>sql.startsWith('UPDATE rooms SET read_only'));
    await assert.rejects(store.cacheRoomAccess(current,store.projectionToken()));
    assert.equal((await store.roomAccess(current.room.id))?.can_send,null);
    harness.failWhen(null);assert.equal(await store.cacheRoomAccess(current,store.projectionToken()),true);
  } finally {harness.db.close();}
});
test('concurrent composer reads coalesce and recheck a changed room version',async()=>{
  const harness=nativeTestDatabase(),store=new NativeStore(harness.adapter,createWriteQueue(),session);
  const original=details(),fresh=structuredClone(original);fresh.room.revision=String(BigInt(original.room.revision)+1n);fresh.permissions.send=false;
  let reads=0;
  const transport={discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,room_info:true}}),me:async()=>fixture.session.user,changes:async()=>({protocol_version:1,changes:[],cursor:'first',has_more:false}),socketUrl:async()=>'ws://localhost/fake',roomDetails:async()=>{
    reads++;
    if(reads===1){await store.applyBatch({protocol_version:1,changes:[{type:'room_upsert',data:fresh.room}],cursor:'changed',has_more:false});return original;}
    return fresh;
  }} as unknown as NativeTransport;
  const chat=new NativeChat(session,store,()=>{throw new Error('Rights reads have no mutation IDs');},{transport,socket:()=>{
    const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
  }});
  try{
    await store.applySnapshot({protocol_version:1,rooms:[original.room],messages:[],cursor:'first'});
    await chat.connect();
    await Promise.all([chat.refreshRoomAccess(original.room.id),chat.refreshRoomAccess(original.room.id),chat.refreshRoomAccess(original.room.id)]);
    assert.equal(reads,2);assert.equal((await store.roomAccess(original.room.id))?.can_send,0);
    await chat.refreshRoomAccess(original.room.id);assert.equal(reads,2,'Known rights avoid another HTTP read');
  }finally{chat.stop();await store.state();harness.db.close();}
});

test('encrypted room synchronization locks the existing composer and fences persisted clear sends',async()=>{
  const harness=nativeTestDatabase(),store=new NativeStore(harness.adapter,createWriteQueue(),session);
  const ordinary=details().room,encrypted={...ordinary,encrypted:true,revision:String(BigInt(ordinary.revision)+1n)};
  let sends=0,ids=0;
  const transport={discover:async()=>fixture.discovery,me:async()=>fixture.session.user,
    changes:async()=>({protocol_version:1,changes:[{type:'room_upsert',data:encrypted}],cursor:'encrypted',has_more:false}),
    socketUrl:async()=>'ws://localhost/fake',send:async()=>{sends++;throw new Error('No plaintext POST may reach the transport');},
  } as unknown as NativeTransport;
  const chat=new NativeChat(session,store,()=>String(++ids),{transport,socket:()=>{
    const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
    queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
  }});
  try {
    await store.applySnapshot({protocol_version:1,rooms:[ordinary],messages:[],cursor:'first'});
    assert.equal(await store.roomEncrypted(ordinary.id),false,'Legacy rooms default to the ordinary transport');
    await store.enqueue('offline-before-encryption',ordinary.id,'Retained offline body');
    await chat.connect();
    assert.equal(await store.roomEncrypted(ordinary.id),true);
    assert.equal(harness.db.prepare('SELECT encrypted FROM rooms WHERE rid=?').get(ordinary.id)?.encrypted,1);
    const retained=harness.db.prepare('SELECT text,last_error FROM outbox WHERE id=?').get('offline-before-encryption');
    assert.equal(retained?.text,'Retained offline body');assert.equal(retained?.last_error,'crypto_required');
    await assert.rejects(chat.send(ordinary.id,'No ordinary intention'),/crypto_required/);
    await assert.rejects(store.enqueue('bypass',ordinary.id,'No direct cache bypass'),/Encrypted room/);
    await store.applyBatch({protocol_version:1,changes:[{type:'room_upsert',data:ordinary}],cursor:'stale',has_more:false});
    assert.equal(await store.roomEncrypted(ordinary.id),true,'Older metadata cannot unlock the room');
    assert.equal(sends,0);assert.equal(ids,0);
  } finally {chat.stop();await store.state();harness.db.close();}
});
