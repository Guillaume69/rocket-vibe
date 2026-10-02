import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import type {Session} from '../../lib/auth.ts';
import type {ClientRest} from '../../lib/rest.ts';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {NativeStore} from './store.ts';
import {creerFournisseurRV} from './index.ts';
import {NativeError,type NativeTransport} from './transport.ts';
import type {RoomCommandReceipt,UpdateRoom} from './protocol.generated.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
function socket():WebSocket {const result={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;queueMicrotask(()=>result.onopen?.(new Event('open')));return result;}
test('room controls intersect capabilities, actor permissions and DM restrictions',async()=>{
  for(const scenario of ['owner','member','unsupported','direct'] as const){
    const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',genre:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
    const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,creerFileEcritures(),session);
    const room={...fixture.room,kind:scenario==='direct'?'direct':'private'};
    const transport={discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,room_info:true,room_settings:scenario!=='unsupported',room_roles:scenario!=='unsupported',room_leave:scenario!=='unsupported'}}),me:async()=>fixture.session.user,changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',roomDetails:async()=>({...fixture.parity.room_details,room,permissions:{...fixture.parity.room_details.permissions,role:scenario==='member'?'member':'owner',change_settings:scenario==='owner'}})} as unknown as NativeTransport;
    const client={get:()=>{throw new Error('Native management cannot call Rocket.Chat');}} as unknown as ClientRest;
    const provider=creerFournisseurRV(session,client,()=>{throw new Error('Reads cannot create operations');},store,{transport,socket});
    try{
      await store.applySnapshot({protocol_version:1,rooms:[room],messages:[],cursor:'initial'});await provider.native!.chat.connect();
      const info=await provider.actions.infosSalon(room.id);
      assert.equal(info.gestion?.peutModifier,scenario==='owner');
      assert.equal(info.gestion?.peutChangerRoles,scenario==='owner');
      assert.equal(info.gestion?.peutQuitter,scenario==='owner'||scenario==='member');
      assert.equal(provider.capacites.reglagesSalon,scenario!=='unsupported');
      assert.equal(await provider.actions.gestionSalon!.intention(room.id),null);
    }finally{provider.native!.chat.stop();await store.state();db.close();}
  }
});
test('existing sheet actions retain saved fields, resume a receipt and explicitly clear a rejected departure',async()=>{
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',genre:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,creerFileEcritures(),session);
  const receipts=new Map<string,RoomCommandReceipt>();let writes=0,nonces=0;
  const transport={discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,room_info:true,room_settings:true,room_roles:true,room_leave:true}}),me:async()=>fixture.session.user,changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',roomDetails:async()=>fixture.parity.room_details,
    roomMembers:async()=>fixture.parity.room_members,
    roomCommandReceipt:async(_room:string,operation:string)=>{const receipt=receipts.get(operation);if(!receipt)throw new NativeError(404,'not_found');return receipt;},
    updateRoom:async(room:string,input:UpdateRoom)=>{writes++;assert.equal(input.expected_revision,'original-revision');receipts.set(input.operation_id,{operation_id:input.operation_id,room_id:room,applied_revision:'applied'});throw new NativeError(0,'connection_failed');},
    leaveRoom:async()=>{throw new NativeError(409,'last_room_owner');},
  } as unknown as NativeTransport;
  const client={post:()=>{throw new Error('Native management cannot call Rocket.Chat');}} as unknown as ClientRest;
  const provider=creerFournisseurRV(session,client,()=>`form-${++nonces}`,store,{transport,socket});
  try{
    await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[],cursor:'initial'});await provider.native!.chat.connect();const actions=provider.actions.gestionSalon!;
    const champs={nom:'Room',prive:true,sujet:'Saved subject',description:'Description',annonce:'',lectureSeule:true};
    await assert.rejects(actions.modifier(fixture.room.id,'original-revision',champs));
    const intent=await actions.intention(fixture.room.id);assert.deepEqual(intent?.reglages,champs);assert.equal(intent?.echouee,false);
    assert.equal(await actions.effacer(fixture.room.id,intent!.cle),false);
    await actions.reprendre(fixture.room.id);assert.equal(writes,1);assert.equal(await actions.intention(fixture.room.id),null);
    const page=await actions.membres(fixture.room.id,null,fixture.parity.room_members.revision);assert.equal(page.membres[0].pseudo,fixture.parity.room_members.members[0].user.username);
    await assert.rejects(actions.quitter(fixture.room.id,'fresh'),(error:unknown)=>error instanceof NativeError && error.code==='last_room_owner');
    const failed=await actions.intention(fixture.room.id);assert.equal(failed?.type,'depart');assert.equal(failed?.echouee,true);
    assert.equal(await actions.effacer(fixture.room.id,'other-key'),false);assert.equal(await actions.effacer(fixture.room.id,failed!.cle),true);
  }finally{provider.native!.chat.stop();await store.state();db.close();}
});
