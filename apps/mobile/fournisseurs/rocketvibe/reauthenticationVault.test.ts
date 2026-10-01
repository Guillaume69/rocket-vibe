import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import {NativeError} from './transport.ts';
import {ReauthenticationVault,securityKey,type ReauthenticationRemote,type SecurityScope} from './reauthenticationVault.ts';
import type {BeginReauthentication,ReauthenticationGrant,ReauthenticationStep} from './protocol.generated.ts';

const scope:SecurityScope={baseUrl:'https://example.org',user_id:'alice',device_id:'mobile',instance_id:'instance',data_epoch:'epoch'};
const hash=async(value:string)=>createHash('sha256').update(value).digest('hex');
function harness(){
  const values=new Map<string,string>(),pending=new Map<string,{input:BeginReauthentication;grant?:ReauthenticationGrant}>();
  let serial=0,head='initial',recent=false,starts=0,finishes=0,retires=0,loseStart=false,loseFinish=false,failWrite=false;
  let beforeFinish:()=>Promise<void>=async()=>{};
  const deps={hash,token:async()=>String(++serial).padStart(64,'0'),storage:{read:async(key:string)=>values.get(key)??null,write:async(key:string,value:string)=>{if(failWrite)throw new Error('Private storage unavailable');values.set(key,value);},remove:async(key:string)=>{values.delete(key);}}};
  const view=(input:BeginReauthentication):ReauthenticationStep=>({kind:'challenge',challenge:{challenge_id:input.challenge_id,methods:['totp','recovery_code'],expires_at:new Date(Date.now()+300_000).toISOString(),resend_after_seconds:0}});
  const remote:ReauthenticationRemote={status:async()=>({...scope,proof_version:head,recent}),
    begin:async input=>{starts++;assert.equal(input.proof_version,head);assert.deepEqual(input.context,{user_id:scope.user_id,device_id:scope.device_id,instance_id:scope.instance_id,data_epoch:scope.data_epoch});
      assert([...values.values()].some(raw=>JSON.parse(raw).challenge_id===input.challenge_id));assert(![...values.values()].some(raw=>raw.includes(input.password)));
      pending.set(input.challenge_id,{input});if(loseStart){loseStart=false;throw new NativeError(0,'network_or_protocol_error');}return view(input);},
    resume:async input=>{const p=pending.get(input.challenge_id);if(!p)throw new NativeError(404,'reauthentication_not_found');return p.grant?{kind:'granted',grant:p.grant}:view(p.input);},
    finish:async input=>{finishes++;assert(![...values.values()].some(raw=>raw.includes(input.code)));await beforeFinish();
      const p=pending.get(input.challenge_id);assert(p);head=`accepted-${finishes}`;recent=true;
      p.grant={...scope,factor_version:'factor',proof_version:head,authenticated_at:new Date().toISOString(),expires_at:new Date(Date.now()+900_000).toISOString()};
      if(loseFinish){loseFinish=false;throw new NativeError(0,'network_or_protocol_error');}return p.grant;},
    retire:async input=>{retires++;if(input.proof_version===head){head=`retired-${retires}`;for(const [id,p] of pending)if(!p.grant)pending.delete(id);}return {...scope,proof_version:head,recent};},
  };
  return {deps,values,pending,remote,vault:()=>new ReauthenticationVault(deps),get starts(){return starts;},get finishes(){return finishes;},get retires(){return retires;},
    set loseStart(v:boolean){loseStart=v;},set loseFinish(v:boolean){loseFinish=v;},set failWrite(v:boolean){failWrite=v;},set beforeFinish(v:()=>Promise<void>){beforeFinish=v;}};
}
test('private security scope includes canonical URL, account, family, instance and epoch',async()=>{
  const key=await securityKey(scope,hash);assert.match(key,/^native-security-[a-f0-9]{32}$/);
  assert.equal(key,await securityKey({...scope,baseUrl:'https://EXAMPLE.org:443/'},hash));
  for(const name of ['baseUrl','user_id','device_id','instance_id','data_epoch'] as const)assert.notEqual(key,await securityKey({...scope,[name]:name==='baseUrl'?'https://other.org':'other'},hash));
});
test('lost start and finish acknowledgements recover after vault recreation without another code',async()=>{
  const h=harness();h.loseStart=true;
  await assert.rejects(h.vault().prepare(scope,h.remote,'PRIVATE-PASSWORD'),/network_or_protocol_error/);
  const resumed=await h.vault().prepare(scope,h.remote);assert.equal(resumed.kind,'challenge');if(resumed.kind!=='challenge')throw new Error();
  assert.equal(h.starts,1);h.loseFinish=true;
  await assert.rejects(h.vault().finish(resumed.attempt,h.remote,'recovery_code','PRIVATE-ONE-USE-CODE'),/network_or_protocol_error/);
  assert.equal((await h.vault().finish(resumed.attempt,h.remote,'totp','')).kind,'ready');
  assert.equal(h.finishes,1);assert.equal(h.values.size,0);assert.equal(h.retires,0);
});
test('missing unresolved proof is retired before a fresh candidate can be persisted',async()=>{
  const h=harness();const first=await h.vault().prepare(scope,h.remote,'PRIVATE-PASSWORD');assert.equal(first.kind,'challenge');
  h.pending.clear();const next=await h.vault().prepare(scope,h.remote,'PRIVATE-PASSWORD');assert.equal(next.kind,'challenge');
  assert.equal(h.retires,1);assert.equal(h.starts,2);
  if(first.kind==='challenge' && next.kind==='challenge'){assert.notEqual(first.attempt.challenge_id,next.attempt.challenge_id);assert.notEqual(first.attempt.proof_version,next.attempt.proof_version);}
});
test('storage failure and unreadable storage never turn into a new HTTP mutation',async()=>{
  const h=harness();h.failWrite=true;await assert.rejects(h.vault().prepare(scope,h.remote,'PRIVATE-PASSWORD'),/Private storage unavailable/);assert.equal(h.starts,0);
  h.failWrite=false;h.values.set(`${await securityKey(scope,hash)}-reauth`,'private-corrupt-json');
  await assert.rejects(h.vault().prepare(scope,h.remote,'PRIVATE-PASSWORD'),e=>e instanceof NativeError && e.code==='invalid_native_security' && !e.message.includes('private-corrupt-json'));assert.equal(h.starts,0);
});
test('two vaults serialize completion and neither caller mutation nor stale view replaces the proof',async()=>{
  const h=harness(),first=await h.vault().prepare(scope,h.remote,'PRIVATE-PASSWORD');if(first.kind!=='challenge')throw new Error();
  let release:()=>void=()=>{};h.beforeFinish=()=>new Promise<void>(resolve=>{release=resolve;});
  const expected=structuredClone(first.attempt),finishing=h.vault().finish(expected,h.remote,'totp','123456');
  expected.challenge_id='f'.repeat(64);await setImmediate();
  const second=h.vault().prepare(scope,h.remote);await setImmediate();assert.equal(h.finishes,1);release();
  assert.equal((await finishing).kind,'ready');assert.equal((await second).kind,'ready');assert.equal(h.finishes,1);
});
test('generation cancellation keeps the durable accepted candidate for a later recovery',async()=>{
  const h=harness(),first=await h.vault().prepare(scope,h.remote,'PRIVATE-PASSWORD');if(first.kind!=='challenge')throw new Error();
  let alive=true;h.beforeFinish=async()=>{alive=false;};
  await assert.rejects(h.vault().finish(first.attempt,h.remote,'totp','123456',()=>alive),/session_closed/);
  assert.equal(h.values.size,1);assert.equal((await h.vault().prepare(scope,h.remote)).kind,'ready');assert.equal(h.finishes,1);
});
test('a different server generation is rejected before private storage or password HTTP',async()=>{
  const h=harness(),remote={...h.remote,status:async()=>({...scope,data_epoch:'different',recent:false,proof_version:'initial'})};
  await assert.rejects(h.vault().prepare(scope,remote,'PRIVATE-PASSWORD'),/server_identity_changed/);assert.equal(h.starts,0);assert.equal(h.values.size,0);
});
