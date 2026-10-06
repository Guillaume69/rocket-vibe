/** Executed by a SQLx integration test against its disposable database. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { NativeError, NativeTransport } from '../apps/mobile/providers/rocketvibe/transport.ts';
import { createInterface } from 'node:readline';
import { decodeNative } from '../apps/mobile/providers/rocketvibe/validation.ts';
import type { SyncBatch } from '../apps/mobile/providers/rocketvibe/protocol.generated.ts';
import type { Session as AppSession } from '../apps/mobile/lib/auth.ts';
import { NativeChat } from '../apps/mobile/providers/rocketvibe/chat.ts';
import { NativeStore } from '../apps/mobile/providers/rocketvibe/store.ts';
import { nativeTestDatabase } from '../apps/mobile/providers/rocketvibe/testDatabase.ts';
import { createWriteQueue } from '../apps/mobile/db/writeQueue.ts';

const base = process.env.RV_SMOKE_URL;
const password = process.env.RV_SMOKE_PASSWORD;
if (!base || !password) throw new Error('The integration harness must provide URL and password');
const alice = new NativeTransport(base);
const bob = new NativeTransport(base);
assert.equal((await alice.discover()).product,'rocketvibe');
await alice.login('alice',password);
const session = await bob.login('bob',password);
const room = await alice.direct({user_id:session.user.id});
const snapshot = await bob.snapshot();

async function open(cursor: string) {
  const socket = new WebSocket(await bob.socketUrl(cursor));
  await new Promise<void>((resolve,reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error('socket connection timeout')); },5000);
    socket.addEventListener('open',() => { clearTimeout(timeout); resolve(); },{once:true});
    socket.addEventListener('error',() => { clearTimeout(timeout); reject(new Error('socket connection failed')); },{once:true});
  });
  return socket;
}

function next(socket: WebSocket): Promise<SyncBatch> {
  return new Promise((resolve,reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error('no durable batch received')); },5000);
    socket.addEventListener('message',event => {
      clearTimeout(timeout);
      try { resolve(decodeNative('SyncBatch',JSON.parse(String(event.data)))); } catch (e) { reject(e); }
    },{once:true});
    socket.addEventListener('error',() => { clearTimeout(timeout); reject(new Error('socket read failed')); },{once:true});
  });
}

const live = await open(snapshot.cursor);
const incoming = next(live);
const intent = { operation_id:randomBytes(12).toString('hex'),text:'Bonjour depuis le transport Android 🚀' };
const first = await alice.send(room.id,intent);
if ((await alice.discover()).capabilities.fine_permissions) {
  assert.ok((await alice.accountPermissions()).create_private_room);
  const rights=await alice.roomPermissions(room.id);
  assert.ok(rights.read && rights.send);
  assert.equal(rights.invite,false,'a direct conversation cannot be expanded by invitation');
  assert.ok((await alice.messagePermissions(first.id)).edit);
  assert.equal((await bob.messagePermissions(first.id)).edit,false);
}
assert.deepEqual(await alice.send(room.id,intent),first);
const batch = await incoming;
assert(batch.changes.some(change => change.type==='message_upsert' && change.data.id===first.id));
live.close();
const offline = { operation_id:randomBytes(12).toString('hex'),text:'Reprise après coupure' };
await alice.send(room.id,offline);
const resumed = await open(batch.cursor);
const replay = await next(resumed);
assert(replay.changes.some(change => change.type==='message_upsert' && change.data.id===offline.operation_id));
resumed.close();
assert((await bob.history(room.id)).messages.some(message => message.id===first.id));
console.log('Native TypeScript client: live exchange, idempotent replay and reconnect passed');

// The actual mobile runner, with the application's migrations and SQL on real SQLite.
const discovery = await alice.discover();
const aliceLogin = await alice.login('alice',password);
const bobLogin = await bob.login('bob',password);
function appSession(login: typeof aliceLogin): AppSession {
  return {baseUrl:base!,kind:'rocketvibe',siteUrl:null,userId:login.user.id,username:login.user.username,authToken:login.token,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 7000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Mobile SQLite integration timed out');
    await new Promise(resolve => setTimeout(resolve,20));
  }
}
const aliceDb = nativeTestDatabase(); const bobDb = nativeTestDatabase();
const aliceQueue = createWriteQueue(); const bobQueue = createWriteQueue();
const aliceStore = new NativeStore(aliceDb.adapter,aliceQueue,appSession(aliceLogin));
const bobStore = new NativeStore(bobDb.adapter,bobQueue,appSession(bobLogin));
const id = () => randomBytes(12).toString('hex');
let mobileAlice = new NativeChat(appSession(aliceLogin),aliceStore,id);
let mobileBob = new NativeChat(appSession(bobLogin),bobStore,id);
try {
  await mobileAlice.connect(); await mobileBob.connect();
  mobileAlice.suspend();
  const queuedId = await mobileAlice.send(room.id,'Queued by the actual mobile outbox');
  assert.equal((await aliceStore.pending()).length,1);
  await aliceStore.drafts().write(room.id,'Draft across expired cursor');
  if (process.env.RV_SMOKE_EXPIRE_CURSOR) {
    const oldCursor = (await aliceStore.state())!.cursor;
    const input = createInterface({input:process.stdin});
    try {
      const ready = new Promise<void>(resolve => input.once('line',() => resolve()));
      console.log('Mobile runner awaiting cursor expiry');
      await ready;
      await assert.rejects(alice.changes(oldCursor),
        (error: unknown) => error instanceof NativeError && error.code==='sync_reset_required');
    } finally { input.close(); }
  }
  mobileAlice.stop();
  mobileAlice = new NativeChat(appSession(aliceLogin),new NativeStore(aliceDb.adapter,aliceQueue,appSession(aliceLogin)),id);
  await mobileAlice.connect();
  await until(async () => (await bobStore.messages(room.id)).some(message => message.id === queuedId));
  assert.equal((await aliceStore.pending()).length,0);
  assert.equal((await bobStore.messages(room.id)).filter(message => message.id === queuedId).length,1);
  assert.equal(await aliceStore.drafts().read(room.id),'Draft across expired cursor');

  mobileBob.suspend();
  const missedId = await mobileAlice.send(room.id,'Missed while the mobile reader was offline');
  mobileBob.stop();
  mobileBob = new NativeChat(appSession(bobLogin),new NativeStore(bobDb.adapter,bobQueue,appSession(bobLogin)),id);
  await mobileBob.connect();
  assert((await bobStore.messages(room.id)).some(message => message.id === missedId));

  const privateId = await mobileAlice.createRoom('Mobile SQLite private room',true);
  await until(async () => mobileAlice.status.online && (await aliceStore.rooms()).some(room => room.rid === privateId));
  await mobileAlice.invite(privateId,'bob');
  await until(async () => (await bobStore.rooms()).some(room => room.rid === privateId));
  const privateMessage = await mobileAlice.send(privateId,'Visible only while Bob is a member');
  await until(async () => (await bobStore.messages(privateId)).some(message => message.id === privateMessage));
  mobileBob.suspend();
  await mobileBob.send(privateId,'Must be purged if membership was revoked while offline');
  const removal = await fetch(`${base}/api/v1/rooms/${privateId}/members/${bobLogin.user.id}`,{method:'DELETE',headers:{authorization:`Bearer ${aliceLogin.token}`}});
  assert.equal(removal.status,204);
  mobileBob.stop();
  mobileBob = new NativeChat(appSession(bobLogin),new NativeStore(bobDb.adapter,bobQueue,appSession(bobLogin)),id);
  await mobileBob.connect();
  assert.equal((await bobStore.messages(privateId)).length,0);
  assert.equal((await bobStore.pending()).length,0);
  assert(!(await bobStore.rooms()).some(room => room.rid === privateId));
  console.log(`Mobile runner + SQLite: live exchange, persisted outbox, ${process.env.RV_SMOKE_EXPIRE_CURSOR ? 'expired cursor reset, ' : ''}draft, restart and membership withdrawal passed`);
} finally {
  mobileAlice.stop(); mobileBob.stop();
  aliceDb.db.close(); bobDb.db.close();
}
