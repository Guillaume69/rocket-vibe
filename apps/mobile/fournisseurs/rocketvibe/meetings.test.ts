import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,unlinkSync,rmdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Session} from '../../lib/auth.ts';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import {NativeStore} from './store.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {publicMeetingUrl,privateMeetingUrl,meetingMediaState} from './meetings.ts';
import type {Snapshot,Meeting,MeetingJoin} from './protocol.generated.ts';
import {NativeChat} from './chat.ts';
import {NativeError,type NativeTransport} from './transport.ts';

const session:Session={baseUrl:'http://localhost:3400',authToken:'token',userId:'alice',username:'alice',genre:'rocketvibe',siteUrl:null,nativeInstanceId:'instance',nativeDataEpoch:'epoch'};
const snapshot=(membership='membership'):Snapshot=>({protocol_version:1,cursor:'initial',messages:[],rooms:[{id:'room',name:'Room',kind:'private',revision:'10',read_state:{room_id:'room',revision:'10',membership_version:membership,favorite_revision:'9',root_position:'0',reply_position:'0',unread_roots:'0',unread_replies:'0',mentions:'0',group_mentions:'0',favorite:false}}]});
const input=(operation_id='original')=>({operation_id,membership_version:'membership',data_epoch:'epoch'});

test('meeting start survives disk reopen with its original nonce; confirmation is exact',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rv-meeting-')),filename=join(directory,'account.sqlite');
  let harness=nativeTestDatabase(filename);
  try{
    let store=new NativeStore(harness.adapter,creerFileEcritures(),session);await store.applySnapshot(snapshot());
    assert.deepEqual(await store.meetings.stage('room',input()),input());harness.db.close();
    harness=nativeTestDatabase(filename,false);store=new NativeStore(harness.adapter,creerFileEcritures(),session);
    assert.deepEqual(await store.meetings.stage('room',input('replacement')),input());
    await store.applySnapshot({...snapshot(),cursor:'reset'});
    assert.deepEqual(await store.meetings.stage('room',input('later')),input());
    assert.equal(await store.meetings.acknowledge('room',input('wrong')),false);
    assert.equal(await store.meetings.acknowledge('room',input()),true);
    assert.deepEqual(await store.meetings.stage('room',input('next')),input('next'));
    assert.equal(await store.meetings.acknowledge('room',input()),false);
    assert.equal(harness.db.prepare('SELECT id FROM native_meeting_intents').get()?.id,'next');
  }finally{harness.db.close();unlinkSync(filename);rmdirSync(directory);}
});

test('withdrawal, rejoin and restored data epoch purge old meeting starts',async()=>{
  const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,creerFileEcritures(),session);
  try{
    await store.applySnapshot(snapshot());await store.meetings.stage('room',input());
    const rejoined=snapshot('rejoined');rejoined.rooms[0].read_state!.revision='20';
    await store.applySnapshot(rejoined);
    assert.equal(db.prepare('SELECT count(*) n FROM native_meeting_intents').get()?.n,0);
    assert.equal(await store.meetings.acknowledge('room',input()),false);
    await assert.rejects(async()=>store.meetings.stage('room',input()),/delivery_revalidate/);
    await store.meetings.stage('room',{...input('new-grant'),membership_version:'rejoined'});
    await store.applyBatch({protocol_version:1,cursor:'removed',has_more:false,changes:[{type:'room_removed',data:{room_id:'room'}}]});
    assert.equal(db.prepare('SELECT count(*) n FROM native_meeting_intents').get()?.n,0);
    await store.applySnapshot(snapshot());await store.meetings.stage('room',input('before-restore'));
    const restored=new NativeStore(adapter,creerFileEcritures(),{...session,nativeDataEpoch:'restored'});
    await restored.prepare();assert.equal(db.prepare('SELECT count(*) n FROM native_meeting_intents').get()?.n,0);
  }finally{db.close();}
});

test('a call activity keeps the meeting ID in the existing message row without a participant token',async()=>{
  const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,creerFileEcritures(),session);
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  try{
    await store.applySnapshot({...snapshot(),messages:[{...fixture.message,room_id:'room',text:'',system:{kind:'call_started',meeting_id:'meeting'}}]});
    const row=db.prepare('SELECT type_systeme,appel_id,texte FROM messages').get()!;
    assert.equal(row.type_systeme,'videoconf');assert.equal(row.appel_id,'meeting');assert.equal(row.texte,'');
    assert.equal(JSON.stringify(row).includes('jwt'),false);
  }finally{db.close();}
});

test('private meeting URL has the exact public conference, one JWT and a bounded live expiry',()=>{
  const now=Date.now(),meeting:Meeting={id:'meeting',room_id:'room',public_url:'https://meet.example.test:8443/conference',created_by:'alice',expires_at:new Date(now+7200000).toISOString(),ended:false};
  const joined:MeetingJoin={meeting,url:`${meeting.public_url}?jwt=a.b.c`,expires_at:new Date(now+120000).toISOString()};
  assert.equal(publicMeetingUrl(meeting,'room','meeting'),meeting.public_url);
  assert.equal(privateMeetingUrl(joined,'room','meeting',now),joined.url);
  assert.equal(meetingMediaState(joined.url,{cam:false,mic:true}),`${joined.url}#config.startWithVideoMuted=true&config.startWithAudioMuted=false`);
  assert.equal(meetingMediaState(joined.url),joined.url);
  for(const url of ['https://evil.test/conference?jwt=a.b.c',`${meeting.public_url}2?jwt=a.b.c`,`${joined.url}&next=https://evil.test`,`${joined.url}#fragment`,`${meeting.public_url}?jwt=a.b.c&jwt=d.e.f`,`${meeting.public_url}?jwt=invalid`]){
    assert.throws(()=>privateMeetingUrl({...joined,url},'room','meeting',now),/invalid_meeting/);
  }
  for(const public_url of ['http://meet.example.test/conference','https://user:pass@meet.example.test/conference','https://meet.example.test/conference?jwt=a.b.c','https://meet.example.test:99999/conference','https://meet.example.test/../conference']){
    assert.throws(()=>publicMeetingUrl({...meeting,public_url},'room','meeting'),/invalid_meeting/);
  }
  assert.throws(()=>privateMeetingUrl({...joined,expires_at:new Date(now).toISOString()},'room','meeting',now),/invalid_meeting/);
  assert.throws(()=>privateMeetingUrl({...joined,expires_at:new Date(now+126000).toISOString()},'room','meeting',now),/invalid_meeting/);
  assert.throws(()=>privateMeetingUrl({...joined,meeting:{...meeting,ended:true}},'room','meeting',now),/invalid_meeting/);
  assert.throws(()=>privateMeetingUrl(joined,'other-room','meeting',now),/invalid_meeting/);
});

function runner(store:NativeStore,transport:NativeTransport,id:()=>string){
  return new NativeChat(session,store,id,{transport,socket:()=>{
    const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
    queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
  }});
}
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
function discovery(calls=true,epoch='epoch'){
  return {...fixture.discovery,instance_id:'instance',data_epoch:epoch,capabilities:{...Object.fromEntries(Object.keys(fixture.discovery.capabilities).map(key=>[key,false])),calls}};
}
const conference=():Meeting=>({id:'meeting',room_id:'room',public_url:'https://meet.example.test/conference',created_by:'alice',expires_at:new Date(Date.now()+7200000).toISOString(),ended:false});

test('native runner rejects changed configuration, epoch, grant and view before releasing a call result',async()=>{
  for(const scenario of ['disabled','epoch','removed','hidden','stopped-join'] as const){
    const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,creerFileEcritures(),session);
    await store.applySnapshot(snapshot());let changed=false,visible=true,mutations=0;
    let chat:NativeChat;
    const transport={discover:async()=>discovery(!(changed&&scenario==='disabled'),changed&&scenario==='epoch'?'other':'epoch'),
      me:async()=>({...fixture.session.user,id:'alice'}),changes:async()=>({protocol_version:1,cursor:'initial',changes:[],has_more:false}),socketUrl:async()=>'ws://localhost/fake',
      startMeeting:async()=>{mutations++;if(scenario==='removed')await store.applyBatch({protocol_version:1,cursor:'removed',has_more:false,changes:[{type:'room_removed',data:{room_id:'room'}}]});if(scenario==='hidden')visible=false;return conference();},
      meeting:async()=>conference(),joinMeeting:async()=>{chat.stop();return {meeting:conference(),url:'https://meet.example.test/conference?jwt=a.b.c',expires_at:new Date(Date.now()+120000).toISOString()};},
    } as unknown as NativeTransport;
    chat=runner(store,transport,()=> 'operation');
    try{
      await chat.connect();changed=true;
      if(scenario==='stopped-join')await assert.rejects(chat.joinCall('meeting','room','membership'),/session_closed/);
      else await assert.rejects(chat.startCall('room','membership',()=>visible),scenario==='disabled'?/unsupported_feature/:scenario==='epoch'?/server_identity_changed/:scenario==='removed'?/delivery_revalidate/:/session_closed/);
      assert.equal(mutations,scenario==='removed'||scenario==='hidden'?1:0);
    }finally{chat.stop();await store.state();db.close();}
  }
});

test('repeated taps share a start; quota retries retain the nonce and permanent refusal clears only that attempt',async()=>{
  const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,creerFileEcritures(),session);await store.applySnapshot(snapshot());
  let mode:'hold'|'quota'|'ok'|'refused'='hold',ids=0,release:()=>void=()=>{},entered:()=>void=()=>{};
  const arrived=new Promise<void>(resolve=>{entered=resolve;}),operations:string[]=[];
  const transport={discover:async()=>discovery(),me:async()=>({...fixture.session.user,id:'alice'}),changes:async()=>({protocol_version:1,cursor:'initial',changes:[],has_more:false}),socketUrl:async()=>'ws://localhost/fake',
    startMeeting:async(_:string,input:{operation_id:string})=>{
      operations.push(input.operation_id);if(mode==='hold'){entered();await new Promise<void>(resolve=>{release=resolve;});}
      if(mode==='quota')throw new NativeError(429,'meeting_rate_limited',30);
      if(mode==='refused')throw new NativeError(403,'room_access_denied');return conference();
    },
  } as unknown as NativeTransport;
  const chat=runner(store,transport,()=> `operation-${++ids}`);
  try{
    await chat.connect();const first=chat.startCall('room','membership'),second=chat.startCall('room','membership');assert.equal(first,second);
    await arrived;release();assert.equal(await first,'meeting');assert.equal(operations.length,1);
    mode='quota';await assert.rejects(chat.startCall('room','membership'),/meeting_rate_limited/);
    const saved=db.prepare('SELECT id FROM native_meeting_intents').get()!.id;
    mode='ok';assert.equal(await chat.startCall('room','membership'),'meeting');assert.equal(operations.at(-1),saved);
    mode='refused';await assert.rejects(chat.startCall('room','membership'),/room_access_denied/);
    assert.equal(db.prepare('SELECT count(*) n FROM native_meeting_intents').get()?.n,0);
  }finally{release();chat.stop();await store.state();db.close();}
});
