import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import type { Session } from '../../lib/auth.ts';
import { creerFileEcritures } from '../../db/fileEcritures.ts';
import { NativeChat } from './chat.ts';
import { NativeStore } from './store.ts';
import { nativeTestDatabase } from './testDatabase.ts';
import { NativeError, NativeTransport } from './transport.ts';

test('stopping during the WebSocket handshake cancels its timer and detaches every callback',async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session = {baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',genre:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter} = nativeTestDatabase();
  const store = new NativeStore(adapter,creerFileEcritures(),session);
  await store.applySnapshot({protocol_version:1,rooms:[],messages:[],cursor:'initial'});
  const transport = {
    discover:async () => fixture.discovery, me:async () => ({id:session.userId}),
    changes:async () => ({protocol_version:1,changes:[],cursor:'next',has_more:false}),
    socketUrl:async () => 'ws://localhost/handshake',
  } as unknown as NativeTransport;
  let closed = false;
  const socket = {readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:() => {closed = true;}} as unknown as WebSocket;
  let socketStarted:() => void = () => {};
  const started = new Promise<void>(resolve => {socketStarted = resolve;});
  const chat = new NativeChat(session,store,() => 'intent',{transport,socket:() => {socketStarted();return socket;}});
  const connecting = chat.connect();
  await started;
  chat.stop();
  let timer:ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([connecting,new Promise((_,reject) => {timer = setTimeout(() => reject(new Error('Handshake cancellation stalled')),1000);})]);
    assert.equal(closed,true);
    assert.equal(socket.onopen,null); assert.equal(socket.onclose,null);
    assert.equal(socket.onerror,null); assert.equal(socket.onmessage,null);
    assert.equal(chat.status.online,false);
  } finally { clearTimeout(timer); chat.stop(); db.close(); }
});

test('a delivery revalidation keeps the durable send pending and retries its same intention',async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session = {baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',genre:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter} = nativeTestDatabase();
  const store = new NativeStore(adapter,creerFileEcritures(),session);
  await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[],cursor:'initial'});
  const attempts: string[] = [];
  const transport = {
    discover:async () => fixture.discovery, me:async () => fixture.session.user,
    changes:async () => ({protocol_version:1,changes:[],cursor:'initial',has_more:false}),
    socketUrl:async () => 'ws://localhost/fake',
    send:async (_: string,input: {operation_id:string;text:string}) => {
      attempts.push(input.operation_id);
      if (attempts.length===1) throw new NativeError(409,'delivery_revalidate');
      return {...fixture.message,id:input.operation_id,text:input.text};
    },
  } as unknown as NativeTransport;
  const socket = {readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:() => {}} as unknown as WebSocket;
  const chat = new NativeChat(session,store,() => 'retained-intention',{transport,socket:() => {queueMicrotask(() => socket.onopen?.(new Event('open')));return socket;}});
  try {
    await chat.connect();
    assert.equal(chat.status.online,true);
    const id = await chat.send(fixture.room.id,'Retry after changed access');
    assert.equal((await store.pending()).length,1);
    const deadline = Date.now()+5000;
    while ((await store.pending()).length) {
      if (Date.now()>deadline) throw new Error('durable send was not retried automatically');
      await new Promise(resolve => setTimeout(resolve,10));
    }
    assert.deepEqual(attempts,[id,id]);
    assert.equal((await store.pending()).length,0);
  } finally { chat.stop(); db.close(); }
});

test('room creation keeps its persisted ID after a lost response and reuses existing discovery models',async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',genre:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter}=nativeTestDatabase();
  const store=new NativeStore(adapter,creerFileEcritures(),session);
  await store.applySnapshot({protocol_version:1,rooms:[],messages:[],cursor:'initial'});
  const intentions:string[]=[];
  const transport=new NativeTransport(session.baseUrl,async (url,options) => {
    const path=new URL(String(url)).pathname;
    if (path==='/.well-known/rocketvibe') return Response.json({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,idempotent_room_creation:true,room_discovery:true}});
    if (path==='/api/v1/me') return Response.json(fixture.session.user);
    if (path==='/api/v1/sync/changes') return Response.json({protocol_version:1,changes:[],cursor:'initial',has_more:false});
    if (path==='/api/v1/sync/ticket') return Response.json(fixture.socket_ticket);
    if (path==='/api/v1/rooms') {
      intentions.push(JSON.parse(String(options?.body)).operation_id);
      if (intentions.length===1) throw new Error('Response lost after commit');
      return Response.json(fixture.room);
    }
    if (path==='/api/v1/rooms/public') return Response.json(fixture.public_room_page);
    return Response.json(fixture.error,{status:404});
  });
  transport.restore(session.authToken);
  const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:() => {}} as unknown as WebSocket;
  let sequence=0;
  const chat=new NativeChat(session,store,() => `room-intent-${++sequence}`,{transport,socket:() => {queueMicrotask(() => socket.onopen?.(new Event('open')));return socket;}});
  try {
    await chat.connect();
    await assert.rejects(chat.createRoom('  Durable room  ',true),e => e instanceof NativeError && e.status===0);
    const page=await chat.publicRooms('Public');
    assert.equal(page.rooms[0].room.id,'public-room-id');
    assert.equal(await chat.createRoom('Durable room',true),fixture.room.id);
    assert.deepEqual(intentions,['room-intent-1','room-intent-1']);
    assert.equal(sequence,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM native_room_creations').get()?.n,0);
  } finally { chat.stop(); db.close(); }
});

test('an online outbox retries transient failures, honors Retry-After and cancels when suspended',async () => {
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',genre:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter}=nativeTestDatabase();
  const store=new NativeStore(adapter,creerFileEcritures(),session);
  await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[],cursor:'initial'});
  const calls:{id:string;at:number}[]=[];
  let permanentlyBusy=false;
  const transport={
    discover:async()=>fixture.discovery,me:async()=>fixture.session.user,
    changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
    send:async(_:string,input:{operation_id:string;text:string})=>{
      calls.push({id:input.operation_id,at:Date.now()});
      if (calls.length===1) throw new NativeError(503,'service_busy');
      if (calls.length===2 || permanentlyBusy) throw new NativeError(429,'send_busy',1,'rate-limit-request');
      return {...fixture.message,id:input.operation_id,text:input.text};
    },
  } as unknown as NativeTransport;
  const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
  let sequence=0;
  const chat=new NativeChat(session,store,()=>`retry-${++sequence}`,{transport,socket:()=>{queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;}});
  try {
    await chat.connect();
    const id=await chat.send(fixture.room.id,'Resume without a socket loss');
    assert.equal(chat.status.online,true);
    assert.equal((await store.pending()).length,1);
    const deadline=Date.now()+10_000;
    while ((await store.pending()).length) { assert(Date.now()<deadline,'online outbox did not retry'); await new Promise(resolve=>setTimeout(resolve,10)); }
    assert.deepEqual(calls.map(call=>call.id),[id,id,id]);
    assert(calls[1].at-calls[0].at>=490,'exponential retry must not spin');
    assert(calls[2].at-calls[1].at>=1000,'Retry-After must not be shortened');
    permanentlyBusy=true;
    await chat.send(fixture.room.id,'Wait across suspend');
    const before=calls.length;
    chat.suspend();
    await new Promise(resolve=>setTimeout(resolve,1300));
    assert.equal(calls.length,before,'a suspended runner must cancel its pending timer');
    permanentlyBusy=false;
    await chat.connect();
    assert.equal((await store.pending()).length,0);
  } finally { chat.stop(); db.close(); }
});

test('a failed SQLite echo retries the same committed send and a rejected session stops stale callbacks',async () => {
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',genre:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter,failWhen}=nativeTestDatabase();
  const store=new NativeStore(adapter,creerFileEcritures(),session);
  await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[],cursor:'initial'});
  const calls:string[]=[];
  let revoked=false;
  const transport={
    discover:async()=>fixture.discovery,me:async()=>fixture.session.user,
    changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
    send:async(_:string,input:{operation_id:string;text:string})=>{
      calls.push(input.operation_id);
      if (revoked) throw new NativeError(401,'session_rejected',undefined,'rejected-request');
      if (calls.length===1) failWhen(sql=>sql.startsWith('INSERT INTO native_positions'));
      return {...fixture.message,id:input.operation_id,text:input.text};
    },
  } as unknown as NativeTransport;
  const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
  let sequence=0;
  const chat=new NativeChat(session,store,()=>`sqlite-retry-${++sequence}`,{transport,socket:()=>{queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;}});
  try {
    await chat.connect();
    const id=await chat.send(fixture.room.id,'Accepted remotely before local commit failure');
    assert.equal((await store.pending()).length,1);
    failWhen(null);
    const deadline=Date.now()+5000;
    while ((await store.pending()).length) { assert(Date.now()<deadline); await new Promise(resolve=>setTimeout(resolve,10)); }
    assert.deepEqual(calls,[id,id]);
    revoked=true;
    await chat.send(fixture.room.id,'Session rejected');
    assert.equal(chat.status.error,'session_rejected');
    await assert.rejects(chat.send(fixture.room.id,'Stale retained view'),e=>e instanceof NativeError && e.code==='session_closed');
    assert.equal((await store.pending()).length,1);
  } finally { chat.stop(); db.close(); }
});
