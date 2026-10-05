import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import type {Session} from '../../lib/auth.ts';
import {createWriteQueue} from '../../db/writeQueue.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {NativeStore} from './store.ts';
import {createRocketVibeProvider} from './index.ts';
import {NativeError, type NativeTransport} from './transport.ts';
import type {RestClient} from '../../lib/rest.ts';

test('existing room information provider keeps scopes through removal, closing and restore',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:fixture.session.user.id,username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  for(const scenario of ['normal','unsupported','foreign','removed','closed','epoch'] as const) {
    const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,createWriteQueue(),session);
    await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[],cursor:'initial'});
    let changed=false,reads=0;
    const client={get:()=>{throw new Error('Native metadata must never call Rocket.Chat');}} as unknown as RestClient;
    const transport={
      discover:async()=>({...fixture.discovery,data_epoch:changed?'replacement-epoch':fixture.discovery.data_epoch,capabilities:{...fixture.discovery.capabilities,room_info:scenario!=='unsupported'}}),
      me:async()=>fixture.session.user,changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
      roomDetails:async()=>{
        reads++;
        if(scenario==='removed')await store.applyBatch({protocol_version:1,changes:[{type:'room_removed',data:{room_id:fixture.room.id}}],cursor:'removed',has_more:false});
        if(scenario==='closed')provider.native!.chat.stop();
        if(scenario==='epoch')changed=true;
        return {...fixture.parity.room_details,read_only:true,room:{...fixture.room,id:scenario==='foreign'?'foreign-room':fixture.room.id}};
      },
    } as unknown as NativeTransport;
    const provider=createRocketVibeProvider(session,client,()=>{throw new Error('A read must not create an operation');},store,{transport,socket:()=>{
      const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
      queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
    }});
    try {
      await provider.native!.chat.connect();
      const request=provider.actions.roomInfo(fixture.room.id);
      if(scenario==='normal') {
        const {management,...information}=await request;
        assert.deepEqual(information,{id:'room-id',name:'A room',type:'p',description:'Description',topic:'Sujet 🚀',announcement:'Annonce',members:1,readOnly:true});
        assert.equal(management?.revision,fixture.parity.room_details.revision);
        assert.equal(provider.capabilities.roomInfo,true);assert.equal(provider.capabilities.roomFavorites,false);
      } else {
        const expected=scenario==='unsupported'?'unsupported_feature':scenario==='foreign'?'invalid_room_details':scenario==='removed'?'delivery_revalidate':scenario==='closed'?'session_closed':'server_identity_changed';
        await assert.rejects(request,(error:unknown)=>error instanceof NativeError && error.code===expected);
      }
      assert.equal(reads,scenario==='unsupported'?0:1);
    } finally {provider.native!.chat.stop();await store.state();db.close();}
  }
});
