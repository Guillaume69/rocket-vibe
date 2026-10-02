// Actual mobile HTTP transport against a disposable PostgreSQL server.
import assert from 'node:assert/strict';
import {NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import {NativeStore} from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import {NativeChat} from '../apps/mobile/fournisseurs/rocketvibe/chat.ts';
import {creerFournisseurRV} from '../apps/mobile/fournisseurs/rocketvibe/index.ts';
import {ClientRest} from '../apps/mobile/lib/rest.ts';
import {nativeTestDatabase} from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import {creerFileEcritures} from '../apps/mobile/db/fileEcritures.ts';
const base=process.env.RV_ROOM_PEER_URL!,room=process.env.RV_ROOM_PEER_ROOM!;
const owner=new NativeTransport(base),reader=new NativeTransport(base);
await owner.login('read-owner','read-test-password-2026');
const account=await reader.login('read-member','read-test-password-2026');
const posted=await owner.send(room,{operation_id:'ts-read-root',text:'A new unread root'});
assert.equal((await owner.roomReadState(room)).unread_roots,'0');
assert.equal((await reader.roomReadState(room)).unread_roots,'1');
const read=await reader.markRoomRead(room,{root_position:posted.position,reply_position:'0'});
assert.equal(read.unread_roots,'0');
assert.equal((await reader.markRoomRead(room,{root_position:'0',reply_position:'0'})).root_position,posted.position);
const peerCursor=(await owner.snapshot()).cursor;
let writes=0,lost=false;
const unreliable=new NativeTransport(base,async(url,options)=>{
  const response=await fetch(url,options);
  if(options?.method==='PUT' && new URL(String(url)).pathname.endsWith('/favorite')) {
    writes++;if(response.ok && !lost){lost=true;throw new Error('Simulated lost favorite acknowledgement');}
  }
  return response;
});unreliable.restore(account.token);
const original={operation_id:'ts-favorite-original',expected_revision:read.favorite_revision!,present:true};
await assert.rejects(unreliable.setRoomFavorite(room,original));
const receipt=await unreliable.roomCommandReceipt(room,original.operation_id);
assert.equal(receipt.operation_id,original.operation_id);assert.equal(writes,1);
const favorited=await reader.roomReadState(room);assert.equal(favorited.favorite,true);
await reader.setRoomFavorite(room,{operation_id:'ts-favorite-remove',expected_revision:favorited.favorite_revision!,present:false});
assert.deepEqual(await reader.setRoomFavorite(room,original),receipt);
assert.equal((await reader.roomReadState(room)).favorite,false);
assert.equal((await owner.roomReadState(room)).favorite,false);
assert.equal((await owner.changes(peerCursor)).changes.length,0);
assert.equal((await reader.snapshot()).rooms.find(r=>r.id===room)?.read_state?.favorite,false);
const mentionInput={operation_id:'ts-mention-root',text:'Hello @read-member @read-member @all `@read-member`'};
const mentioned=await owner.send(room,mentionInput);
await owner.send(room,mentionInput);
const ping=await reader.roomReadState(room);
assert.equal(ping.unread_roots,'1');assert.equal(ping.mentions,'1');assert.equal(ping.group_mentions,'0');
await owner.editMessage(mentioned.id,{operation_id:'ts-mention-withdraw',expected_revision:mentioned.revision,content:{kind:'plain',markdown:'Plain edited text',mentions:[],quotes:[],files:[]}});
assert.equal((await reader.roomReadState(room)).mentions,'0');
assert.equal((await reader.markRoomRead(room,{root_position:mentioned.position,reply_position:'0'})).unread_roots,'0');
const discovery=await reader.discover();
const {db,adapter}=nativeTestDatabase();
let chat:NativeChat|undefined;
try {
  const session={baseUrl:base,authToken:account.token,userId:account.user.id,username:account.user.username,genre:'rocketvibe' as const,siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
  const cache=new NativeStore(adapter,creerFileEcritures(),session);
  await cache.applySnapshot(await reader.snapshot());
  const originalState=(await cache.readState(room))!,projection=cache.projectionToken();
  assert.equal(originalState.favorite,false);assert.equal(originalState.unread_roots,'0');
  const observed=await owner.send(room,{operation_id:'ts-queue-observed',text:'Observed before crash'});
  const newer=await owner.send(room,{operation_id:'ts-queue-newer',text:'Not observed yet'});
  await cache.applySnapshot(await reader.snapshot());
  let favoriteAttempts=0,readAttempts=0;
  const queueTransport=new NativeTransport(base,async(url,options)=>{
    const response=await fetch(url,options),path=new URL(String(url)).pathname;
    if(response.ok && path.endsWith('/favorite') && options?.method==='PUT') {favoriteAttempts++;throw new Error('Lost queue favorite response');}
    if(response.ok && path.endsWith('/read') && options?.method==='POST') {readAttempts++;throw new Error('Lost observed read response');}
    return response;
  });queueTransport.restore(account.token);
  // This HTTP/SQLite test does not consume the WebSocket; replay and response
  // scopes are exercised against the real PostgreSQL server.
  const socket=()=>{const ws={onopen:null,close:()=>{}} as unknown as WebSocket;queueMicrotask(()=>ws.onopen?.(new Event('open')));return ws;};
  const guardedRest=new ClientRest(base,{fetch:async()=>{throw new Error('Rocket.Chat route in a native favorite');}});
  const provider=creerFournisseurRV(session,guardedRest,()=> 'ts-queue-favorite',cache,{transport:queueTransport,socket});
  chat=provider.native!.chat;await chat.connect();
  assert.equal(provider.capacites.favorisSalon,true);
  await chat.markObservedRead(room,observed.id);
  const displayed=(await provider.actions.favoriSalon!.lire!(room))!;
  assert.equal(displayed.present,false);
  await provider.actions.favoriSalon!.modifier(room,true,displayed);
  assert.equal((await cache.pendingReads()).length,1);assert.equal((await cache.pendingFavorites()).length,1);
  assert.equal((await reader.roomReadState(room)).root_position,observed.position);
  assert.equal((await reader.roomReadState(room)).unread_roots,'1');
  assert.equal((await provider.actions.favoriSalon!.lire!(room))?.intention?.cle,'ts-queue-favorite');
  chat.stop();
  const afterAck=await reader.roomReadState(room);
  await reader.setRoomFavorite(room,{operation_id:'ts-queue-other-device',expected_revision:afterAck.favorite_revision!,present:false});
  chat=new NativeChat(session,cache,()=>{throw new Error('Retry must keep its nonce');},{transport:queueTransport,socket});await chat.connect();
  assert.deepEqual(await cache.pendingReads(),[]);assert.deepEqual(await cache.pendingFavorites(),[]);
  assert.equal(favoriteAttempts,1);assert.equal(readAttempts,1);assert.equal((await cache.readState(room))?.favorite,false);
  chat.stop();
  await cache.stageRead(room,newer.id);await cache.stageFavorite(room,true,()=> 'ts-queue-before-withdrawal');
  await cache.enqueue('ts-absent-send',room,'Never replay after a missed withdrawal');
  const oldComposer=cache.drafts({room,membership:originalState.membership_version!});
  await oldComposer.ecrire(room,'Private before withdrawal');
  const details=await reader.roomDetails(room);
  await reader.leaveRoom(room,{operation_id:'ts-cache-leave',expected_revision:details.revision});
  await owner.addMember(room,account.user.id);
  // The client missed room_removed and reconstructs directly from a new snapshot.
  await cache.applySnapshot(await reader.snapshot());
  assert.notEqual((await cache.readState(room))?.membership_version,originalState.membership_version);
  assert.deepEqual(await cache.pending(),[]);assert.equal(await cache.drafts().lire(room),null);
  assert.deepEqual(await cache.pendingReads(),[]);assert.deepEqual(await cache.pendingFavorites(),[]);
  assert.equal(await cache.cacheReadState(originalState,projection),false);
  assert.equal((await cache.readState(room))?.favorite,false);
  const currentState=(await cache.readState(room))!;
  const newComposer=cache.drafts({room,membership:currentState.membership_version!});
  await newComposer.ecrire(room,'Fresh after rejoining');
  await oldComposer.ecrire(room,'Delayed flush from the old open composer');
  await oldComposer.supprimer(room);
  assert.equal(await oldComposer.lire(room),null);
  assert.equal(await newComposer.lire(room),'Fresh after rejoining');
  await assert.rejects(cache.enqueue('ts-stale-composer',room,'Delayed send',{membership:originalState.membership_version!}));
  assert.deepEqual(await cache.pending(),[]);
  await newComposer.supprimer(room);
} finally {chat?.stop();db.close();}
console.log(JSON.stringify({unreads:true,monotone:true,privateFavorite:true,lostAckRecovered:true,noSecondFavorite:true,oldReplayHarmless:true,mentions:true,sqliteCache:true,missedRejoin:true,durableRunner:true,openComposerFenced:true,providerFavorite:true}));
