import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { createWriteQueue } from '../../db/writeQueue.ts';
import { createOutboxStore } from '../../db/store.ts';
import { messages } from '../../db/schema.ts';
import type { Session } from '../../lib/auth.ts';
import { RestClient } from '../../lib/rest.ts';
import { createProvider } from '../index.ts';
import { messageOrder } from '../../ui/messageOrder.ts';
import { createRocketVibeProvider } from './index.ts';
import { NativeStore } from './store.ts';
import { nativeTestDatabase } from './testDatabase.ts';
import { decodeNative } from './validation.ts';
import type { NativeTransport } from './transport.ts';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { SQLInputValue } from 'node:sqlite';

const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const room = decodeNative('Room',fixture.room);
const message = decodeNative('Message',fixture.message);
const account: Session = {kind:'rocketvibe',baseUrl:'http://localhost:3400',authToken:'test-token',userId:message.author.id,username:message.author.username,
  nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch,siteUrl:null};

test('the existing provider outbox carries native references and never trusts optimistic attachments',async()=>{
  const h=nativeTestDatabase(),queue=createWriteQueue(),store=new NativeStore(h.adapter,queue,account);
  const scoped={...room,read_state:{room_id:room.id,revision:'1',membership_version:'source-grant',favorite_revision:'1',root_position:'0',reply_position:'0',unread_roots:'0',unread_replies:'0',mentions:'0',group_mentions:'0',favorite:false}};
  await store.applySnapshot({protocol_version:1,rooms:[scoped],messages:[message],cursor:'initial'});
  const provider=createRocketVibeProvider(account,new RestClient(account.baseUrl),()=> 'quoted-intent',store);
  try {
    const selected=await store.quoteSelection(room.id,message.id);
    const outbox=provider.createOutbox(createOutboxStore(h.adapter as SQLiteDatabase,queue),async()=>{});
    await outbox.send(room.id,'',null,'[{"author_name":"forged","text":"forged"}]',[selected]);
    assert.deepEqual(await store.pending(),[{id:'quoted-intent',rid:room.id,text:'',quotes:[selected.reference]}]);
    const cards=JSON.parse(h.db.prepare('SELECT attachments FROM messages WHERE id=?').get('quoted-intent')!.attachments as string);
    assert.equal(cards[0].text,message.text);
    assert.notEqual(cards[0].author_name,'forged');
    await store.ingest([{...message,revision:(BigInt(message.revision)+1n).toString(),position:(BigInt(message.position)+1n).toString(),text:'New source'}]);
    await assert.rejects(outbox.send(room.id,'Keep these words',null,null,[selected]),/selection changed/);
    assert.equal((await store.pending()).length,1);
  } finally { provider.listener.close();h.db.close(); }
});

test('one provider selector keeps Rocket.Chat features and supplies the native durable outbox',async () => {
  const h = nativeTestDatabase(); const queue = createWriteQueue();
  const store = new NativeStore(h.adapter,queue,account);
  await store.applySnapshot({protocol_version:1,rooms:[room],messages:[],cursor:'initial'});
  const client = new RestClient(account.baseUrl,{fetch:async () => { throw new Error('RC request in native flow'); }});
  const native = createProvider(account,client,() => 'same-intent',store);
  const rc = createProvider({...account,kind:'rocketchat'},client,() => 'rc-intent');
  try {
    assert.equal(rc.native,undefined); assert.equal(rc.capabilities.search,true); assert.equal(rc.capabilities.e2ee,true);
    assert.equal(native.capabilities.files,false); assert.equal(native.capabilities.threads,false);
    const outbox = native.createOutbox(createOutboxStore(h.adapter as SQLiteDatabase,queue),async () => {});
    const id = await outbox.send(room.id,'Offline through the shared composer');
    assert.equal(id,'same-intent'); assert.equal((await store.messages(room.id))[0].status,'pending');
    await store.fail(id,'membership_required');
    await outbox.retry!(id);
    assert.equal((await store.pending())[0].id,id);
    await outbox.discard(id);
    assert.deepEqual(await store.messages(room.id),[]);
    await assert.rejects(native.actions.react(room.id,id,'heart',true),/offline/);
    await assert.rejects(native.native!.chat.users(),/offline/);
  } finally { native.native!.chat.stop(); rc.listener.close(); h.db.close(); }
});

test('the shared screen query preserves exact sequence order despite reversed clocks',async () => {
  const h = nativeTestDatabase(); const store = new NativeStore(h.adapter,createWriteQueue(),account);
  try {
    const a = {...message,id:'first',position:'9007199254740993',created_at:'2030-01-01T00:00:00Z'};
    const b = {...message,id:'second',position:'9007199254740994',created_at:'2020-01-01T00:00:00Z'};
    await store.applySnapshot({protocol_version:1,rooms:[room],messages:[b,a],cursor:'snapshot'});
    const orm = drizzle(async () => ({rows:[]}));
    const nativeQuery = orm.select().from(messages).orderBy(...messageOrder('sequence')).toSQL();
    const rcQuery = orm.select().from(messages).orderBy(...messageOrder()).toSQL();
    assert.deepEqual(h.db.prepare(nativeQuery.sql).all(...nativeQuery.params as SQLInputValue[]).map(r => r.id),['second','first']);
    assert.deepEqual(h.db.prepare(rcQuery.sql).all(...rcQuery.params as SQLInputValue[]).map(r => r.id),['first','second']);
    // Prepare for a different authenticated generation clears shared tables before UI reads.
    const changed = new NativeStore(h.adapter,createWriteQueue(),{...account,nativeDataEpoch:'replacement'});
    await changed.prepare();
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM messages').get()!.n,0);
    assert.equal(await changed.state(),null);
    await assert.rejects(store.ingest([a]),/generation/);
    await assert.rejects(store.applyBatch({protocol_version:1,changes:[],cursor:'obsolete',has_more:false}),/generation/);
    await store.drafts().write(room.id,'Obsolete delayed draft');
    await changed.applySnapshot({protocol_version:1,rooms:[room],messages:[b],cursor:'replacement'});
    await changed.drafts().write(room.id,'Current draft');
    await store.drafts().write(room.id,'Obsolete delayed draft');
    assert.equal(await changed.drafts().read(room.id),'Current draft');
    assert.equal(await store.drafts().read(room.id),null);
  } finally { h.db.close(); }
});

test('native history uses its decimal cursor and reports progress independently of timestamps',async () => {
  const h = nativeTestDatabase(); const store = new NativeStore(h.adapter,createWriteQueue(),account);
  await store.applySnapshot({protocol_version:1,rooms:[room],messages:[message],cursor:'initial'});
  let requested: string | undefined;
  const transport = {
    discover:async () => fixture.discovery,me:async () => ({id:account.userId}),
    changes:async () => ({protocol_version:1,changes:[],cursor:'next',has_more:false}),
    socketUrl:async () => 'ws://localhost/native',
    history:async (_rid: string,before?: string) => {
      requested = before;
      return {protocol_version:1,messages:[{...message,id:'older',position:(BigInt(message.position)-1n).toString(),created_at:'2050-01-01T00:00:00Z'}],has_more:false};
    },
  } as unknown as NativeTransport;
  const client = new RestClient(account.baseUrl);
  const provider = createRocketVibeProvider(account,client,() => 'intent',store,{transport,socket:() => {
    const socket = {readyState:1,onopen:null,onclose:null,onerror:null,onmessage:null,close:() => {}} as unknown as WebSocket;
    queueMicrotask(() => socket.onopen?.(new Event('open')));
    return socket;
  }});
  try {
    await provider.native!.chat.connect();
    const page = await provider.loadHistory(null as never,room.id,'c','2026-01-01T00:00:00Z');
    assert.equal(requested,message.position);
    assert.equal(page.movedBack,true);
    assert.equal(await store.oldestPosition(room.id),(BigInt(message.position)-1n).toString());
  } finally { provider.native!.chat.stop(); h.db.close(); }
});
