import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { creerFileEcritures } from '../../db/fileEcritures.ts';
import type { Session } from '../../lib/auth.ts';
import { NativeStore } from './store.ts';
import { nativeTestDatabase } from './testDatabase.ts';
import { decodeNative } from './validation.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const message = decodeNative('Message',fixture.message);
const room = decodeNative('Room',fixture.room);
const session:Session = {baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',genre:'rocketvibe',siteUrl:null,nativeInstanceId:'fixture-instance',nativeDataEpoch:'fixture-epoch'};
const snapshot = {protocol_version:1,rooms:[room],messages:[message],cursor:'initial'};
function setup() { const harness = nativeTestDatabase(); return {...harness,store:new NativeStore(harness.adapter,creerFileEcritures(),session)}; }

test('closing and reopening an on-disk SQLite database preserves the outbox and committed cursor',async () => {
  const directory = mkdtempSync(join(tmpdir(),'rocketvibe-native-'));
  const filename = join(directory,'account.sqlite');
  const original = nativeTestDatabase(filename);
  let reopened:ReturnType<typeof nativeTestDatabase> | undefined;
  try {
    const store = new NativeStore(original.adapter,creerFileEcritures(),session);
    await store.applySnapshot(snapshot); await store.enqueue('durable-intent',room.id,'Queued offline');
    assert.equal(await store.roomCreation('Durable room',true,() => 'durable-room-intent'),'durable-room-intent');
    original.db.close();
    reopened = nativeTestDatabase(filename,false);
    const resumed = new NativeStore(reopened.adapter,creerFileEcritures(),session);
    assert.equal((await resumed.state())?.cursor,'initial');
    assert.deepEqual((await resumed.pending()).map(row => ({...row})),[{id:'durable-intent',rid:room.id,texte:'Queued offline'}]);
    assert.equal((await resumed.messages(room.id))[0].statut,'en-attente');
    assert.equal(await resumed.roomCreation('Durable room',true,() => {throw new Error('must reuse persisted intent');}),'durable-room-intent');
    await resumed.completeRoomCreation('durable-room-intent');
    assert.equal(await resumed.roomCreation('Durable room',true,() => 'explicit-next-creation'),'explicit-next-creation');
  } finally {
    reopened?.db.close();
    if (!reopened) { try { original.db.close(); } catch { /* Already closed before an open failure. */ } }
    unlinkSync(filename); rmdirSync(directory);
  }
});

test('snapshot failure rolls back the projection and cursor, and the queue can retry',async () => {
  const {db,store,failWhen} = setup();
  failWhen(sql => sql.startsWith('INSERT INTO native_sync_state'));
  await assert.rejects(store.applySnapshot(snapshot));
  assert.deepEqual(await store.rooms(),[]);
  assert.equal(await store.state(),null);
  failWhen(null); await store.applySnapshot(snapshot);
  assert.equal((await store.state())?.cursor,'initial');
  assert.equal((await store.messages(room.id))[0].texte,message.text);
  db.close();
});
test('failed batch never deletes the outbox or acknowledges an uncommitted message',async () => {
  const {db,store,failWhen} = setup(); await store.applySnapshot({...snapshot,messages:[]});
  await store.enqueue(message.id,room.id,message.text);
  failWhen(sql => sql.startsWith('INSERT INTO native_sync_state'));
  const batch = {protocol_version:1,changes:[{type:'message_upsert' as const,data:message}],cursor:'next',has_more:false};
  await assert.rejects(store.applyBatch(batch));
  assert.equal((await store.state())?.cursor,'initial');
  assert.equal((await store.pending()).length,1);
    assert.equal((await store.messages(room.id))[0].statut,'en-attente');
  failWhen(null); await store.applyBatch(batch);
  assert.equal((await store.pending()).length,0);
  assert.equal((await store.state())?.cursor,'next');
  db.close();
});
test('positions above JS precision order messages and history independently of timestamps',async () => {
  const {db,store} = setup(); await store.applySnapshot(snapshot);
  await store.ingest([{...message,id:'later',text:'Later position',created_at:'2026-09-29T12:00:00Z',position:'9007199254740994',revision:'9007199254740994'}]);
  assert.equal((await store.messages(room.id))[0].id,'later');
  assert.equal(await store.oldestPosition(room.id),'9007199254740993');
  assert.equal((await store.rooms())[0].dernier_message,'Later position');
  db.close();
});
test('removal and an empty authoritative snapshot purge private messages and pending sends',async () => {
  const {db,store} = setup(); await store.applySnapshot(snapshot);
  await store.enqueue('pending',room.id,'Queued before removal');
  await store.applyBatch({protocol_version:1,changes:[{type:'room_removed',data:{room_id:room.id}}],cursor:'removed',has_more:false});
  assert.deepEqual(await store.messages(room.id),[]); assert.deepEqual(await store.pending(),[]);
  await store.ingest([message]);
  assert.deepEqual(await store.messages(room.id),[]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM native_positions').get()!.n,0);
  await store.applySnapshot(snapshot);
  await store.applySnapshot({...snapshot,rooms:[],messages:[],cursor:'empty'});
  assert.deepEqual(await store.rooms(),[]); assert.deepEqual(await store.messages(room.id),[]);
  db.close();
});
test('a fresh generation drops the old generation outbox before it can be replayed',async () => {
  const {db,adapter,store} = setup(); await store.applySnapshot(snapshot);
  await store.enqueue('old-intent',room.id,'Must never cross generations');
  const newStore = new NativeStore(adapter,creerFileEcritures(),{...session,nativeDataEpoch:'new-epoch'});
  assert.deepEqual(await newStore.rooms(),[]); assert.deepEqual(await newStore.messages(room.id),[]);
  assert.deepEqual(await newStore.pending(),[]);
  await assert.rejects(newStore.enqueue('new-intent',room.id,'Cannot send to the old generation'));
  assert.equal((await store.pending()).length,1);
  await newStore.applySnapshot({...snapshot,rooms:[],messages:[],cursor:'new-generation'});
  assert.deepEqual(await newStore.pending(),[]); assert.equal((await newStore.state())?.data_epoch,'new-epoch');
  db.close();
});

test('history windows can grow beyond 500 messages without changing sequence order',async () => {
  const {db,store} = setup(); await store.applySnapshot({...snapshot,messages:[]});
  await store.ingest(Array.from({length:550},(_,i) => ({...message,id:`message-${i}`,position:String(i+1),revision:String(i+1)})));
  assert.equal((await store.messages(room.id)).length,500);
  const all = await store.messages(room.id,600);
  assert.equal(all.length,550); assert.equal(all[0].id,'message-549'); assert.equal(all[549].id,'message-0');
  db.close();
});
test('enqueue failure leaves neither an optimistic message nor a partial outbox intent',async () => {
  const {db,store,failWhen} = setup(); await store.applySnapshot({...snapshot,messages:[]});
  failWhen(sql => sql.includes('INSERT INTO sortie'));
  await assert.rejects(store.enqueue('optimistic',room.id,'Crash during enqueue'));
  assert.deepEqual(await store.messages(room.id),[]); assert.deepEqual(await store.pending(),[]);
  db.close();
});
