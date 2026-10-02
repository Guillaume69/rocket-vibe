import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import type {Session} from '../../lib/auth.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {NativeStore} from './store.ts';
import {decodeNative} from './validation.ts';
import {NativeChat} from './chat.ts';
import type {NativeTransport} from './transport.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',genre:'rocketvibe',siteUrl:null,nativeInstanceId:'fixture-instance',nativeDataEpoch:'fixture-epoch'};
const details=()=>decodeNative('RoomDetails',fixture.parity.room_details);
test('write hints persist on disk, follow actor rights and reject older room revisions',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rv-room-access-')),path=join(directory,'account.sqlite');
  let harness=nativeTestDatabase(path);let store=new NativeStore(harness.adapter,creerFileEcritures(),session);
  try {
    const original=details();original.read_only=true;original.permissions.send=true;
    await store.applySnapshot({protocol_version:1,rooms:[original.room],messages:[],cursor:'first'});
    assert.equal(await store.cacheRoomAccess(original,store.projectionToken()),true);
    assert.equal(harness.db.prepare('SELECT lecture_seule FROM salons WHERE rid=?').get(original.room.id)?.lecture_seule,0);
    harness.db.close();harness=nativeTestDatabase(path,false);store=new NativeStore(harness.adapter,creerFileEcritures(),session);
    assert.equal((await store.roomAccess(original.room.id))?.can_send,1);
    const fresh=structuredClone(original);fresh.room.revision=String(BigInt(original.room.revision)+1n);fresh.permissions.role='member';fresh.permissions.send=false;
    await store.applyBatch({protocol_version:1,changes:[{type:'room_upsert',data:fresh.room}],cursor:'changed',has_more:false});
    assert.equal((await store.roomAccess(original.room.id))?.can_send,null);
    assert.equal(await store.cacheRoomAccess(original,store.projectionToken()),false);
    assert.equal(await store.cacheRoomAccess(fresh,store.projectionToken()),true);
    assert.equal(harness.db.prepare('SELECT lecture_seule FROM salons WHERE rid=?').get(original.room.id)?.lecture_seule,1);
    const token=store.projectionToken();
    await store.applyBatch({protocol_version:1,changes:[{type:'room_removed',data:{room_id:fresh.room.id}},{type:'room_upsert',data:fresh.room}],cursor:'rejoined',has_more:false});
    assert.equal(await store.cacheRoomAccess(fresh,token),false);
    assert.equal((await store.roomAccess(fresh.room.id))?.can_send,null);
    const restored=new NativeStore(harness.adapter,creerFileEcritures(),{...session,nativeDataEpoch:'restored'});
    await restored.prepare();assert.equal(await restored.roomAccess(fresh.room.id),null);
    assert.equal(await restored.cacheRoomAccess(fresh,token),false);
  } finally {harness.db.close();rmSync(directory,{recursive:true});}
});
test('write hint and shared composer flag commit atomically',async()=>{
  const harness=nativeTestDatabase(),store=new NativeStore(harness.adapter,creerFileEcritures(),session);
  try {
    const current=details();current.permissions.send=true;
    await store.applySnapshot({protocol_version:1,rooms:[current.room],messages:[],cursor:'first'});
    harness.failWhen(sql=>sql.startsWith('UPDATE salons SET lecture_seule'));
    await assert.rejects(store.cacheRoomAccess(current,store.projectionToken()));
    assert.equal((await store.roomAccess(current.room.id))?.can_send,null);
    harness.failWhen(null);assert.equal(await store.cacheRoomAccess(current,store.projectionToken()),true);
  } finally {harness.db.close();}
});
test('concurrent composer reads coalesce and recheck a changed room version',async()=>{
  const harness=nativeTestDatabase(),store=new NativeStore(harness.adapter,creerFileEcritures(),session);
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
