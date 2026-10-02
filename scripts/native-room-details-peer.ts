// Disposable PostgreSQL integration peer, using the actual mobile HTTP transport.
import assert from 'node:assert/strict';
import { NativeError, NativeTransport } from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import type { RoomDetails, UpdateRoom } from '../apps/mobile/fournisseurs/rocketvibe/protocol.generated.ts';
import {nativeTestDatabase} from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import {NativeStore} from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import {creerFournisseurRV} from '../apps/mobile/fournisseurs/rocketvibe/index.ts';
import {creerFileEcritures} from '../apps/mobile/db/fileEcritures.ts';
import {ClientRest} from '../apps/mobile/lib/rest.ts';
import type {Session} from '../apps/mobile/lib/auth.ts';

const base=process.env.RV_ROOM_PEER_URL!;
const room=process.env.RV_ROOM_PEER_ROOM!;
const owner=new NativeTransport(base), peer=new NativeTransport(base);
const a=await owner.login('owner','room-test-password-2026');
const b=await peer.login('mobile-peer','room-test-password-2026');
const initial=await owner.roomDetails(room);
const settings=(details:RoomDetails):UpdateRoom=>({operation_id:'mobile-settings',expected_revision:details.revision,name:'Mobile metadata 🚀',private:true,topic:'Sujet mobile',description:'Description',announcement:'Annonce',read_only:false});
const update=settings(initial);
const changed=await owner.updateRoom(room,update);
assert.equal((await peer.roomDetails(room)).topic,update.topic);
await owner.changeRoomRole(room,b.user.id,{operation_id:'mobile-handover',expected_revision:changed.applied_revision,role:'owner'});
const demote={operation_id:'mobile-self-demote',expected_revision:(await owner.roomDetails(room)).revision,role:'member' as const};
const demoted=await owner.changeRoomRole(room,a.user.id,demote);
assert.equal((await owner.roomDetails(room)).permissions.role,'member');
assert.deepEqual(await owner.changeRoomRole(room,a.user.id,demote),demoted);
assert.deepEqual(await owner.updateRoom(room,update),changed);
const list=await peer.roomMembers(room);
assert.equal(list.members.filter(m=>m.role==='owner').length,1);
const leave={operation_id:'mobile-leave',expected_revision:list.revision};
const left=await owner.leaveRoom(room,leave);
assert.deepEqual(await owner.roomCommandReceipt(room,leave.operation_id),left);
assert.deepEqual(await owner.leaveRoom(room,leave),left);
await assert.rejects(owner.roomDetails(room),(e:unknown)=>e instanceof NativeError && e.code==='not_found');
await assert.rejects(peer.leaveRoom(room,{operation_id:'mobile-last-owner',expected_revision:(await peer.roomDetails(room)).revision}),(e:unknown)=>e instanceof NativeError && e.code==='last_room_owner');
const discovery=await peer.discover();
const account:Session={baseUrl:base,authToken:b.token,userId:b.user.id,username:b.user.username,genre:'rocketvibe',siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
const harness=nativeTestDatabase(),store=new NativeStore(harness.adapter,creerFileEcritures(),account);
let lost=false,writes=0;
const transport=new NativeTransport(base,async(url,options)=>{
  const response=await fetch(url,options);
  if(options?.method==='PATCH'){writes++;if(!lost && response.ok){lost=true;throw new Error('Simulated dropped room acknowledgement');}}
  return response;
});transport.restore(b.token);
const provider=creerFournisseurRV(account,new ClientRest(base,{fetch:async()=>{throw new Error('Native room UI must not call Rocket.Chat');}}),()=> 'mobile-ui-original',store,{transport,socket:()=>{
  const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
}});
try{
  await provider.native!.chat.connect();
  const details=(await provider.actions.infosSalon(room)).gestion!;assert.equal(details.peutModifier,true);
  const actions=provider.actions.gestionSalon!,fields={nom:details.nom,prive:details.prive,sujet:'Formulaire mobile conservé',description:details.description,annonce:details.annonce,lectureSeule:true};
  await assert.rejects(actions.modifier(room,details.revision,fields));assert.deepEqual((await actions.intention(room))?.reglages,fields);
  await actions.reprendre(room);assert.equal(writes,1);assert.equal(await actions.intention(room),null);
  const fresh=(await provider.actions.infosSalon(room)).gestion!;
  const members=await actions.membres(room,null,fresh.revision);assert.equal(members.membres[0].role,'owner');
}finally{provider.native!.chat.stop();await store.state();harness.db.close();}
console.log(JSON.stringify({metadata:true,handover:true,selfDemotion:true,receiptAfterLeave:true,lastOwnerProtected:true,existingMobileProvider:true,savedFormRecovered:true,noSecondPatch:true}));
