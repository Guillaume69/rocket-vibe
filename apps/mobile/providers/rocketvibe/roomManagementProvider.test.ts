import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import type {Session} from '../../lib/auth.ts';
import type {RestClient} from '../../lib/rest.ts';
import {createWriteQueue} from '../../db/writeQueue.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {NativeStore} from './store.ts';
import {createRocketVibeProvider} from './index.ts';
import {NativeError,type NativeTransport} from './transport.ts';
import type {RoomCommandReceipt,UpdateRoom} from './protocol.generated.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
function socket():WebSocket {const result={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;queueMicrotask(()=>result.onopen?.(new Event('open')));return result;}
test('room controls intersect capabilities, actor permissions and DM restrictions',async()=>{
  for(const scenario of ['owner','member','unsupported','direct'] as const){
    const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
    const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,createWriteQueue(),session);
    const room={...fixture.room,kind:scenario==='direct'?'direct':'private'};
    const transport={discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,room_info:true,room_settings:scenario!=='unsupported',room_roles:scenario!=='unsupported',room_leave:scenario!=='unsupported'}}),me:async()=>fixture.session.user,changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',roomDetails:async()=>({...fixture.parity.room_details,room,permissions:{...fixture.parity.room_details.permissions,role:scenario==='member'?'member':'owner',change_settings:scenario==='owner'}})} as unknown as NativeTransport;
    const client={get:()=>{throw new Error('Native management cannot call Rocket.Chat');}} as unknown as RestClient;
    const provider=createRocketVibeProvider(session,client,()=>{throw new Error('Reads cannot create operations');},store,{transport,socket});
    try{
      await store.applySnapshot({protocol_version:1,rooms:[room],messages:[],cursor:'initial'});await provider.native!.chat.connect();
      const info=await provider.actions.roomInfo(room.id);
      assert.equal(info.management?.canEdit,scenario==='owner');
      assert.equal(info.management?.canChangeRoles,scenario==='owner');
      assert.equal(info.management?.canLeave,scenario==='owner'||scenario==='member');
      assert.equal(provider.capabilities.roomSettings,scenario!=='unsupported');
      assert.equal(await provider.actions.roomManagement!.intention(room.id),null);
    }finally{provider.native!.chat.stop();await store.state();db.close();}
  }
});
test('existing sheet actions retain saved fields, resume a receipt and explicitly clear a rejected departure',async()=>{
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,createWriteQueue(),session);
  const receipts=new Map<string,RoomCommandReceipt>();let writes=0,nonces=0;
  const transport={discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,room_info:true,room_settings:true,room_roles:true,room_leave:true}}),me:async()=>fixture.session.user,changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',roomDetails:async()=>fixture.parity.room_details,
    roomMembers:async()=>fixture.parity.room_members,
    roomCommandReceipt:async(_room:string,operation:string)=>{const receipt=receipts.get(operation);if(!receipt)throw new NativeError(404,'not_found');return receipt;},
    updateRoom:async(room:string,input:UpdateRoom)=>{writes++;assert.equal(input.expected_revision,'original-revision');receipts.set(input.operation_id,{operation_id:input.operation_id,room_id:room,applied_revision:'applied'});throw new NativeError(0,'connection_failed');},
    leaveRoom:async()=>{throw new NativeError(409,'last_room_owner');},
  } as unknown as NativeTransport;
  const client={post:()=>{throw new Error('Native management cannot call Rocket.Chat');}} as unknown as RestClient;
  const provider=createRocketVibeProvider(session,client,()=>`form-${++nonces}`,store,{transport,socket});
  try{
    await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[],cursor:'initial'});await provider.native!.chat.connect();const actions=provider.actions.roomManagement!;
    const fields={name:'Room',isPrivate:true,topic:'Saved subject',description:'Description',announcement:'',readOnly:true};
    await assert.rejects(actions.edit(fixture.room.id,'original-revision',fields));
    const intent=await actions.intention(fixture.room.id);assert.deepEqual(intent?.settings,fields);assert.equal(intent?.failed,false);
    assert.equal(await actions.clear(fixture.room.id,intent!.key),false);
    await actions.resume(fixture.room.id);assert.equal(writes,1);assert.equal(await actions.intention(fixture.room.id),null);
    const page=await actions.members(fixture.room.id,null,fixture.parity.room_members.revision);assert.equal(page.members[0].username,fixture.parity.room_members.members[0].user.username);
    await assert.rejects(actions.leave(fixture.room.id,'fresh'),(error:unknown)=>error instanceof NativeError && error.code==='last_room_owner');
    const failed=await actions.intention(fixture.room.id);assert.equal(failed?.type,'leave');assert.equal(failed?.failed,true);
    assert.equal(await actions.clear(fixture.room.id,'other-key'),false);assert.equal(await actions.clear(fixture.room.id,failed!.key),true);
  }finally{provider.native!.chat.stop();await store.state();db.close();}
});
