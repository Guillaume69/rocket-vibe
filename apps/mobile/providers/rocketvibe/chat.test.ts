import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../lib/auth.ts';
import { createWriteQueue } from '../../db/writeQueue.ts';
import { NativeChat } from './chat.ts';
import { NativeStore } from './store.ts';
import { nativeTestDatabase } from './testDatabase.ts';
import { NativeError, NativeTransport } from './transport.ts';
import {EmailVault} from './emailVault.ts';
import {createHash} from 'node:crypto';

test('private e-mail access rejects changed identity, disabled capability and callbacks from a closed runner',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:fixture.session.user.id,username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  for(const scenario of ['normal','disabled','other-account','changed-epoch','hidden','closed-during-start'] as const){
    const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,createWriteQueue(),session);
    await store.applySnapshot({protocol_version:1,rooms:[],messages:[],cursor:'initial'});
    let visible=true,changed=false,hidden=false,mutations=0,serial=0;
    let started:()=>void=()=>{},release:()=>void=()=>{};const waiting=new Promise<void>(resolve=>{started=resolve;});
    const context={user_id:session.userId,device_id:'mobile',instance_id:session.nativeInstanceId!,data_epoch:session.nativeDataEpoch!};
    const transport={
      discover:async()=>{if(hidden)visible=false;return {...fixture.discovery,data_epoch:changed?'another-epoch':fixture.discovery.data_epoch,capabilities:{...fixture.discovery.capabilities,reauthentication:true,reauthentication_retirement:true,email_verification:scenario!=='disabled'}};},
      me:async()=>fixture.session.user,changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
      reauthenticationStatus:async()=>({...context,proof_version:'proof',recent:true}),
      emailStatus:async()=>({context:{...context,user_id:scenario==='other-account'?'other':context.user_id},version:'contact',verification_version:'head',address:null,verified_at:null}),
      beginEmailVerification:async(input:import('./protocol.generated.ts').BeginEmailVerification)=>{mutations++;started();if(scenario==='closed-during-start')await new Promise<void>(resolve=>{release=resolve;});
        return {...input,state:'pending',delivery:'queued',expires_at:new Date(Date.now()+900_000).toISOString()};},
    } as unknown as NativeTransport;
    const chat=new NativeChat(session,store,()=>{throw new Error('No send');},{transport,socket:()=>{
      const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
      queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
    }});
    const values=new Map<string,string>(),vault=new EmailVault({hash:async(value:string)=>createHash('sha256').update(value).digest('hex'),token:async()=>String(++serial).padStart(64,'0'),
      storage:{read:async key=>values.get(key)??null,write:async(key,value)=>{values.set(key,value);},remove:async key=>{values.delete(key);}}});
    try {
      await chat.connect();const access=await chat.security(()=>visible);
      if(scenario==='disabled'){await assert.rejects(vault.resume(access.scope,access.email,access.alive),/unsupported_feature/);continue;}
      if(scenario==='other-account'){await assert.rejects(vault.resume(access.scope,access.email,access.alive),/server_identity_changed/);continue;}
      const initial=await vault.resume(access.scope,access.email,access.alive);
      changed=scenario==='changed-epoch';hidden=scenario==='hidden';
      if(changed || hidden){await assert.rejects(vault.start(access.scope,access.email,'owner@example.org',initial.status,access.alive),changed?/server_identity_changed/:/session_closed/);assert.equal(values.size,0);assert.equal(mutations,0);continue;}
      const request=vault.start(access.scope,access.email,'owner@example.org',initial.status,access.alive);
      if(scenario==='closed-during-start'){await waiting;chat.stop();release();await assert.rejects(request,/session_closed/);assert.equal(values.size,1);}
      else {await request;chat.stop();await assert.rejects(access.email.status(),/session_closed/);}
      assert.equal(mutations,1);
    } finally {chat.stop();await store.state();db.close();}
  }
});

test('removal access works without SMTP or factor configuration and rejects stale runner callbacks',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:fixture.session.user.id,username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  for(const scenario of ['normal','disabled','changed-epoch','hidden','closed-during-removal'] as const){
    const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,createWriteQueue(),session);
    await store.applySnapshot({protocol_version:1,rooms:[],messages:[],cursor:'initial'});
    let visible=true,changed=false,hidden=false,mutations=0,serial=0,removed=false;
    let started:()=>void=()=>{},release:()=>void=()=>{};const waiting=new Promise<void>(resolve=>{started=resolve;});
    const context={user_id:session.userId,device_id:'mobile',instance_id:session.nativeInstanceId!,data_epoch:session.nativeDataEpoch!};
    const transport={
      discover:async()=>{if(hidden)visible=false;return {...fixture.discovery,data_epoch:changed?'another-epoch':fixture.discovery.data_epoch,capabilities:{...fixture.discovery.capabilities,reauthentication:true,reauthentication_retirement:true,second_factors:false,email_verification:false,email_removal:scenario!=='disabled'}};},
      me:async()=>fixture.session.user,changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
      reauthenticationStatus:async()=>({...context,proof_version:'proof',recent:true}),
      emailStatus:async()=>({context,version:removed?'removed-contact':'contact',verification_version:removed?'removed-head':'head',address:removed?null:'owner@example.org',verified_at:removed?null:'2026-10-01T12:00:00Z'}),
      removeVerifiedEmail:async()=>{mutations++;removed=true;started();if(scenario==='closed-during-removal')await new Promise<void>(resolve=>{release=resolve;});return {context,version:'removed-contact',verification_version:'removed-head'};},
    } as unknown as NativeTransport;
    const chat=new NativeChat(session,store,()=>{throw new Error('No send');},{transport,socket:()=>{
      const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
      queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
    }});
    const values=new Map<string,string>(),vault=new EmailVault({hash:async(value:string)=>createHash('sha256').update(value).digest('hex'),token:async()=>String(++serial).padStart(64,'0'),
      storage:{read:async key=>values.get(key)??null,write:async(key,value)=>{values.set(key,value);},remove:async key=>{values.delete(key);}}});
    try{
      await chat.connect();const access=await chat.security(()=>visible);
      if(scenario==='disabled'){assert.equal(access.email.removal,undefined);await assert.rejects(vault.resume(access.scope,access.email,access.alive),/unsupported_feature/);continue;}
      const initial=await vault.resume(access.scope,access.email,access.alive);
      await assert.rejects(access.email.begin({address:'later@example.org',verification_id:'candidate',operation_id:'operation',context,expected_version:'contact',verification_version:'head'}),/unsupported_feature/);
      changed=scenario==='changed-epoch';hidden=scenario==='hidden';
      const request=vault.removeContact(access.scope,access.email,initial.status,access.alive);
      if(changed || hidden){await assert.rejects(request,changed?/server_identity_changed/:/session_closed/);assert.equal(values.size,0);assert.equal(mutations,0);continue;}
      if(scenario==='closed-during-removal'){await waiting;chat.stop();release();await assert.rejects(request,/session_closed/);assert.equal(JSON.parse([...values.values()][0]).accepted,null);}
      else {assert.equal((await request).kind,'removed');chat.stop();await assert.rejects(access.email.status(),/session_closed/);}
      assert.equal(mutations,1);
    }finally{chat.stop();await store.state();db.close();}
  }
});

test('security callbacks pin account, epoch and runner/focus generation before and after HTTP',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:fixture.session.user.id,username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  for(const outcome of ['normal','unsupported','password-only','different-account','different-epoch','hidden-during-discovery','closed-during-mutation'] as const){
    const {db,adapter}=nativeTestDatabase();const store=new NativeStore(adapter,createWriteQueue(),session);
    await store.applySnapshot({protocol_version:1,rooms:[],messages:[],cursor:'initial'});
    let visible=true,hideDuringDiscovery=false,changedEpoch=false,mutations=0;
    let started:()=>void=()=>{},release:()=>void=()=>{};const pending=new Promise<void>(resolve=>{started=resolve;});
    const transport={
      discover:async()=>{if(hideDuringDiscovery)visible=false;return {...fixture.discovery,data_epoch:changedEpoch?'changed':fixture.discovery.data_epoch,capabilities:{...fixture.discovery.capabilities,second_factors:outcome!=='password-only',reauthentication:true,reauthentication_retirement:outcome!=='unsupported'}};},
      me:async()=>fixture.session.user,changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
      reauthenticationStatus:async()=>({user_id:outcome==='different-account'?'other':session.userId,device_id:'mobile',instance_id:session.nativeInstanceId,data_epoch:session.nativeDataEpoch,proof_version:'proof',recent:true}),
      disableFactor:async()=>{mutations++;if(outcome==='closed-during-mutation'){started();await new Promise<void>(resolve=>{release=resolve;});}},
    } as unknown as NativeTransport;
    const chat=new NativeChat(session,store,()=>{throw new Error('No send');},{transport,socket:()=>{
      const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
      queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
    }});
    try{
      await chat.connect();
      if(outcome==='unsupported'){await assert.rejects(chat.security(),/unsupported_feature/);continue;}
      if(outcome==='different-account'){await assert.rejects(chat.security(),/server_identity_changed/);continue;}
      const access=await chat.security(()=>visible);assert.equal(access.scope.device_id,'mobile');
      if(outcome==='password-only'){assert.equal((await access.remote.proof.status()).recent,true);await assert.rejects(access.remote.disable({factor_version:'factor'}),/unsupported_feature/);assert.equal(mutations,0);continue;}
      if(outcome==='different-epoch'){changedEpoch=true;await assert.rejects(access.remote.disable({factor_version:'factor'}),/server_identity_changed/);assert.equal(mutations,0);}
      else if(outcome==='hidden-during-discovery'){hideDuringDiscovery=true;await assert.rejects(access.remote.disable({factor_version:'factor'}),/session_closed/);assert.equal(mutations,0);}
      else if(outcome==='closed-during-mutation'){const request=access.remote.disable({factor_version:'factor'});await pending;chat.stop();release();await assert.rejects(request,/session_closed/);assert.equal(mutations,1);}
      else{await access.remote.disable({factor_version:'factor'});assert.equal(mutations,1);chat.stop();await assert.rejects(access.remote.disable({factor_version:'factor'}),/session_closed/);assert.equal(mutations,1);}
    }finally{chat.stop();await store.state();db.close();}
  }
});

test('device actions preserve recent-auth failures and discard replies after provider closure',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:fixture.session.user.id,username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter}=nativeTestDatabase();const store=new NativeStore(adapter,createWriteQueue(),session);
  await store.applySnapshot({protocol_version:1,rooms:[],messages:[],cursor:'initial'});
  const current={id:'device-1',label:'Mobile',created_at:'2026-10-01T00:00:00Z',last_seen_at:'2026-10-01T00:00:00Z',expires_at:'2026-11-01T00:00:00Z',current:true};
  let mutations=0;let hold=false;let started:()=>void=()=>{};const waiting=new Promise<void>(resolve=>{started=resolve;});
  let release:(devices:typeof current[])=>void=()=>{throw new Error('No device waiter');};
  const transport={
    discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,device_sessions:true}}),me:async()=>fixture.session.user,
    changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
    deviceSessions:async()=>{if(hold){started();return new Promise<typeof current[]>(resolve=>{release=resolve;});}return [current];},
    renameDevice:async(id:string,label:string)=>{assert.equal(id,current.id);current.label=label;mutations++;},
    revokeDevice:async()=>{mutations++;throw new NativeError(403,'reauthentication_required',undefined,'reauth-device');},
  } as unknown as NativeTransport;
  const chat=new NativeChat(session,store,()=>{throw new Error('No send');},{transport,socket:()=>{
    const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
    queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
  }});
  try {
    // Asked before the session is verified (a screen opened at launch): it waits for it.
    const early=chat.deviceSessions();
    await chat.connect();assert.equal((await early)[0].label,'Mobile');
    assert.equal((await chat.deviceSessions())[0].label,'Mobile');
    await chat.renameDevice(current.id,'Mobile renamed');assert.equal((await chat.deviceSessions())[0].label,'Mobile renamed');
    await assert.rejects(chat.revokeDevice(current.id),/current_device_requires_logout/);
    await assert.rejects(chat.revokeDevice('other'),e=>e instanceof NativeError && e.code==='reauthentication_required' && e.requestId==='reauth-device');
    hold=true;const read=chat.deviceSessions();await waiting;chat.stop();release([current]);await assert.rejects(read,/session_closed/);
    await assert.rejects(chat.renameDevice(current.id,'Stale callback'),/session_closed/);
    await assert.rejects(chat.revokeDevice('other'),/session_closed/);assert.equal(mutations,2);
  } finally {chat.stop();await store.state();db.close();}
});

test('secure renewal precedes replay and a stopped runner cannot adopt its delayed result',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'old-token',userId:fixture.session.user.id,username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  for (const outcome of ['success','stopped','other-account','other-server','legacy-capability'] as const) {
    const {db,adapter}=nativeTestDatabase();const store=new NativeStore(adapter,createWriteQueue(),session);
    await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[],cursor:'initial'});
    const steps:string[]=[];let token=session.authToken;
    let release:(session:Session)=>void=()=>{throw new Error('No renewal waiter');};
    let started:()=>void=()=>{};const renewing=new Promise<void>(resolve=>{started=resolve;});
    const transport={
      discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,session_rotation:outcome!=='legacy-capability'}}),
      restore:(next:string)=>{steps.push('restore');token=next;},
      me:async()=>{steps.push('me');assert.equal(token,outcome==='legacy-capability'?'old-token':'new-token');return fixture.session.user;},
      changes:async()=>{steps.push('changes');return {protocol_version:1,changes:[],cursor:'initial',has_more:false};},socketUrl:async()=>'ws://localhost/fake',
    } as unknown as NativeTransport;
    const chat=new NativeChat(session,store,()=>{throw new Error('No send expected');},{transport,credentials:async(expected)=>{
      assert.equal(expected.authToken,'old-token');steps.push('renew');started();
      if(outcome==='stopped')return new Promise<Session>(resolve=>{release=resolve;});
      return {...expected,authToken:'new-token',userId:outcome==='other-account'?'another':expected.userId,nativeInstanceId:outcome==='other-server'?'another':expected.nativeInstanceId};
    },socket:()=>{
      const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
      queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
    }});
    try {
      const connecting=chat.connect();
      if(outcome==='stopped') {
        await renewing;chat.stop();release({...session,authToken:'new-token'});await connecting;
        assert.deepEqual(steps,['renew']);assert.equal(token,'old-token');
      } else if(outcome==='other-account' || outcome==='other-server') {
        await assert.rejects(connecting,/session_rejected|server_identity_changed/);assert.deepEqual(steps,['renew']);
      } else {
        await connecting;assert(chat.status.online);
        assert.deepEqual(steps,outcome==='success'?['renew','restore','me','changes']:['me','changes']);
      }
    } finally {chat.stop();await store.state();db.close();}
  }
});

test('a persisted reaction retries one canonical intention after process restart and cannot be overwritten while pending',async () => {
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const directory=mkdtempSync(join(tmpdir(),'rv-react-command-'));
  const filename=join(directory,'account.sqlite');
  let h=nativeTestDatabase(filename);
  let store=new NativeStore(h.adapter,createWriteQueue(),session);
  await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[fixture.message],cursor:'initial'});
  let accepted=false; let ids=0;
  const calls:{operation_id:string;emoji:string;present:boolean}[]=[];
  const transport={
    discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,reactions:true}}),me:async()=>fixture.session.user,
    changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
    setReaction:async(_:string,input:{operation_id:string;emoji:string;present:boolean})=>{
      calls.push(input);
      if (!accepted) throw new NativeError(503,'response_lost');
      return {...fixture.message,revision:'9007199254740994',reactions:[{emoji:input.emoji,users:[fixture.message.author]}]};
    },
  } as unknown as NativeTransport;
  const makeChat=()=>new NativeChat(session,store,()=>`react-${++ids}`,{transport,socket:()=>{
    const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
    queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
  }});
  let chat=makeChat();
  try {
    await chat.connect();
    await assert.rejects(chat.react(fixture.room.id,fixture.message.id,'+1',true),/response_lost/);
    await assert.rejects(chat.react(fixture.room.id,fixture.message.id,':thumbsup:',true),/response_lost/);
    await assert.rejects(chat.react(fixture.room.id,fixture.message.id,':thumbsup:',false),/message_action_pending/);
    assert.equal(ids,1);
    chat.stop(); await store.state(); h.db.close();
    h=nativeTestDatabase(filename,false); store=new NativeStore(h.adapter,createWriteQueue(),session);
    accepted=true; chat=makeChat(); await chat.connect();
    assert.deepEqual(await store.pendingCommands(),[]);
    assert.equal(ids,1);
    assert.equal(calls.length,3);
    assert(calls.every(c=>c.operation_id==='react-1' && c.emoji==='thumbsup' && c.present));
    assert(h.db.prepare('SELECT reactions FROM messages WHERE id=?').get(fixture.message.id)!.reactions);
    await assert.rejects(chat.react(fixture.room.id,fixture.message.id,'constructor',true),/unknown_emoji/);
    assert.equal(calls.length,3);
  } finally {chat.stop();await store.state();h.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('pin and private star commands retain their IDs and explicit state through a SQLite restart',async () => {
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  for (const starred of [false,true]) {
    const directory=mkdtempSync(join(tmpdir(),'rv-mark-command-'));
    const filename=join(directory,'account.sqlite');
    let h=nativeTestDatabase(filename);
    let store=new NativeStore(h.adapter,createWriteQueue(),session);
    await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[fixture.message],cursor:'initial'});
    let accepted=false; let ids=0;
    const calls:{operation_id:string;present:boolean;starred:boolean}[]=[];
    const transport={
      discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,pins:true,stars:true}}),me:async()=>fixture.session.user,
      changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
      setMark:async(_:string,input:{operation_id:string;present:boolean},privateMark:boolean)=>{
        calls.push({...input,starred:privateMark});
        if (!accepted) throw new NativeError(503,'response_lost');
        return {...fixture.message,pinned:!privateMark,personal_star:{present:privateMark,revision:'9007199254740994'}};
      },
    } as unknown as NativeTransport;
    const makeChat=()=>new NativeChat(session,store,()=>`mark-${++ids}`,{transport,socket:()=>{
      const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
      queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
    }});
    let chat=makeChat();
    try {
      await chat.connect();
      await assert.rejects(chat.setMark(fixture.room.id,fixture.message.id,true,starred),/response_lost/);
      await assert.rejects(chat.setMark(fixture.room.id,fixture.message.id,false,starred),/message_action_pending/);
      chat.stop();await store.state();h.db.close();
      h=nativeTestDatabase(filename,false);store=new NativeStore(h.adapter,createWriteQueue(),session);
      accepted=true;chat=makeChat();await chat.connect();
      assert.deepEqual(await store.pendingCommands(),[]);assert.equal(ids,1);
      assert.equal(calls.length,2);
      assert(calls.every(c=>c.operation_id==='mark-1' && c.present && c.starred===starred));
      const message=h.db.prepare('SELECT pinned, starred FROM messages WHERE id=?').get(fixture.message.id)!;
      assert.equal(Boolean(message.pinned),!starred);
      assert.equal(Boolean(message.starred),starred);
    } finally {chat.stop();await store.state();h.db.close();rmSync(directory,{recursive:true,force:true});}
  }
});

test('marked lists paginate before committing and reject corrupt pages without updating the projection',async () => {
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter}=nativeTestDatabase();const store=new NativeStore(adapter,createWriteQueue(),session);
  await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[],cursor:'initial'});
  let corrupt=false;const cursors:(string|undefined)[]=[];
  const transport={
    discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,pins:true,stars:true}}),me:async()=>fixture.session.user,
    changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
    marked:async(_:string,starred:boolean,before?:string)=>{
      cursors.push(before);
      const position=before?'1':'2';
      return {messages:[{...fixture.message,id:`${corrupt?'bad':'good'}-${position}`,position,revision:position,room_id:corrupt && before?'another-room':fixture.room.id,pinned:!starred,personal_star:{present:starred,revision:position}}],has_more:!before};
    },
  } as unknown as NativeTransport;
  const chat=new NativeChat(session,store,()=>{throw new Error('No command expected');},{transport,socket:()=>{
    const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
    queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
  }});
  try {
    await chat.connect();assert.deepEqual((await chat.marked(fixture.room.id,true)).map(m=>m.id),['good-2','good-1']);
    assert.deepEqual(cursors,[undefined,'2']);
    corrupt=true;await assert.rejects(chat.marked(fixture.room.id,false),/invalid_message_page/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'bad-%'").get()!.n,0);
  } finally {chat.stop();await store.state();db.close();}
});

test('a session rejected before socket opening closes the retained provider without queuing stale sends',async () => {
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter}=nativeTestDatabase();
  const store=new NativeStore(adapter,createWriteQueue(),session);
  await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[],cursor:'initial'});
  const transport={discover:async()=>fixture.discovery,me:async()=>{throw new NativeError(401,'session_rejected');}} as unknown as NativeTransport;
  const chat=new NativeChat(session,store,()=>{throw new Error('A closed provider must not allocate an intent');},{transport,socket:()=>{throw new Error('Socket must not open');}});
  try {
    await assert.rejects(chat.connect(),/session_rejected/);
    assert.equal(chat.status.error,'session_rejected');
    await assert.rejects(chat.send(fixture.room.id,'Stale callback'),/session_closed/);
    assert.deepEqual(await store.pending(),[]);
  } finally {chat.stop();db.close();}
});

test('durable edits retry the original revision after journal delivery and stop on conflicts or session rejection',async () => {
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter}=nativeTestDatabase();
  const store=new NativeStore(adapter,createWriteQueue(),session);
  const references=[{room_id:'origin',message_id:'source',revision:'9007199254740993'}];
  const original={...fixture.message,position:'1',revision:'1',quotes:[{reference:references[0],view_position:'0',excerpt:null}]};
  await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[original],cursor:'initial'});
  const attempts:{operation_id:string;expected_revision:string;quotes:unknown[]}[]=[];
  let deleteError:NativeError|null=new NativeError(409,'revision_conflict');
  const transport={
    discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,editing:true,deletion:true,fine_permissions:true}}),me:async()=>fixture.session.user,
    changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
    editMessage:async(_:string,input:{operation_id:string;expected_revision:string;content:{markdown:string;quotes:unknown[]}})=>{
      attempts.push({operation_id:input.operation_id,expected_revision:input.expected_revision,quotes:structuredClone(input.content.quotes)});
      const edited={...original,text:input.content.markdown,revision:'2',edited_at:'2026-10-01T00:00:00Z',quotes:[]};
      if (attempts.length===1) {
        await store.applyBatch({protocol_version:1,changes:[{type:'message_upsert',data:edited}],cursor:'edited',has_more:false});
        throw new NativeError(503,'response_lost');
      }
      return edited;
    },
    deleteMessage:async()=>{ if (deleteError) throw deleteError; return {...original,text:'',deleted:true,revision:'3'}; },
  } as unknown as NativeTransport;
  const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
  let ids=0;
  const chat=new NativeChat(session,store,()=>`command-${++ids}`,{transport,socket:()=>{queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;}});
  try {
    await chat.connect();
    await assert.rejects(chat.edit(fixture.room.id,original.id,'1','Saved edit'),e=>e instanceof NativeError && e.code==='response_lost');
    assert.equal((await store.pendingCommands())[0].expected_revision,'1');
    const deadline=Date.now()+5000;
    while ((await store.pendingCommands()).length) {assert(Date.now()<deadline,'command retry stalled');await new Promise(resolve=>setTimeout(resolve,10));}
    assert.deepEqual(attempts,[{operation_id:'command-1',expected_revision:'1',quotes:references},{operation_id:'command-1',expected_revision:'1',quotes:references}]);
    await assert.rejects(chat.edit(fixture.room.id,original.id,'1','Stale words'),e=>e instanceof NativeError && e.status===409 && e.code==='revision_conflict');
    assert.equal(await store.commandDraft(original.id),'Stale words');
    assert.equal(attempts.length,2,'a stale cache precondition must preserve words without sending another body');
    await assert.rejects(chat.delete(fixture.room.id,original.id,'2'),e=>e instanceof NativeError && e.code==='revision_conflict');
    assert.equal((await store.pendingCommands()).length,0,'conflicting commands must not retry forever');
    assert.equal(db.prepare('SELECT state FROM native_commands').get()?.state,'failed');
    deleteError=new NativeError(401,'session_rejected');
    await assert.rejects(chat.delete(fixture.room.id,original.id,'2'),e=>e instanceof NativeError && e.code==='session_rejected');
    assert.equal(chat.status.error,'session_rejected');
    await assert.rejects(chat.edit(fixture.room.id,original.id,'2','Old screen'),e=>e instanceof NativeError && e.code==='session_closed');
    assert.equal((await store.pendingCommands()).length,1,'rejection preserves the unacknowledged intent for later review');
  } finally {chat.stop();await store.state();db.close();}
});

test('legacy edit intents retain their draft and stop before sending a changed operation body',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,createWriteQueue(),session);
  await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[fixture.message],cursor:'initial'});
  db.prepare("INSERT INTO native_commands(id,rid,message_id,kind,expected_revision,text) VALUES('legacy-edit',?,?,'edit',?,'Saved draft')").run(fixture.room.id,fixture.message.id,fixture.message.revision);
  let calls=0;
  const transport={
    discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,editing:true}}),me:async()=>fixture.session.user,
    changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
    editMessage:async()=>{calls++;return fixture.message;},
  } as unknown as NativeTransport;
  const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
  const chat=new NativeChat(session,store,()=> 'new-edit',{transport,socket:()=>{queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;}});
  try {
    await chat.connect();
    const deadline=Date.now()+5000;
    while((await store.pendingCommands()).length){assert(Date.now()<deadline,'legacy edit must not retry forever');await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(calls,0);assert.equal(await store.commandDraft(fixture.message.id),'Saved draft');
    assert.equal(db.prepare("SELECT error FROM native_commands WHERE id='legacy-edit'").get()!.error,'edit_intent_upgrade_required');
    await chat.edit(fixture.room.id,fixture.message.id,fixture.message.revision,'Fresh edit');
    assert.equal(calls,1);assert.equal((await store.pendingCommands()).length,0);
  }finally {chat.stop();await store.state();db.close();}
});

test('stopping during the WebSocket handshake cancels its timer and detaches every callback',async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session = {baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter} = nativeTestDatabase();
  const store = new NativeStore(adapter,createWriteQueue(),session);
  await store.applySnapshot({protocol_version:1,rooms:[],messages:[],cursor:'initial'});
  const transport = {
    discover:async () => fixture.discovery, me:async () => ({id:session.userId}),
    changes:async () => ({protocol_version:1,changes:[],cursor:'next',has_more:false}),
    socketUrl:async () => 'ws://localhost/handshake',
  } as unknown as NativeTransport;
  let closed = false;
  const socket = {readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:() => {closed = true;}} as unknown as WebSocket;
  let socketStarted:() => void = () => {};
  const started = new Promise<void>(resolve => {socketStarted = resolve;});
  const chat = new NativeChat(session,store,() => 'intent',{transport,socket:() => {socketStarted();return socket;}});
  const connecting = chat.connect();
  await started;
  chat.stop();
  let timer:ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([connecting,new Promise((_,reject) => {timer = setTimeout(() => reject(new Error('Handshake cancellation stalled')),1000);})]);
    assert.equal(closed,true);
    assert.equal(socket.onopen,null); assert.equal(socket.onclose,null);
    assert.equal(socket.onerror,null); assert.equal(socket.onmessage,null);
    assert.equal(chat.status.online,false);
  } finally { clearTimeout(timer); chat.stop(); db.close(); }
});

test('a delivery revalidation keeps the durable send pending and retries its same intention',async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session = {baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter} = nativeTestDatabase();
  const store = new NativeStore(adapter,createWriteQueue(),session);
  await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[],cursor:'initial'});
  const attempts: string[] = [];
  const transport = {
    discover:async () => fixture.discovery, me:async () => fixture.session.user,
    changes:async () => ({protocol_version:1,changes:[],cursor:'initial',has_more:false}),
    socketUrl:async () => 'ws://localhost/fake',
    send:async (_: string,input: {operation_id:string;text:string}) => {
      attempts.push(input.operation_id);
      if (attempts.length===1) throw new NativeError(409,'delivery_revalidate');
      return {...fixture.message,id:input.operation_id,text:input.text};
    },
  } as unknown as NativeTransport;
  const socket = {readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:() => {}} as unknown as WebSocket;
  const chat = new NativeChat(session,store,() => 'retained-intention',{transport,socket:() => {queueMicrotask(() => socket.onopen?.(new Event('open')));return socket;}});
  try {
    await chat.connect();
    assert.equal(chat.status.online,true);
    const id = await chat.send(fixture.room.id,'Retry after changed access');
    assert.equal((await store.pending()).length,1);
    const deadline = Date.now()+5000;
    while ((await store.pending()).length) {
      if (Date.now()>deadline) throw new Error('durable send was not retried automatically');
      await new Promise(resolve => setTimeout(resolve,10));
    }
    assert.deepEqual(attempts,[id,id]);
    assert.equal((await store.pending()).length,0);
  } finally { chat.stop(); db.close(); }
});

test('room creation keeps its persisted ID after a lost response and reuses existing discovery models',async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter}=nativeTestDatabase();
  const store=new NativeStore(adapter,createWriteQueue(),session);
  await store.applySnapshot({protocol_version:1,rooms:[],messages:[],cursor:'initial'});
  const intentions:string[]=[];
  const transport=new NativeTransport(session.baseUrl,async (url,options) => {
    const path=new URL(String(url)).pathname;
    if (path==='/.well-known/rocketvibe') return Response.json({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,idempotent_room_creation:true,room_discovery:true}});
    if (path==='/api/v1/me') return Response.json(fixture.session.user);
    if (path==='/api/v1/sync/changes') return Response.json({protocol_version:1,changes:[],cursor:'initial',has_more:false});
    if (path==='/api/v1/sync/ticket') return Response.json(fixture.socket_ticket);
    if (path==='/api/v1/rooms') {
      intentions.push(JSON.parse(String(options?.body)).operation_id);
      if (intentions.length===1) throw new Error('Response lost after commit');
      return Response.json(fixture.room);
    }
    if (path==='/api/v1/rooms/public') return Response.json(fixture.public_room_page);
    return Response.json(fixture.error,{status:404});
  });
  transport.restore(session.authToken);
  const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:() => {}} as unknown as WebSocket;
  let sequence=0;
  const chat=new NativeChat(session,store,() => `room-intent-${++sequence}`,{transport,socket:() => {queueMicrotask(() => socket.onopen?.(new Event('open')));return socket;}});
  try {
    await chat.connect();
    await assert.rejects(chat.createRoom('  Durable room  ',true),e => e instanceof NativeError && e.status===0);
    const page=await chat.publicRooms('Public');
    assert.equal(page.rooms[0].room.id,'public-room-id');
    assert.equal(await chat.createRoom('Durable room',true),fixture.room.id);
    assert.deepEqual(intentions,['room-intent-1','room-intent-1']);
    assert.equal(sequence,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM native_room_creations').get()?.n,0);
  } finally { chat.stop(); db.close(); }
});

test('an online outbox retries transient failures, honors Retry-After and cancels when suspended',async () => {
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter}=nativeTestDatabase();
  const store=new NativeStore(adapter,createWriteQueue(),session);
  await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[],cursor:'initial'});
  const calls:{id:string;at:number}[]=[];
  let permanentlyBusy=false;
  const transport={
    discover:async()=>fixture.discovery,me:async()=>fixture.session.user,
    changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
    send:async(_:string,input:{operation_id:string;text:string})=>{
      calls.push({id:input.operation_id,at:Date.now()});
      if (calls.length===1) throw new NativeError(503,'service_busy');
      if (calls.length===2 || permanentlyBusy) throw new NativeError(429,'send_busy',1,'rate-limit-request');
      return {...fixture.message,id:input.operation_id,text:input.text};
    },
  } as unknown as NativeTransport;
  const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
  let sequence=0;
  const chat=new NativeChat(session,store,()=>`retry-${++sequence}`,{transport,socket:()=>{queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;}});
  try {
    await chat.connect();
    const id=await chat.send(fixture.room.id,'Resume without a socket loss');
    assert.equal(chat.status.online,true);
    assert.equal((await store.pending()).length,1);
    const deadline=Date.now()+10_000;
    while ((await store.pending()).length) { assert(Date.now()<deadline,'online outbox did not retry'); await new Promise(resolve=>setTimeout(resolve,10)); }
    assert.deepEqual(calls.map(call=>call.id),[id,id,id]);
    assert(calls[1].at-calls[0].at>=490,'exponential retry must not spin');
    assert(calls[2].at-calls[1].at>=1000,'Retry-After must not be shortened');
    permanentlyBusy=true;
    await chat.send(fixture.room.id,'Wait across suspend');
    const before=calls.length;
    chat.suspend();
    await new Promise(resolve=>setTimeout(resolve,1300));
    assert.equal(calls.length,before,'a suspended runner must cancel its pending timer');
    permanentlyBusy=false;
    await chat.connect();
    assert.equal((await store.pending()).length,0);
  } finally { chat.stop(); db.close(); }
});

test('a failed SQLite echo retries the same committed send and a rejected session stops stale callbacks',async () => {
  const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
  const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const {db,adapter,failWhen}=nativeTestDatabase();
  const store=new NativeStore(adapter,createWriteQueue(),session);
  await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[],cursor:'initial'});
  const calls:string[]=[];
  let revoked=false;
  const transport={
    discover:async()=>fixture.discovery,me:async()=>fixture.session.user,
    changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
    send:async(_:string,input:{operation_id:string;text:string})=>{
      calls.push(input.operation_id);
      if (revoked) throw new NativeError(401,'session_rejected',undefined,'rejected-request');
      if (calls.length===1) failWhen(sql=>sql.startsWith('INSERT INTO native_positions'));
      return {...fixture.message,id:input.operation_id,text:input.text};
    },
  } as unknown as NativeTransport;
  const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
  let sequence=0;
  const chat=new NativeChat(session,store,()=>`sqlite-retry-${++sequence}`,{transport,socket:()=>{queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;}});
  try {
    await chat.connect();
    const id=await chat.send(fixture.room.id,'Accepted remotely before local commit failure');
    assert.equal((await store.pending()).length,1);
    failWhen(null);
    const deadline=Date.now()+5000;
    while ((await store.pending()).length) { assert(Date.now()<deadline); await new Promise(resolve=>setTimeout(resolve,10)); }
    assert.deepEqual(calls,[id,id]);
    revoked=true;
    await chat.send(fixture.room.id,'Session rejected');
    assert.equal(chat.status.error,'session_rejected');
    await assert.rejects(chat.send(fixture.room.id,'Stale retained view'),e=>e instanceof NativeError && e.code==='session_closed');
    assert.equal((await store.pending()).length,1);
  } finally { chat.stop(); db.close(); }
});
