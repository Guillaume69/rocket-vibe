import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {nativeAuthenticationKey,nativeEmailRecoveryKey,sessionStorageKey} from '../../lib/storageKeys.ts';
import {EmailRecoveryVault,emailRecoveryScope,emailRecoveryIntent,type EmailRecoveryIntent} from './emailRecoveryVault.ts';
import {NativeError} from './transport.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const hash=async(value:string)=>createHash('sha256').update(value).digest('hex');
const discovery={...fixture.discovery,capabilities:{...fixture.discovery.capabilities,email_recovery:true}};
function harness(){
  const values=new Map<string,string>();let random=0,posts=0,reads=0,writes=0,lose=false,failWrite=0,mode='';
  let writing:()=>Promise<void>=async()=>{};let posting:()=>Promise<void>=async()=>{};
  const fetcher:typeof fetch=async(url,options)=>{
    assert.equal(new Headers(options?.headers).has('authorization'),false);assert.equal(options?.redirect,'error');
    if(String(url).endsWith('/.well-known/rocketvibe')){
      reads++;
      return Response.json({...discovery,data_epoch:mode==='before' || mode==='staged' && reads>=2 || mode==='after' && posts>0?'changed':discovery.data_epoch,
        capabilities:{...discovery.capabilities,email_recovery:mode!=='unsupported' && !(mode==='smtp-gone' && posts>0)}});
    }
    assert.equal(String(url),'https://example.org/api/v1/auth/recovery/email/start');posts++;
    const input=JSON.parse(String(options?.body));
    const durable=[...values.values()].map(raw=>emailRecoveryIntent(JSON.parse(raw))).find(record=>record.input.operation_id===input.operation_id);
    assert(durable && !durable.accepted,'The exact command must be saved before HTTP');
    assert.equal(durable.expiresAt-durable.createdAt,3_600_000);
    await posting();if(lose){lose=false;throw new TypeError('Synthetic lost acknowledgement');}
    if(mode==='limited')return Response.json({code:'auth_rate_limited',request_id:'synthetic-limit'},{status:429,headers:{'retry-after':'60'}});
    return Response.json({accepted:mode!=='malformed'},{status:202});
  };
  const deps={hash,fetcher,token:async()=>String(++random).repeat(64),storage:{
    read:async(key:string)=>values.get(key)??null,
    write:async(key:string,value:string)=>{writes++;await writing();if(writes===failWrite)throw new Error('Synthetic secure storage refusal');values.set(key,value);},
    remove:async(key:string)=>{values.delete(key);},
  }};
  return {values,deps,scope:emailRecoveryScope('https://example.org','alice',discovery),newVault:()=>new EmailRecoveryVault(deps),
    get posts(){return posts;},get reads(){return reads;},get random(){return random;},set lose(v:boolean){lose=v;},set failWrite(v:number){failWrite=v;},set mode(v:string){mode=v;},
    set writing(v:()=>Promise<void>){writing=v;},set posting(v:()=>Promise<void>){posting=v;}};
}
const error=(code:string)=>(e:unknown)=>e instanceof NativeError && e.code===code;
async function pending(h:ReturnType<typeof harness>):Promise<EmailRecoveryIntent>{const result=await h.newVault().load(h.scope.baseUrl,h.scope.username);assert(result);return result;}

test('recovery key isolates canonical origin, URL path, username and every login namespace',async()=>{
  const first=await nativeEmailRecoveryKey('https://EXAMPLE.org:443/','alice',hash);
  assert.equal(first,await nativeEmailRecoveryKey('https://example.org','alice',hash));assert.match(first,/^[a-zA-Z0-9._-]+$/);
  for(const other of [await nativeEmailRecoveryKey('https://other.org','alice',hash),await nativeEmailRecoveryKey('https://example.org','bob',hash),
    await nativeEmailRecoveryKey('https://example.org/a','bc',hash),await nativeEmailRecoveryKey('https://example.org/ab','c',hash),
    await nativeAuthenticationKey('https://example.org','alice',hash),await sessionStorageKey('https://example.org',hash)])assert.notEqual(first,other);
  assert.notEqual(await nativeEmailRecoveryKey('https://example.org/a','bc',hash),await nativeEmailRecoveryKey('https://example.org/ab','c',hash));
});

test('lost acknowledgement resumes exactly one private command after recreation and reads send nothing',async()=>{
  const h=harness();h.lose=true;
  await assert.rejects(h.newVault().begin(h.scope),error('network_or_protocol_error'));
  const before=h.reads,saved=await pending(h);assert.equal(h.reads,before);assert.equal(saved.accepted,false);
  assert.equal(Object.keys(saved).sort().join(','),'accepted,createdAt,expiresAt,input,retryAt,scope');
  const resumed=await h.newVault().retry(saved);assert.equal(resumed.accepted,true);
  assert(resumed.input.operation_id===saved.input.operation_id && resumed.createdAt===saved.createdAt && resumed.expiresAt===saved.expiresAt);
  assert.equal(h.random,1);assert.equal(h.posts,2);
  await h.newVault().retry(saved);assert.equal(h.posts,2,'An already acknowledged request does not send again');
});

test('concurrent vault instances stage one request and cannot overwrite its receipt',async()=>{
  const h=harness();const results=await Promise.allSettled([h.newVault().begin(h.scope),h.newVault().begin(h.scope)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const rejected=results.find(r=>r.status==='rejected');assert(rejected?.status==='rejected' && error('recovery_pending')(rejected.reason));
  assert.equal(h.posts,1);assert.equal(h.random,1);assert.equal((await pending(h)).accepted,true);
});

test('secure storage must succeed before sending and an ACK write refusal retains the original intent',async()=>{
  const first=harness();first.failWrite=1;
  await assert.rejects(first.newVault().begin(first.scope));assert.equal(first.posts,0);assert.equal(first.values.size,0);
  const second=harness();second.failWrite=2;
  await assert.rejects(second.newVault().begin(second.scope));const saved=await pending(second);
  assert.equal(saved.accepted,false);assert.equal(second.posts,1);
  const resumed=await second.newVault().retry(saved);assert.equal(resumed.accepted,true);assert.equal(second.random,1);
});

test('identity and capability are pinned before staging, after durable write and after HTTP',async()=>{
  for(const mode of ['before','unsupported','staged','after','malformed']){
    const h=harness();h.mode=mode;
    await assert.rejects(h.newVault().begin(h.scope),error(mode==='unsupported'?'recovery_unavailable':mode==='malformed'?'invalid_native_recovery':'server_identity_changed'));
    assert.equal(h.posts,mode==='after'||mode==='malformed'?1:0);
    assert.equal(h.values.size,mode==='before'||mode==='unsupported'?0:1);
    if(h.values.size){const saved=await pending(h);assert.equal(saved.accepted,false);}
  }
});

test('SMTP disappearance after a generic acknowledgement does not assert or erase delivery',async()=>{
  const h=harness();h.mode='smtp-gone';const saved=await h.newVault().begin(h.scope);
  assert.equal(saved.accepted,true);assert.equal(h.posts,1);
  assert.equal((await h.newVault().retry(saved)).accepted,true);assert.equal(h.posts,1);
});

test('elapsed local TTL requires explicit dismissal and never extends the old request',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1_800_000_000_000});const h=harness();h.lose=true;
  await assert.rejects(h.newVault().begin(h.scope));const original=await pending(h);
  t.mock.timers.tick(3_600_000);
  await assert.rejects(h.newVault().retry(original),error('recovery_expired'));
  await assert.rejects(h.newVault().begin(h.scope),error('recovery_pending'));assert.equal(h.posts,1);
  assert.equal(await h.newVault().forget(original),true);const next=await h.newVault().begin(h.scope);
  assert(next.input.operation_id!==original.input.operation_id && next.createdAt>original.createdAt);assert.equal(h.posts,2);
});

test('a recreated vault honors persisted Retry-After without changing the candidate or original deadline',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1_800_000_000_000});const h=harness();h.mode='limited';
  await assert.rejects(h.newVault().begin(h.scope),error('auth_rate_limited'));const saved=await pending(h);
  assert.equal(saved.retryAt,saved.createdAt+60_000);const reads=h.reads;
  await assert.rejects(h.newVault().retry({...saved,retryAt:null}),e=>error('email_recovery_cooldown')(e) && e instanceof NativeError && e.retryAfter===60);
  assert.equal(h.posts,1);assert.equal(h.reads,reads,'An early retry does not query the network');
  t.mock.timers.tick(60_000);h.mode='';const accepted=await h.newVault().retry(saved);
  assert.equal(accepted.accepted,true);assert.equal(accepted.retryAt,null);
  assert(accepted.input.operation_id===saved.input.operation_id && accepted.expiresAt===saved.expiresAt);assert.equal(h.random,1);assert.equal(h.posts,2);
});

test('invalid or cross-account storage fails closed and never becomes a new send',async()=>{
  for(const change of [(v:EmailRecoveryIntent)=>({...v,password:'forged'}),(v:EmailRecoveryIntent)=>({...v,expiresAt:v.expiresAt+1}),
    (v:EmailRecoveryIntent)=>({...v,input:{...v.input,address:'forged@example.test'}}),
    (v:EmailRecoveryIntent)=>({...v,scope:{...v.scope,username:'bob'}})]){
    const h=harness();const saved=await h.newVault().begin(h.scope),key=await nativeEmailRecoveryKey(h.scope.baseUrl,h.scope.username,hash);
    h.values.set(key,JSON.stringify(change(saved)));const before=h.posts;
    await assert.rejects(h.newVault().load(h.scope.baseUrl,h.scope.username),error('invalid_native_recovery'));
    await assert.rejects(h.newVault().retry(saved),error('invalid_native_recovery'));assert.equal(h.posts,before);
  }
});

test('dismissal is local and an old view cannot erase or retry the next request',async()=>{
  const h=harness(),old=await h.newVault().begin(h.scope);assert.equal(await h.newVault().forget(old),true);
  const next=await h.newVault().begin(h.scope),posts=h.posts;
  assert.equal(await h.newVault().forget(old),false);await assert.rejects(h.newVault().retry(old),error('credentials_changed'));
  assert.equal(h.posts,posts);assert((await pending(h)).input.operation_id===next.input.operation_id);
});

test('closing during a real asynchronous write retains the candidate and prevents late HTTP',async()=>{
  const h=harness();let release!:()=>void,started!:()=>void,alive=true;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});
  h.writing=async()=>{started();await gate;};const running=h.newVault().begin(h.scope,()=>alive);await ready;
  alive=false;release();await assert.rejects(running,error('session_closed'));assert.equal(h.posts,0);
  h.writing=async()=>{};const saved=await pending(h);assert.equal(saved.accepted,false);
  const retried=await h.newVault().retry(saved);assert.equal(retried.accepted,true);assert.equal(h.random,1);assert.equal(h.posts,1);
});

test('closing while the server accepts preserves ambiguity for the next explicit retry',async()=>{
  const h=harness();let release!:()=>void,started!:()=>void,alive=true;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});
  h.posting=async()=>{started();await gate;};const running=h.newVault().begin(h.scope,()=>alive);await ready;
  alive=false;release();await assert.rejects(running,error('session_closed'));
  const saved=await pending(h);assert.equal(saved.accepted,false);h.posting=async()=>{};
  await h.newVault().retry(saved);assert.equal(h.posts,2);assert.equal(h.random,1);
});
