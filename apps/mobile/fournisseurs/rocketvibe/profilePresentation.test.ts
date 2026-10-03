import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import type {Session} from '../../lib/auth.ts';
import {ClientRest} from '../../lib/rest.ts';
import {creerFournisseurRV} from './index.ts';
import {NativeStore} from './store.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import type {NativeTransport} from './transport.ts';
import type {UserProfile} from './protocol.generated.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
async function bench(){
  const session:Session={genre:'rocketvibe',baseUrl:'http://localhost:3400',authToken:'native-token',userId:fixture.session.user.id,username:fixture.session.user.username,siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const database=nativeTestDatabase(),store=new NativeStore(database.adapter,creerFileEcritures(),session);
  await store.applySnapshot({protocol_version:1,rooms:[],messages:[],cursor:'before-profiles'});
  let profile:UserProfile={...fixture.own_profile.profile,user:fixture.session.user};
  let epoch=fixture.discovery.data_epoch,profileRead:Promise<UserProfile>|null=null,avatarRead:Promise<Uint8Array>|null=null;
  const transport={discover:async()=>({...fixture.discovery,data_epoch:epoch,capabilities:{...fixture.discovery.capabilities,profiles:true,profile_avatars:true,presence:false,read_markers:false}}),
    me:async()=>fixture.session.user,changes:async()=>({protocol_version:1,changes:[],cursor:'before-profiles',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
    userProfile:async()=>profileRead??profile,lookupProfile:async()=>profileRead??profile,avatarBytes:async()=>avatarRead??new Uint8Array([137,80,78,71,13,10,26,10])} as unknown as NativeTransport;
  const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
  const client=new ClientRest(session.baseUrl,{fetch:async()=>{throw new Error('Unexpected RC request');}});client.genre='rocketvibe';
  const provider=creerFournisseurRV(session,client,()=> 'unused-profile-command',store,{transport,socket:()=>{queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;}});
  const chat=provider.native!.chat;await chat.connect();
  return {database,store,provider,chat,session,client,
    profile:()=>profile,setProfile:(value:UserProfile)=>{profile=value;},setRead:(value:Promise<UserProfile>|null)=>{profileRead=value;},setAvatar:(value:Promise<Uint8Array>)=>{avatarRead=value;},changeEpoch:()=>{epoch='other-generation';},
    async live(value:UserProfile,others:UserProfile[]=[]){
      const observed=new Promise<void>(resolve=>{const un=chat.live.subscribe(()=>{un();resolve();});});
      socket.onmessage?.({data:JSON.stringify({type:'live',data:{limited:false,presence:[],rooms:[],ttl_ms:8000,profiles:[value,...others].map(p=>({user:p.user,revision:p.revision,avatar_file_id:p.avatar_file_id,status_text:p.status_text}))}})} as MessageEvent);
      await observed;
    },async close(){chat.stop();await store.state();database.db.close();}};
}

test('public profiles normalize for the existing sheet and store identity only, without RC routes or journal changes',async()=>{
  const b=await bench();
  try{
    const result=await b.provider.lireProfil!({uid:b.session.userId});
    assert.equal(result?._id,b.session.userId);assert.equal(result?.bio,b.profile().bio);
    assert.equal(result?.email,undefined);assert.equal(result?.preferences,undefined);
    assert.equal((await b.store.state())?.cursor,'before-profiles');assert.equal(b.database.db.prepare('SELECT count(*) n FROM messages').get()?.n,0);
    const identity=b.database.db.prepare('SELECT uid,username,avatar_etag FROM utilisateurs').get();
    assert.equal(identity?.username,b.profile().user.username);assert.equal(identity?.avatar_etag,b.profile().avatar_file_id??'sans-photo');
    await assert.rejects(b.provider.lireProfil!({uid:'somebody-else'}),/invalid_profile/);
    b.changeEpoch();await assert.rejects(b.provider.lireProfil!({uid:b.session.userId}),/server_identity_changed/);
  }finally{await b.close();}
});
test('a live rename or removed avatar commits to SQLite and fences an older profile response',async()=>{
  const b=await bench(),pending=deferred<UserProfile>();
  try{
    await b.live(b.profile());
    b.setRead(pending.promise);const old=b.chat.profile({uid:b.session.userId});
    await new Promise<void>(r=>setImmediate(r));
    const current={...b.profile(),revision:'changed-profile',user:{...b.profile().user,username:'current-name'},avatar_file_id:null};
    await b.live(current);pending.resolve(b.profile());
    await assert.rejects(old,/delivery_revalidate/);
    const identity=b.database.db.prepare('SELECT username,avatar_etag FROM utilisateurs WHERE uid=?').get(b.session.userId);
    assert.deepEqual({...identity},{username:'current-name',avatar_etag:'sans-photo'});
    b.setRead(null);b.setProfile(current);assert.equal((await b.chat.profile({uid:b.session.userId})).user.username,'current-name');
  }finally{await b.close();}
});
test('avatar download is discarded when its runner closes before the response',async()=>{
  const b=await bench(),pending=deferred<Uint8Array>();
  try{
    b.setAvatar(pending.promise);const request=b.chat.profileAvatar('a'.repeat(64));
    await new Promise<void>(r=>setImmediate(r));b.chat.stop();pending.resolve(new Uint8Array([137,80,78,71,13,10,26,10]));
    await assert.rejects(request,/session_closed/);
    await assert.rejects(b.chat.profile({uid:b.session.userId}),/session_closed/);
  }finally{await b.close();}
});

test('another member changing their profile does not discard the current sheet response',async()=>{
  const b=await bench(),pending=deferred<UserProfile>();
  try{
    await b.live(b.profile());
    const version=b.chat.profileVersionFor(b.session.userId);
    b.setRead(pending.promise);const response=b.chat.profile({uid:b.session.userId});
    await new Promise<void>(r=>setImmediate(r));
    await b.live(b.profile(),[{...b.profile(),revision:'other-profile',user:{...b.profile().user,id:'other-user',username:'other'}}]);
    assert.equal(b.chat.profileVersionFor(b.session.userId),version);
    pending.resolve(b.profile());assert.equal((await response).user.id,b.session.userId);
  }finally{await b.close();}
});
