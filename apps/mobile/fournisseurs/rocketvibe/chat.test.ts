import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import type { Session } from '../../lib/auth.ts';
import { creerFileEcritures } from '../../db/fileEcritures.ts';
import { NativeChat } from './chat.ts';
import { NativeStore } from './store.ts';
import { nativeTestDatabase } from './testDatabase.ts';
import type { NativeTransport } from './transport.ts';

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
