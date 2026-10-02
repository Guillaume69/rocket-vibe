// Actual mobile HTTP transport against a disposable PostgreSQL server.
import assert from 'node:assert/strict';
import {NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
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
console.log(JSON.stringify({unreads:true,monotone:true,privateFavorite:true,lostAckRecovered:true,noSecondFavorite:true,oldReplayHarmless:true}));
