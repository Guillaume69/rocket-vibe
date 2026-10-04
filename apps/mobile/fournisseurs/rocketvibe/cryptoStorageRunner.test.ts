import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import type {Session} from '../../lib/auth.ts';
import type {CryptoAccount,CryptoStorageBridge} from '../../modules/crypto-native/index.ts';
import {NativeChat} from './chat.ts';
import {NativeStore} from './store.ts';
import {NativeTransport} from './transport.ts';
import {nativeTestDatabase} from './testDatabase.ts';

test('the mobile runner selects the verified HTTP device and fences storage on suspension or scope changes',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:fixture.session.user.id,username:'alice',
    genre:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  for(const scenario of ['normal','disabled','missing-current-device','changed-device','changed-epoch','suspended-during-open'] as const){
    const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,creerFileEcritures(),session);
    await store.applySnapshot({protocol_version:1,rooms:[],messages:[],cursor:'initial'});
    let changed=false,mutations=0,opened=0;
    let chosen:CryptoAccount|null=null,release:()=>void=()=>{},started:()=>void=()=>{};
    const waiting=new Promise<void>(resolve=>{started=resolve;}),done=new Promise<void>(resolve=>{release=resolve;});
    const transport={
      baseUrl:session.baseUrl,
      discover:async()=>({...fixture.discovery,data_epoch:scenario==='changed-epoch'&&changed?'another-epoch':fixture.discovery.data_epoch,
        capabilities:{...fixture.discovery.capabilities,e2ee:scenario!=='disabled',device_sessions:true}}),
      me:async()=>fixture.session.user,changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),
      socketUrl:async()=>'ws://localhost/fake',
      deviceSessions:async()=>scenario==='missing-current-device'?[]:[{id:changed?'another-device':'http-current',current:true}],
    } as unknown as NativeTransport;
    const closed:string[]=[];
    const bridge:CryptoStorageBridge={
      open:async account=>{chosen=account;opened++;started();if(scenario==='suspended-during-open')await done;
        return {handle:'native-original',phase:'missing',accountFingerprint:'ab'.repeat(32),incarnation:''};},
      status:async()=>({phase:'missing',accountFingerprint:'ab'.repeat(32),incarnation:''}),
      initialize:async()=>{mutations++;return {phase:'ready',accountFingerprint:'ab'.repeat(32),incarnation:'cd'.repeat(16)};},
      retire:async()=>{},close:async handle=>{closed.push(handle);},
    };
    const chat=new NativeChat(session,store,()=>{throw new Error('No ordinary outbox intent');},{transport,socket:()=>{
      const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
      queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
    }});
    try {
      await chat.connect();
      if(scenario==='disabled' || scenario==='missing-current-device'){
        await assert.rejects(chat.cryptoStorage(bridge),scenario==='disabled'?/unsupported_feature/:/invalid_native_session/);
        assert.equal(opened,0);continue;
      }
      const opening=chat.cryptoStorage(bridge);
      if(scenario==='suspended-during-open'){
        await waiting;chat.suspend();release();await assert.rejects(opening,/session_closed/);
        assert.deepEqual(closed,['native-original']);assert.equal(mutations,0);continue;
      }
      const access=await opening;
      assert.deepEqual(chosen,{origin:session.baseUrl,instance:session.nativeInstanceId,dataEpoch:session.nativeDataEpoch,
        user:session.userId,device:'http-current'});
      changed=scenario==='changed-device' || scenario==='changed-epoch';
      if(changed){
        await assert.rejects(access.initialize('ab'.repeat(32)),scenario==='changed-device'?/crypto_scope_changed/:/server_identity_changed/);
        assert.equal(mutations,0);
      } else {
        await access.initialize('ab'.repeat(32));assert.equal(mutations,1);
        chat.suspend();await assert.rejects(access.status(),/session_closed/);await access.close();
        assert.deepEqual(closed,['native-original']);
      }
    } finally {chat.stop();release();await store.state();db.close();}
  }
});
