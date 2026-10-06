import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {AuthenticationVault,type AuthenticationVaultDependencies} from './authenticationVault.ts';
import type {LoginChallenge} from './authentication.ts';
import {emailDeliveryIntent} from './factorEmailDelivery.ts';
import {NativeError} from './transport.ts';
import {ReauthenticationVault,type ReauthenticationRemote,type SecurityScope} from './reauthenticationVault.ts';
import type {AuthChallenge,FactorEmailDelivery,RequestFactorEmail} from './protocol.generated.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const hash=async(value:string)=>createHash('sha256').update(value).digest('hex');
function challenge():LoginChallenge {
  return {baseUrl:'https://example.org',instanceId:fixture.discovery.instance_id,dataEpoch:fixture.discovery.data_epoch,
    user:{...fixture.session.user},challenge:{challenge_id:'a'.repeat(64),methods:['email','recovery_code'],expires_at:new Date(Date.now()+300_000).toISOString(),resend_after_seconds:0},pending:null};
}
const deliveryStatus=(challenge:AuthChallenge,cooldown=60):FactorEmailDelivery=>({delivery:'accepted',expires_at:challenge.expires_at,resend_after_seconds:cooldown});
function authHarness(){
  const original=challenge(),values=new Map<string,string>(),sent=new Map<string,FactorEmailDelivery>(),bodies:RequestFactorEmail[]=[];
  let serial=0,loseAck=false,interruptBeforeInsert=false,failWrite=false,failReceipt=false,smtp=true,epoch=original.dataEpoch,cooldown=60;
  let beforeToken:()=>Promise<void>=async()=>{};
  const deps:AuthenticationVaultDependencies={hash,token:async()=>{await beforeToken();return (++serial).toString(16).padStart(64,'0');},
    storage:{read:async key=>values.get(key)??null,remove:async key=>{values.delete(key);},write:async(key,value)=>{
      if(failWrite || failReceipt && JSON.parse(value).email?.status)throw new Error('Secure storage unavailable');values.set(key,value);
    }},fetcher:async(url,options)=>{
      const path=new URL(String(url)).pathname;
      if(path.endsWith('/.well-known/rocketvibe'))return Response.json({...fixture.discovery,data_epoch:epoch,capabilities:{...fixture.discovery.capabilities,email_factors:true,email_factor_delivery:smtp}});
      const input=JSON.parse(String(options?.body)) as RequestFactorEmail;
      assert.equal(new Headers(options?.headers).has('authorization'),false);
      if(path.endsWith('/resume')){
        const saved=sent.get(input.delivery_id);
        return saved?Response.json({...saved,resend_after_seconds:cooldown}):Response.json({code:'factor_rejected',request_id:'fixture'},{status:400});
      }
      assert(path.endsWith('/auth/factors/email/start'));
      assert([...values.values()].some(raw=>JSON.parse(raw).email?.input.delivery_id===input.delivery_id),'candidate was durable before HTTP');
      bodies.push({...input});
      if(interruptBeforeInsert){interruptBeforeInsert=false;throw new Error('request interrupted before insertion');}
      sent.set(input.delivery_id,deliveryStatus(original.challenge));
      if(loseAck){loseAck=false;throw new Error('response lost after insertion');}
      return Response.json(sent.get(input.delivery_id));
    }};
  return {original,values,bodies,sent,deps,vault:()=>new AuthenticationVault(deps),set loseAck(v:boolean){loseAck=v;},set interrupt(v:boolean){interruptBeforeInsert=v;},
    set failWrite(v:boolean){failWrite=v;},set failReceipt(v:boolean){failReceipt=v;},set smtp(v:boolean){smtp=v;},set epoch(v:string){epoch=v;},
    set cooldown(v:number){cooldown=v;},set beforeToken(v:()=>Promise<void>){beforeToken=v;}};
}
async function staged(h:ReturnType<typeof authHarness>):Promise<LoginChallenge> {
  const step=await h.vault().stage(h.original);assert.equal(step.kind,'challenge');
  if(step.kind!=='challenge')throw new Error();return step.challenge;
}

test('login mail ACK loss survives vault restart without another mail or any persisted code',async()=>{
  const h=authHarness(),original=await staged(h);h.loseAck=true;
  await assert.rejects(h.vault().sendEmail(original));
  const restored=await h.vault().load(original.baseUrl,original.user.username);assert(restored?.email && restored.email.status===null);
  assert.equal(h.bodies.length,1);
  const resumed=await h.vault().sendEmail(restored);
  assert(resumed.email?.status?.delivery==='accepted');assert.equal(h.bodies.length,1);
  assert(h.values.size===1 && [...h.values.values()].every(raw=>!raw.includes('"code"') && !raw.includes('authToken')));
  resumed.email.input.delivery_id='caller-mutated';
  assert((await h.vault().load(original.baseUrl,original.user.username))?.email?.input.delivery_id!==resumed.email.input.delivery_id);
});
test('an interrupted initial insertion retries exactly its original delivery candidate',async()=>{
  const h=authHarness(),original=await staged(h);h.interrupt=true;
  await assert.rejects(h.vault().sendEmail(original));
  const restored=await h.vault().load(original.baseUrl,original.user.username);assert(restored);
  await h.vault().sendEmail(restored);
  assert.equal(h.bodies.length,2);assert.deepEqual(h.bodies[0],h.bodies[1]);assert.equal(h.sent.size,1);
});
test('two login vault instances share one delivery and failed secure writes cannot start SMTP',async()=>{
  const h=authHarness(),original=await staged(h);h.failWrite=true;
  await assert.rejects(h.vault().sendEmail(original));assert.equal(h.bodies.length,0);
  h.failWrite=false;
  const [a,b]=await Promise.all([h.vault().sendEmail(original),h.vault().sendEmail(original)]);
  assert(a.email?.input.delivery_id===b.email?.input.delivery_id);assert.equal(h.bodies.length,1);
});
test('a receipt write failure keeps the original candidate and reconstructs its accepted state',async()=>{
  const h=authHarness(),original=await staged(h);h.failReceipt=true;
  await assert.rejects(h.vault().sendEmail(original));assert.equal(h.bodies.length,1);
  h.failReceipt=false;
  assert((await h.vault().sendEmail(original)).email?.status?.delivery==='accepted');assert.equal(h.bodies.length,1);
});
test('explicit resend preserves the deadline, honors the server cooldown and refuses stale views',async()=>{
  const h=authHarness(),original=await staged(h),first=await h.vault().sendEmail(original);
  await assert.rejects(h.vault().sendEmail(first,true),e=>e instanceof NativeError && e.code==='email_resend_cooldown');assert.equal(h.bodies.length,1);
  h.cooldown=0;
  const next=await h.vault().sendEmail(first,true);
  assert(next.email?.input.delivery_id!==first.email?.input.delivery_id);
  assert.equal(next.email?.status?.expires_at,first.challenge.expires_at);assert.equal(h.bodies.length,2);
  await assert.rejects(h.vault().sendEmail(first,true),e=>e instanceof NativeError && e.code==='credentials_changed');assert.equal(h.bodies.length,2);
});
test('new password proof preserves a pending mail until the original challenge expiry barrier',async()=>{
  const h=authHarness(),original=await staged(h),sent=await h.vault().sendEmail(original);
  const fresh=challenge();fresh.challenge.challenge_id='d'.repeat(64);fresh.challenge.expires_at=original.challenge.expires_at;
  const kept=await h.vault().stage(fresh);assert(kept.kind==='challenge' && kept.challenge.email?.input.delivery_id===sent.email?.input.delivery_id);
  fresh.challenge.expires_at=new Date(Date.parse(original.challenge.expires_at)+300_001).toISOString();
  const replaced=await h.vault().stage(fresh);assert(replaced.kind==='challenge' && replaced.challenge.challenge.challenge_id===fresh.challenge.challenge_id && !replaced.challenge.email);
});
test('closed forms, changed server epochs and external secure-store changes cannot start a new mail',async()=>{
  const h=authHarness(),original=await staged(h);
  await assert.rejects(h.vault().sendEmail(original,false,()=>false));assert.equal(h.bodies.length,0);
  h.epoch='restored';await assert.rejects(h.vault().sendEmail(original),e=>e instanceof NativeError && e.code==='server_identity_changed');assert.equal(h.bodies.length,0);
  h.epoch=original.dataEpoch;h.beforeToken=async()=>{for(const [key,raw] of h.values){const record=JSON.parse(raw);record.user.id='another-account';h.values.set(key,JSON.stringify(record));}};
  await assert.rejects(h.vault().sendEmail(original),e=>e instanceof NativeError && e.code==='credentials_changed');assert.equal(h.bodies.length,0);
});
test('SMTP disappearance still permits read-only recovery of an already delivered login code',async()=>{
  const h=authHarness(),original=await staged(h),first=await h.vault().sendEmail(original);h.smtp=false;
  assert((await h.vault().sendEmail(first)).email?.status?.delivery==='accepted');assert.equal(h.bodies.length,1);
});
test('delivery metadata rejects forged fields, reused candidates and an extended expiry without exposing raw storage',()=>{
  const c=challenge().challenge;
  const intent={input:{challenge_id:c.challenge_id,delivery_id:'b'.repeat(64),operation_id:'c'.repeat(64)},status:deliveryStatus(c)};
  for(const value of [{...intent,code:'private-code'},
    {...intent,status:{...intent.status,code:'private-code'}},
    {...intent,input:{...intent.input,address:'private-address@example.test'}},
    {...intent,input:{...intent.input,delivery_id:c.challenge_id}},
    {...intent,status:{...intent.status,resend_after_seconds:61}},
    {...intent,status:{...intent.status,expires_at:new Date(Date.parse(c.expires_at)+1000).toISOString()}}]) {
    assert.throws(()=>emailDeliveryIntent(value,c),e=>e instanceof NativeError && e.code==='invalid_native_security' && !e.message.includes('private'));
  }
});

function proofHarness(){
  const scope:SecurityScope={baseUrl:'https://example.org',user_id:'alice',device_id:'device',instance_id:'instance',data_epoch:'epoch'};
  const values=new Map<string,string>(),sent=new Map<string,FactorEmailDelivery>();let serial=10,starts=0,loseAck=false,smtp=true,recent=false,head='initial';
  let c:AuthChallenge|null=null;
  const deps={hash,token:async()=>String(++serial).padStart(64,'0'),storage:{read:async(key:string)=>values.get(key)??null,
    write:async(key:string,value:string)=>{values.set(key,value);},remove:async(key:string)=>{values.delete(key);}}};
  const remote:ReauthenticationRemote={
    status:async()=>({...scope,proof_version:head,recent}),
    begin:async input=>{c={challenge_id:input.challenge_id,methods:['email','recovery_code'],expires_at:new Date(Date.now()+300_000).toISOString(),resend_after_seconds:0};return {kind:'challenge',challenge:c};},
    resume:async()=>{assert(c);return {kind:'challenge',challenge:{...c,methods:smtp?['email','recovery_code']:['recovery_code']}};},
    removed:async()=>{throw new Error('unexpected retirement');},
    finish:async input=>{assert(input.method==='email' && input.code==='12345678');recent=true;head='accepted';
      return {...scope,factor_version:'factor',proof_version:head,authenticated_at:new Date().toISOString(),expires_at:new Date(Date.now()+900_000).toISOString()};},
    email:{
      begin:async input=>{assert(c);assert(smtp);starts++;assert([...values.values()].some(raw=>JSON.parse(raw).email?.input.delivery_id===input.delivery_id));
        const status=deliveryStatus(c);sent.set(input.delivery_id,status);if(loseAck){loseAck=false;throw new NativeError(0,'network_or_protocol_error');}return status;},
      resume:async input=>{const result=sent.get(input.delivery_id);if(!result)throw new NativeError(400,'factor_rejected');return result;},
    },
  };
  return {scope,deps,values,remote,vault:()=>new ReauthenticationVault(deps),get starts(){return starts;},set loseAck(v:boolean){loseAck=v;},set smtp(v:boolean){smtp=v;}};
}
test('same-family proof mail survives process restart and is accepted after SMTP disappears',async()=>{
  const h=proofHarness(),first=await h.vault().prepare(h.scope,h.remote,'private-password');assert(first.kind==='challenge');h.loseAck=true;
  await assert.rejects(h.vault().sendEmail(first.attempt,h.remote));assert.equal(h.starts,1);
  const restored=await h.vault().prepare(h.scope,h.remote);assert(restored.kind==='challenge' && restored.attempt.email);
  const resumed=await h.vault().sendEmail(restored.attempt,h.remote);assert(resumed.kind==='challenge' && resumed.attempt.email?.status);assert.equal(h.starts,1);
  h.smtp=false;
  const withoutSmtp=await h.vault().prepare(h.scope,h.remote);assert(withoutSmtp.kind==='challenge' && withoutSmtp.attempt.challenge?.methods.includes('email'));
  const accepted=await h.vault().finish(withoutSmtp.attempt,h.remote,'email','12345678');assert.equal(accepted.kind,'ready');
  assert.equal(h.values.size,0);assert.equal(h.starts,1);
});
test('proof delivery is serialized with proof completion and rejects another family or hidden form',async()=>{
  const h=proofHarness(),first=await h.vault().prepare(h.scope,h.remote,'private-password');assert(first.kind==='challenge');
  await assert.rejects(h.vault().sendEmail(first.attempt,h.remote,false,()=>false));assert.equal(h.starts,0);
  await assert.rejects(h.vault().sendEmail({...first.attempt,scope:{...h.scope,device_id:'other-device'}},h.remote));assert.equal(h.starts,0);
  const [a,b]=await Promise.all([h.vault().sendEmail(first.attempt,h.remote),h.vault().sendEmail(first.attempt,h.remote)]);
  assert(a.kind==='challenge' && b.kind==='challenge' && a.attempt.email?.input.delivery_id===b.attempt.email?.input.delivery_id);
  assert.equal(h.starts,1);assert([...h.values.values()].every(raw=>!raw.includes('private-password') && !raw.includes('12345678')));
});
