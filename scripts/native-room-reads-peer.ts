// Actual mobile HTTP transport against a disposable PostgreSQL server.
import assert from 'node:assert/strict';
import {NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import {NativeStore} from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
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
try {
  const cache=new NativeStore(adapter,creerFileEcritures(),{baseUrl:base,authToken:account.token,userId:account.user.id,username:account.user.username,genre:'rocketvibe',siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch});
  await cache.applySnapshot(await reader.snapshot());
  const originalState=(await cache.readState(room))!,projection=cache.projectionToken();
  assert.equal(originalState.favorite,false);assert.equal(originalState.unread_roots,'0');
  await cache.enqueue('ts-absent-send',room,'Never replay after a missed withdrawal');
  await cache.drafts().ecrire(room,'Private before withdrawal');
  const details=await reader.roomDetails(room);
  await reader.leaveRoom(room,{operation_id:'ts-cache-leave',expected_revision:details.revision});
  await owner.addMember(room,account.user.id);
  // The client missed room_removed and reconstructs directly from a new snapshot.
  await cache.applySnapshot(await reader.snapshot());
  assert.notEqual((await cache.readState(room))?.membership_version,originalState.membership_version);
  assert.deepEqual(await cache.pending(),[]);assert.equal(await cache.drafts().lire(room),null);
  assert.equal(await cache.cacheReadState(originalState,projection),false);
  assert.equal((await cache.readState(room))?.favorite,false);
} finally {db.close();}
console.log(JSON.stringify({unreads:true,monotone:true,privateFavorite:true,lostAckRecovered:true,noSecondFavorite:true,oldReplayHarmless:true,mentions:true,sqliteCache:true,missedRejoin:true}));
