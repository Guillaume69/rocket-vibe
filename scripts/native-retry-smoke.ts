/** Lost HTTP acknowledgement, real PostgreSQL / WebSocket / mobile SQLite. */
import assert from 'node:assert/strict';
import { NativeTransport } from '../apps/mobile/providers/rocketvibe/transport.ts';
import { NativeChat } from '../apps/mobile/providers/rocketvibe/chat.ts';
import { NativeStore } from '../apps/mobile/providers/rocketvibe/store.ts';
import { nativeTestDatabase } from '../apps/mobile/providers/rocketvibe/testDatabase.ts';
import { createWriteQueue } from '../apps/mobile/db/writeQueue.ts';
import type { Session } from '../apps/mobile/lib/auth.ts';

const base = process.env.RV_SMOKE_URL;
if (!base) throw new Error('RV_SMOKE_URL is required');
const loginClient = new NativeTransport(base);
const discovery = await loginClient.discover();
const login = await loginClient.login('alice',process.env.RV_SMOKE_PASSWORD ?? 'test-password-2026');
const room = await loginClient.createRoom({name:'Acknowledgement retry',private:true,operation_id:'retry-room'});
const session: Session = {kind:'rocketvibe',baseUrl:base,siteUrl:null,authToken:login.token,userId:login.user.id,username:login.user.username,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
const db = nativeTestDatabase();
const store = new NativeStore(db.adapter,createWriteQueue(),session);
const attempts: {id:string;at:number}[] = [];
let socket: WebSocket | undefined;
let paused = true;
const delayed: MessageEvent[] = [];
let deliver: ((event:MessageEvent) => void) | null = null;
const transport = new NativeTransport(base,async (url,options) => {
  const sending = options?.method==='POST' && String(url).endsWith(`/rooms/${room.id}/messages`);
  if (sending) attempts.push({id:JSON.parse(String(options?.body)).operation_id,at:Date.now()});
  const response = await fetch(url,options);
  if (sending && attempts.length===1) {
    assert.equal(response.status,200);
    await response.json(); // Accepted by PostgreSQL; the caller loses the acknowledgement.
    return Response.json({code:'lost_acknowledgement',request_id:'test-lost-ack'},{status:503});
  }
  return response;
});
transport.restore(login.token);
const chat = new NativeChat(session,store,() => 'retry-message',{
  transport,
  socket:url => {
    socket = new WebSocket(url);
    // Delay incoming journal delivery only. Authentication and the connection
    // remain real; no cursor is advanced until these exact frames are replayed.
    socket.onmessage = event => { if (paused) delayed.push(event); else deliver?.(event); };
    return new Proxy(socket,{
      get(target,key) { if (key==='onmessage') return deliver; const value=Reflect.get(target,key,target); return typeof value==='function'?value.bind(target):value; },
      set(target,key,value) { if (key==='onmessage') { deliver=value; return true; } return Reflect.set(target,key,value,target); },
    });
  },
});
try {
  await chat.connect();
  assert.ok(chat.status.online);
  await chat.send(room.id,'Accepted once despite the lost response');
  assert.equal((await store.pending()).length,1);
  const deadline=Date.now()+10_000;
  while ((attempts.length<2 || (await store.pending()).length!==0) && Date.now()<deadline) await new Promise(resolve => setTimeout(resolve,20));
  assert.equal(attempts.length,2);
  assert.deepEqual(attempts.map(a => a.id),['retry-message','retry-message']);
  assert.ok(attempts[1].at-attempts[0].at>=490);
  assert.equal(socket?.readyState,WebSocket.OPEN);
  assert.ok(chat.status.online);
  assert.equal((await store.pending()).length,0);
  assert.equal((await loginClient.history(room.id)).messages.filter(m => m.id==='retry-message').length,1);
  paused=false;
  for (const frame of delayed) deliver?.(frame);
  const target=delayed.length?JSON.parse(String(delayed.at(-1)!.data)).cursor:null;
  const replayDeadline=Date.now()+5000;
  while (target && (await store.state())?.cursor!==target && Date.now()<replayDeadline) await new Promise(resolve => setTimeout(resolve,20));
  if (target) assert.equal((await store.state())?.cursor,target,'delayed journal frames must commit before closing SQLite');
  console.log('Mobile retry: accepted acknowledgement lost, same intent retried on a live authenticated socket, one PostgreSQL message');
} finally { chat.stop(); db.db.close(); }
