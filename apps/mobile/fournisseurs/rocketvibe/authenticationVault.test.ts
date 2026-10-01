import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import {cleAuthentificationNative,cleE2E,cleSession} from '../../lib/clesStockage.ts';
import {AuthenticationVault,type AuthenticationStorage} from './authenticationVault.ts';
import type {LoginChallenge} from './authentication.ts';
import {NativeError} from './transport.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const hash=async(value:string)=>createHash('sha256').update(value).digest('hex');
const expires=()=>new Date(Date.now()+86_400_000).toISOString();
const challenge=():LoginChallenge=>({baseUrl:'https://example.org',instanceId:fixture.discovery.instance_id,dataEpoch:fixture.discovery.data_epoch,
  user:{...fixture.session.user},challenge:{challenge_id:'a'.repeat(64),methods:['totp','recovery_code'],expires_at:new Date(Date.now()+300_000).toISOString(),resend_after_seconds:0},pending:null});
const intent={operation_id:'b'.repeat(64),next_token:'c'.repeat(64)};
function harness() {
  const values=new Map<string,string>();let random=0,verifies=0;let committed:string|null=null;let loseAck=false;
  let beforeVerify:()=>Promise<void>=async()=>{};
  let failWrite=false;
  const storage:AuthenticationStorage={read:async key=>values.get(key)??null,write:async(key,value)=>{if(failWrite)throw new Error('Secure storage unavailable');values.set(key,value);},remove:async key=>{values.delete(key);}};
  const fetcher:typeof fetch=async(url,options)=>{
    const path=String(url);
    if(path.endsWith('/.well-known/rocketvibe'))return Response.json({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,second_factors:true,device_sessions:true}});
    if(path.endsWith('/me'))return committed
      ? Response.json(fixture.session.user)
      : Response.json({code:'session_rejected',request_id:'fixture'},{status:401});
    if(path.endsWith('/me/sessions'))return Response.json([{id:'device-one',label:'Fixture',created_at:new Date().toISOString(),last_seen_at:new Date().toISOString(),expires_at:expires(),current:true}]);
    assert(path.endsWith('/auth/factors/verify'),path);verifies++;
    const input=JSON.parse(String(options?.body));
    // The HTTP mutation must see an already durable operation and successor.
    assert([...values.values()].some(raw=>JSON.parse(raw).pending?.next_token===input.next_token));
    assert(![...values.values()].some(raw=>raw.includes('123456') || raw.includes('ONE-USE-BACKUP')));
    await beforeVerify();committed=input.next_token;
    if(loseAck){loseAck=false;throw new Error('Acknowledgement lost');}
    return Response.json({...fixture.session,token:committed,expires_at:expires()});
  };
  const dependencies={hash,storage,fetcher,token:async()=>String(++random).repeat(64)};
  return {values,storage,fetcher,dependencies,newVault:()=>new AuthenticationVault(dependencies),get verifies(){return verifies;},
    set loseAck(value:boolean){loseAck=value;},set failWrite(value:boolean){failWrite=value;},set beforeVerify(value:()=>Promise<void>){beforeVerify=value;}};
}

test('pre-auth keys isolate canonical server, username and active/E2EE namespaces',async()=>{
  const key=await cleAuthentificationNative('https://EXAMPLE.org:443/','alice',hash);
  assert.equal(key,await cleAuthentificationNative('https://example.org','alice',hash));
  assert.match(key,/^[A-Za-z0-9._-]+$/);
  for(const other of [await cleAuthentificationNative('https://other.org','alice',hash),await cleAuthentificationNative('https://example.org','bob',hash),
    await cleAuthentificationNative('https://example.org/a','bc',hash),await cleAuthentificationNative('https://example.org/ab','c',hash),
    await cleSession('https://example.org',hash),await cleE2E('https://example.org','alice',hash)])assert.notEqual(key,other);
  assert.notEqual(await cleAuthentificationNative('https://example.org/a','bc',hash),await cleAuthentificationNative('https://example.org/ab','c',hash));
});

test('lost ACK survives a new vault, blank-code retry and active-store failure without another OTP',async()=>{
  const h=harness(),saved=challenge(),vault=h.newVault();await vault.stage(saved);h.loseAck=true;
  await assert.rejects(vault.finish(saved,'recovery_code','ONE-USE-BACKUP'),/network_or_protocol_error/);
  const recreated=h.newVault();const durable=await recreated.load(saved.baseUrl,saved.user.username);assert(durable?.pending);
  const session=await recreated.finish(saved,'totp','');assert.equal(h.verifies,1);assert.equal(session.authToken,durable.pending.next_token);
  assert.equal(await recreated.clearCompleted(saved,null),false);
  assert.deepEqual(await recreated.load(saved.baseUrl,saved.user.username),durable);
  const again=await h.newVault().finish(saved,'recovery_code','');assert.equal(again.authToken,session.authToken);assert.equal(h.verifies,1);
  assert.equal(await recreated.clearCompleted(saved,session),true);assert.equal(await recreated.load(saved.baseUrl,saved.user.username),null);
});

test('two vault instances serialize the entire factor HTTP call and recover one committed session',async()=>{
  const h=harness(),saved=challenge();const first=h.newVault(),second=h.newVault();await first.stage(saved);
  let release!:()=>void,entered!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  h.beforeVerify=async()=>{entered();await blocked;};
  const one=first.finish(saved,'totp','123456');await started;
  let secondFinished=false;const two=second.finish(saved,'recovery_code','ONE-USE-BACKUP').then(value=>{secondFinished=true;return value;});
  await setImmediate();assert.equal(secondFinished,false);assert.equal(h.verifies,1);release();
  const [a,b]=await Promise.all([one,two]);assert.equal(a.authToken,b.authToken);assert.equal(h.verifies,1);
});

test('fresh password proof waits for a pending verifier and recovers its session instead of replacing the candidate',async()=>{
  const h=harness(),old=challenge(),vault=h.newVault();await vault.stage(old);
  let release!:()=>void,entered!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  h.beforeVerify=async()=>{entered();await blocked;};
  const verifying=vault.finish(old,'totp','123456');await started;
  const fresh={...challenge(),challenge:{...challenge().challenge,challenge_id:'d'.repeat(64)}};
  let staged=false;const staging=h.newVault().stage(fresh).then(value=>{staged=true;return value;});
  await setImmediate();assert.equal(staged,false);release();const session=await verifying;const step=await staging;
  assert.equal(step.kind,'session');if(step.kind==='session')assert.equal(step.session.authToken,session.authToken);
  assert.equal((await vault.load(old.baseUrl,old.user.username))?.challenge.challenge_id,old.challenge.challenge_id);
});

test('an unresolved candidate survives fresh password proofs until the old expiry/account-lock barrier',async()=>{
  const h=harness(),vault=h.newVault(),old={...challenge(),pending:intent};
  const key=await cleAuthentificationNative(old.baseUrl,old.user.username,hash);h.values.set(key,JSON.stringify(old));
  const fresh={...challenge(),challenge:{...challenge().challenge,challenge_id:'d'.repeat(64)}};
  const step=await vault.stage(fresh);assert.equal(step.kind,'challenge');
  if(step.kind==='challenge')assert.equal(step.challenge.challenge.challenge_id,old.challenge.challenge_id);
  assert.deepEqual(await vault.load(old.baseUrl,old.user.username),old);
  const expired={...old,challenge:{...old.challenge,expires_at:new Date(Date.parse(fresh.challenge.expires_at)-300_000-1).toISOString()}};
  h.values.set(key,JSON.stringify(expired));await vault.stage(fresh);
  assert.deepEqual(await vault.load(old.baseUrl,old.user.username),fresh);assert.equal(h.verifies,0);
});

test('proxy refusals, failed probes and changed identity cannot overwrite a pending candidate',async()=>{
  for(const scenario of ['proxy','network','identity','uid']){
    const h=harness(),old={...challenge(),pending:intent};const key=await cleAuthentificationNative(old.baseUrl,old.user.username,hash);h.values.set(key,JSON.stringify(old));
    const fetcher:typeof fetch=async(url,options)=>{
      if(String(url).endsWith('/me')){
        if(scenario==='network')throw new Error('Offline');
        return Response.json({message:'Proxy authentication'},{status:401});
      }
      return h.fetcher(url,options);
    };
    const vault=new AuthenticationVault({...h.dependencies,fetcher});
    const fresh={...challenge(),instanceId:scenario==='identity'?'other':old.instanceId,user:{...old.user,id:scenario==='uid'?'other':old.user.id},
      challenge:{...challenge().challenge,challenge_id:'d'.repeat(64)}};
    await assert.rejects(vault.stage(fresh));assert.deepEqual(JSON.parse(h.values.get(key)!),old);assert.equal(h.verifies,0);
  }
});

test('failed secure writes stop HTTP mutations and release the queue for a later retry',async()=>{
  const h=harness(),saved=challenge(),vault=h.newVault();await vault.stage(saved);h.failWrite=true;
  await assert.rejects(vault.finish(saved,'totp','123456'),/Secure storage unavailable/);assert.equal(h.verifies,0);
  assert.equal((await vault.load(saved.baseUrl,saved.user.username))?.pending,null);
  h.failWrite=false;const session=await h.newVault().finish(saved,'totp','123456');assert(session.authToken);assert.equal(h.verifies,1);
});

test('stale forms and cleanup cannot erase newer attempts, other accounts or a rotated active bearer',async()=>{
  const h=harness(),vault=h.newVault(),saved=challenge();await vault.stage(saved);
  const fresh={...challenge(),challenge:{...challenge().challenge,challenge_id:'d'.repeat(64)}};await vault.stage(fresh);
  await assert.rejects(vault.finish(saved,'totp','123456'),/credentials_changed/);assert.equal(h.verifies,0);
  const session=await vault.finish(fresh,'totp','123456');
  for(const activeSession of [null,{...session,authToken:'e'.repeat(64)},{...session,userId:'other'}, {...session,nativeDataEpoch:'restored'},
    {...session,genre:'rocketchat' as const},{...session,baseUrl:'https://other.org'}]){
    assert.equal(await vault.clearCompleted(fresh,activeSession),false);
  }
  assert.equal(await vault.clearCompleted(saved,session),false);
  assert.equal(await vault.clearCompleted(fresh,session),true);
});

test('malformed or cross-account vault data fails closed without leaking its raw secret or making HTTP requests',async()=>{
  const h=harness(),saved=challenge(),key=await cleAuthentificationNative(saved.baseUrl,saved.user.username,hash);
  let requests=0;const vault=new AuthenticationVault({...h.dependencies,fetcher:async()=>{requests++;throw new Error('Unexpected network');}});
  for(const raw of ['{"pending":"private-secret',JSON.stringify({...saved,user:{...saved.user,username:'other'}}),
    JSON.stringify({...saved,user:{...saved.user,password:'private-secret'}}),JSON.stringify({...saved,challenge:{...saved.challenge,expires_at:'January 1, 2099'}}),
    JSON.stringify({...saved,challenge:{...saved.challenge,resend_after_seconds:-1}})]){
    h.values.set(key,raw);
    await assert.rejects(vault.load(saved.baseUrl,saved.user.username),error=>error instanceof NativeError && error.message==='invalid_native_authentication');
    await assert.rejects(vault.stage(saved));assert.equal(h.values.get(key),raw);
  }
  assert.equal(requests,0);
});

test('callers cannot mutate a queued proof or returned record to alter a secure write',async()=>{
  const h=harness(),saved=challenge(),vault=h.newVault();
  const staging=vault.stage(saved);saved.challenge.challenge_id='d'.repeat(64);saved.user.id='other';
  const step=await staging;assert.equal(step.kind,'challenge');
  if(step.kind==='challenge'){assert.equal(step.challenge.challenge.challenge_id,'a'.repeat(64));step.challenge.user.id='altered';}
  const loaded=await vault.load(saved.baseUrl,saved.user.username);assert.equal(loaded?.user.id,fixture.session.user.id);assert.equal(loaded?.challenge.challenge_id,'a'.repeat(64));
});

test('CAS detects a secure-store change while randomness is being generated and refuses the HTTP mutation',async()=>{
  const h=harness(),saved=challenge(),key=await cleAuthentificationNative(saved.baseUrl,saved.user.username,hash);let random=0;
  const vault=new AuthenticationVault({...h.dependencies,token:async()=>{
    if(++random===2)h.values.set(key,JSON.stringify({...saved,pending:intent}));return String(random).repeat(64);
  }});
  await vault.stage(saved);await assert.rejects(vault.finish(saved,'totp','123456'),/credentials_changed/);
  assert.equal(h.verifies,0);assert.deepEqual(JSON.parse(h.values.get(key)!).pending,intent);
});
