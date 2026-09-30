/** Executed by a SQLx integration test against its disposable database. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { NativeTransport } from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import { decodeNative } from '../apps/mobile/fournisseurs/rocketvibe/validation.ts';
import type { SyncBatch } from '../apps/mobile/fournisseurs/rocketvibe/protocol.generated.ts';

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
