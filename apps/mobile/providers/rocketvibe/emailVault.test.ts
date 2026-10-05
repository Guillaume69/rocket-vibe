import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {EmailVault,type EmailRemote} from './emailVault.ts';
import type {BeginEmailVerification,EmailStatus,EmailVerificationStep} from './protocol.generated.ts';
import {securityContext,securityKey,type SecurityScope} from './reauthenticationVault.ts';
import {NativeError} from './transport.ts';

const scope:SecurityScope={baseUrl:'https://example.org',user_id:'alice',device_id:'mobile',instance_id:'instance',data_epoch:'epoch'};
const code='11223344';
function harness(){
  const values=new Map<string,string>(),rows=new Map<string,EmailVerificationStep>();
  let serial=0,starts=0,confirmations=0,retirements=0,claimed=false;
  let loseBegin=false,loseConfirm=false,beforeBegin=false,failWrite=false;
  let afterConfirm:()=>void=()=>{},duringToken:()=>void=()=>{};
  let status:EmailStatus={context:securityContext(scope),version:'contact-1',verification_version:'head-1',address:null,verified_at:null};
  const deps={hash:async(value:string)=>createHash('sha256').update(value).digest('hex'),
    token:async()=>{duringToken();return String(++serial).padStart(64,'0');},
    storage:{read:async(key:string)=>values.get(key)??null,
      write:async(key:string,value:string)=>{if(failWrite)throw new Error('private-store-unavailable');values.set(key,value);},
      remove:async(key:string)=>{values.delete(key);}},
  };
  const assertSaved=(input:{verification_id:string;operation_id:string})=>assert([...values.values()].some(raw=>{
    const saved=JSON.parse(raw).input as BeginEmailVerification;return saved.verification_id===input.verification_id && saved.operation_id===input.operation_id;
  }));
  const rejected=()=>new NativeError(400,'email_verification_rejected');
  const remote:EmailRemote={
    status:async()=>structuredClone(status),
    begin:async input=>{
      assertSaved(input);starts++;
      if(input.address.includes('@@'))throw new NativeError(400,'invalid_request');
      if(beforeBegin){beforeBegin=false;throw new NativeError(0,'network_or_protocol_error');}
      const found=rows.get(input.verification_id);if(found)return structuredClone(found);
      if(claimed || input.verification_version!==status.verification_version || input.expected_version!==status.version)throw new NativeError(409,'operation_conflict');
      const pending:EmailVerificationStep={state:'pending',address:input.address,delivery:'queued',
        verification_id:input.verification_id,operation_id:input.operation_id,expected_version:input.expected_version,
        verification_version:input.verification_version,expires_at:new Date(Date.now()+900_000).toISOString()};
      claimed=true;rows.set(input.verification_id,pending);
      if(loseBegin){loseBegin=false;throw new NativeError(0,'network_or_protocol_error');}
      return structuredClone(pending);
    },
    resume:async input=>{const result=rows.get(input.verification_id);if(!result)throw rejected();return structuredClone(result);},
    confirm:async input=>{
      assertSaved(input);assert(![...values.values()].some(raw=>raw.includes(code)));
      const result=rows.get(input.verification_id);if(!result)throw rejected();
      if(result.state==='verified')return structuredClone(result);
      if(input.code!==code)throw rejected();confirmations++;
      status={...status,address:result.address,verified_at:new Date().toISOString(),version:`contact-${confirmations+1}`,verification_version:`accepted-${confirmations}`};
      const verified:EmailVerificationStep={state:'verified',address:result.address,version:status.version};
      rows.set(input.verification_id,verified);claimed=false;afterConfirm();
      if(loseConfirm){loseConfirm=false;throw new NativeError(0,'network_or_protocol_error');}
      return structuredClone(verified);
    },
    removed:async input=>{
      retirements++;
      if(input.verification_version===status.verification_version){
        status={...status,verification_version:`retired-${retirements}`};claimed=false;
        for(const [candidate,result] of rows)if(result.state==='pending')rows.delete(candidate);
      }
      return structuredClone(status);
    },
  };
  return {deps,values,rows,remote,vault:()=>new EmailVault(deps),get starts(){return starts;},get confirmations(){return confirmations;},get retirements(){return retirements;},
    set loseBegin(v:boolean){loseBegin=v;},set loseConfirm(v:boolean){loseConfirm=v;},set beforeBegin(v:boolean){beforeBegin=v;},set failWrite(v:boolean){failWrite=v;},
    set afterConfirm(v:()=>void){afterConfirm=v;},set duringToken(v:()=>void){duringToken=v;},
    prune:()=>rows.clear(),changeContact:()=>{status={...status,version:'other-contact',address:'other@example.org',verified_at:new Date().toISOString()};},
  };
}

test('lost start and confirmation ACKs resume the original candidate without persisting the entered code',async()=>{
  const h=harness(),initial=await h.remote.status();h.loseBegin=true;
  await assert.rejects(h.vault().start(scope,h.remote,'Alice@EXAMPLE.ORG',initial),/network_or_protocol_error/);
  const pending=await h.vault().resume(scope,h.remote);if(pending.kind!=='pending')throw new Error();
  assert.equal(pending.address,'Alice@example.org');assert.equal(h.starts,1);h.loseConfirm=true;
  await assert.rejects(h.vault().confirm(scope,h.remote,pending.receipt,code),/network_or_protocol_error/);
  const verified=await h.vault().resume(scope,h.remote);assert.equal(verified.kind,'verified');assert.equal(h.confirmations,1);
  assert(![...h.values.values()].some(raw=>raw.includes(code)));
  assert(!JSON.stringify(verified).includes('verification_id'));
  if(verified.kind!=='verified')throw new Error();
  assert.equal((await h.vault().acknowledge(scope,h.remote,verified.receipt)).kind,'idle');assert.equal(h.values.size,0);
});
test('an unreceived start retries only its persisted original body and a pruned reservation becomes stale',async()=>{
  const h=harness();h.beforeBegin=true;
  await assert.rejects(h.vault().start(scope,h.remote,'alice@example.org',await h.remote.status()),/network_or_protocol_error/);
  const raw=[...h.values.values()][0],candidate=JSON.parse(raw).input.verification_id;
  const pending=await h.vault().resume(scope,h.remote);assert.equal(pending.kind,'pending');assert(h.rows.has(candidate));assert.equal(h.starts,2);
  h.prune();assert.equal((await h.vault().resume(scope,h.remote)).kind,'stale');assert.equal(h.starts,2);
});

test('an unreceived verification remains closable when SMTP is disabled',async()=>{
  const h=harness();h.changeContact();h.beforeBegin=true;
  await assert.rejects(h.vault().start(scope,h.remote,'later@example.org',await h.remote.status()),/network_or_protocol_error/);
  h.remote.begin=async()=>{throw new NativeError(501,'unsupported_feature');};
  const stale=await h.vault().resume(scope,h.remote);if(stale.kind!=='stale')throw new Error();
  const closed=await h.vault().cancel(scope,h.remote,stale.receipt);
  assert.equal(closed.kind,'idle');assert.equal(closed.status.address,'other@example.org');assert.equal(h.values.size,0);
});
test('two vaults serialize a start across HTTP and cannot replace a pending address',async()=>{
  const h=harness(),initial=await h.remote.status();
  const [first,second]=await Promise.all([h.vault().start(scope,h.remote,'first@example.org',initial),h.vault().start(scope,h.remote,'second@example.org',initial)]);
  assert.equal(h.starts,1);assert.equal(first.kind,'pending');assert.equal(second.kind,'pending');
  if(first.kind!=='pending' || second.kind!=='pending')throw new Error();
  assert.equal(first.receipt,second.receipt);assert.equal(second.address,first.address);
});
test('retirement fences the old candidate and stale callbacks cannot cancel or confirm its replacement',async()=>{
  const h=harness(),old=await h.vault().start(scope,h.remote,'first@example.org',await h.remote.status());if(old.kind!=='pending')throw new Error();
  await h.vault().cancel(scope,h.remote,old.receipt);
  const next=await h.vault().start(scope,h.remote,'second@example.org',await h.remote.status());if(next.kind!=='pending')throw new Error();
  await assert.rejects(h.vault().cancel(scope,h.remote,old.receipt),/credentials_changed/);
  await assert.rejects(h.vault().confirm(scope,h.remote,old.receipt,code),/credentials_changed/);
  assert.equal(h.retirements,1);assert.equal(h.confirmations,0);assert.equal((await h.vault().resume(scope,h.remote)).kind,'pending');
});
test('accepted verification remains recoverable after its server receipt is pruned and cannot be relabeled after another device changes contact',async()=>{
  const h=harness(),pending=await h.vault().start(scope,h.remote,'first@example.org',await h.remote.status());if(pending.kind!=='pending')throw new Error();
  await h.vault().confirm(scope,h.remote,pending.receipt,code);h.prune();assert.equal((await h.vault().resume(scope,h.remote)).kind,'verified');
  h.changeContact();const view=await h.vault().resume(scope,h.remote);assert.equal(view.kind,'stale');assert.equal(view.status.address,'other@example.org');
});
test('a hidden completion keeps the original intent for a later visible resume',async()=>{
  const h=harness(),pending=await h.vault().start(scope,h.remote,'first@example.org',await h.remote.status());if(pending.kind!=='pending')throw new Error();
  let alive=true;h.afterConfirm=()=>{alive=false;};
  await assert.rejects(h.vault().confirm(scope,h.remote,pending.receipt,code,()=>alive),/session_closed/);
  assert([...h.values.values()].every(raw=>JSON.parse(raw).accepted===null));
  assert.equal((await h.vault().resume(scope,h.remote)).kind,'verified');assert.equal(h.confirmations,1);
});
test('private-store failure stops the HTTP mutation and entropy waits cannot overwrite a newer record',async()=>{
  const h=harness();h.failWrite=true;
  await assert.rejects(h.vault().start(scope,h.remote,'first@example.org',await h.remote.status()),/private-store-unavailable/);assert.equal(h.starts,0);
  h.failWrite=false;h.duringToken=()=>{h.values.set('unrelated','preserved');};
  const key=await securityKey(scope,h.deps.hash);h.duringToken=()=>{h.values.set(`${key}-email`,'newer-private-record');};
  await assert.rejects(h.vault().start(scope,h.remote,'first@example.org',await h.remote.status()),/credentials_changed/);assert.equal(h.starts,0);
});
test('malformed or cross-scope private records fail closed without revealing their content',async()=>{
  const h=harness(),key=await securityKey(scope,h.deps.hash);h.values.set(`${key}-email`,'PRIVATE-MALFORMED');
  await assert.rejects(h.vault().resume(scope,h.remote),/invalid_native_security/);assert.equal(h.starts,0);
  h.values.clear();await h.vault().start(scope,h.remote,'first@example.org',await h.remote.status());
  const raw=h.values.get(`${key}-email`)!;
  for(const changed of [{...scope,baseUrl:'https://another.example.org'},{...scope,user_id:'other'},{...scope,device_id:'other'},{...scope,instance_id:'other'},{...scope,data_epoch:'other'}]){
    h.values.set(`${await securityKey(changed,h.deps.hash)}-email`,raw);
    const remote={...h.remote,status:async()=>({...await h.remote.status(),context:securityContext(changed)})};
    await assert.rejects(h.vault().resume(changed,remote),/invalid_native_security/);
  }
  assert.equal(h.starts,1);
});
test('proxy errors and changed delivery deadlines retain the original private intent',async()=>{
  const h=harness();await h.vault().start(scope,h.remote,'first@example.org',await h.remote.status());
  const before=[...h.values.values()][0],resume=h.remote.resume;
  h.remote.resume=async()=>{throw new NativeError(400,'invalid_request');};
  await assert.rejects(h.vault().resume(scope,h.remote),/invalid_request/);
  h.remote.resume=async input=>{const result=await resume(input);if(result.state==='pending')return {...result,expires_at:new Date(Date.now()+1_800_000).toISOString()};return result;};
  await assert.rejects(h.vault().resume(scope,h.remote),/invalid_native_security/);
  assert.equal([...h.values.values()][0]===before,true);assert.equal(h.starts,1);assert.equal(h.retirements,0);
});

test('device clock correction cannot invalidate a pending response accepted by the server',async t=>{
  t.mock.timers.enable({apis:['Date']});
  const h=harness();await h.vault().start(scope,h.remote,'first@example.org',await h.remote.status());
  t.mock.timers.tick(3_600_000);
  assert.equal((await h.vault().resume(scope,h.remote)).kind,'pending');assert.equal(h.starts,1);
});

test('a rejected address remains explicitly cancellable before starting a corrected address',async()=>{
  const h=harness(),declined=await h.vault().start(scope,h.remote,'bad@@example.org',await h.remote.status());
  assert.equal(declined.kind,'stale');if(declined.kind!=='stale')throw new Error();
  assert.equal((await h.vault().resume(scope,h.remote)).kind,'stale');
  assert.equal(h.values.size,1);assert.equal(h.rows.size,0);
  assert.equal((await h.vault().cancel(scope,h.remote,declined.receipt)).kind,'idle');
  assert.equal(h.values.size,0);
  const corrected=await h.vault().start(scope,h.remote,'good@example.org',await h.remote.status());
  assert.equal(corrected.kind,'pending');assert.equal(h.rows.size,1);
});
