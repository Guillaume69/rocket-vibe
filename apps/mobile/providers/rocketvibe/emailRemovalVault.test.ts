import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {EmailVault,type EmailRemote} from './emailVault.ts';
import type {EmailRemovalReceipt,EmailStatus,RemoveVerifiedEmail} from './protocol.generated.ts';
import {securityContext,type SecurityScope} from './reauthenticationVault.ts';
import {NativeError} from './transport.ts';

const scope:SecurityScope={baseUrl:'https://example.org',user_id:'owner',device_id:'mobile',instance_id:'instance',data_epoch:'epoch'};
function harness(){
  const values=new Map<string,string>(),receipts=new Map<string,EmailRemovalReceipt>(),bodies:RemoveVerifiedEmail[]=[];
  let serial=0,retirements=0,verificationStarts=0,contactChanges=0;
  let beforeBegin=false,loseBegin=false,proof=true,failIntent=false,failReceipt=false;
  let duringToken:()=>void=()=>{},afterCommit:()=>void=()=>{};
  let transform:(receipt:EmailRemovalReceipt)=>EmailRemovalReceipt=value=>value;
  let status:EmailStatus={context:securityContext(scope),version:'contact-1',verification_version:'head-1',address:'owner@example.org',verified_at:'2026-10-01T12:00:00Z'};
  const deps={hash:async(value:string)=>createHash('sha256').update(value).digest('hex'),token:async()=>{duringToken();return String(++serial).padStart(64,'0');},
    storage:{read:async(key:string)=>values.get(key)??null,
      write:async(key:string,value:string)=>{const record=JSON.parse(value);if((failIntent && record.accepted===null) || (failReceipt && record.accepted!==null))throw new Error('private-store-unavailable');values.set(key,value);},
      remove:async(key:string)=>{values.delete(key);}},
  };
  const rejected=()=>new NativeError(400,'email_removal_rejected');
  const remote:EmailRemote={
    status:async()=>structuredClone(status),
    begin:async input=>{verificationStarts++;return {...input,state:'pending',delivery:'queued',expires_at:'2026-10-02T12:00:00Z'};},
    resume:async()=>{throw new NativeError(400,'email_verification_rejected');},
    confirm:async()=>{throw new Error('No verification confirmation expected');},
    removed:async()=>{throw new Error('Removal must use its own retirement route');},
    removal:{
      begin:async input=>{
        const raw=[...values.values()].find(raw=>JSON.parse(raw).input.operation_id===input.operation_id);assert(raw);
        assert.deepEqual(JSON.parse(raw).input,input);assert.equal(JSON.parse(raw).kind,'removal');
        bodies.push(structuredClone(input));
        if(beforeBegin){beforeBegin=false;throw new NativeError(0,'network_or_protocol_error');}
        const existing=receipts.get(input.operation_id);if(existing)return structuredClone(existing);
        if(input.expected_version!==status.version || input.verification_version!==status.verification_version || !status.address)throw rejected();
        if(!proof)throw new NativeError(403,'reauthentication_required');
        status={...status,address:null,verified_at:null,version:`removed-${++contactChanges}`,verification_version:`committed-${contactChanges}`};
        const receipt={version:status.version,verification_version:status.verification_version,context:securityContext(scope)};
        receipts.set(input.operation_id,receipt);afterCommit();
        if(loseBegin){loseBegin=false;throw new NativeError(0,'network_or_protocol_error');}
        return transform(structuredClone(receipt));
      },
      resume:async input=>{
        const saved=receipts.get(input.operation_id);
        if(!saved || status.address || status.version!==saved.version || status.verification_version!==saved.verification_version)throw rejected();
        return transform(structuredClone(saved));
      },
      removed:async input=>{
        retirements++;
        if(status.version===input.expected_version && status.verification_version===input.verification_version)status={...status,verification_version:`retired-${retirements}`};
        return structuredClone(status);
      },
    },
  };
  return {deps,values,bodies,remote,vault:()=>new EmailVault(deps),get retirements(){return retirements;},get verificationStarts(){return verificationStarts;},
    set beforeBegin(value:boolean){beforeBegin=value;},set loseBegin(value:boolean){loseBegin=value;},set proof(value:boolean){proof=value;},
    set failIntent(value:boolean){failIntent=value;},set failReceipt(value:boolean){failReceipt=value;},set duringToken(value:()=>void){duringToken=value;},
    set afterCommit(value:()=>void){afterCommit=value;},set transform(value:(receipt:EmailRemovalReceipt)=>EmailRemovalReceipt){transform=value;},
    prune:()=>receipts.clear(),changeContact:()=>{status={...status,version:`other-${++contactChanges}`,address:'replacement@example.org',verified_at:'2026-10-02T12:00:00Z'};},
  };
}

test('a lost removal response and failed receipt write recover one committed operation without storing its former address',async()=>{
  const h=harness();h.loseBegin=true;
  const pending=await h.vault().removeContact(scope,h.remote,await h.remote.status());assert.equal(pending.kind,'removal_pending');
  assert([...h.values.values()].every(raw=>!raw.includes('@')));assert.equal(h.bodies.length,1);
  h.failReceipt=true;await assert.rejects(h.vault().resume(scope,h.remote),/private-store-unavailable/);
  h.failReceipt=false;h.proof=false;
  const removed=await h.vault().resume(scope,h.remote);if(removed.kind!=='removed')throw new Error();
  assert.equal(removed.status.address,null);assert.equal(h.bodies.length,1);
  h.prune();assert.equal((await h.vault().resume(scope,h.remote)).kind,'removed');
  await h.vault().acknowledge(scope,h.remote,removed.receipt);assert.equal(h.values.size,0);
});

test('an unreceived removal retries exactly its persisted original body',async()=>{
  const h=harness();h.beforeBegin=true;
  assert.equal((await h.vault().removeContact(scope,h.remote,await h.remote.status())).kind,'removal_pending');
  assert.equal((await h.vault().resume(scope,h.remote)).kind,'removed');
  assert.equal(h.bodies.length,2);assert.deepEqual(h.bodies[0],h.bodies[1]);
});

test('retirement never resends an unreceived removal and an old callback cannot cancel a replacement verification',async()=>{
  const h=harness();h.beforeBegin=true;
  const pending=await h.vault().removeContact(scope,h.remote,await h.remote.status());if(pending.kind!=='removal_pending')throw new Error();
  const idle=await h.vault().cancel(scope,h.remote,pending.receipt);
  assert.equal(idle.kind,'idle');assert.equal(idle.status.address,'owner@example.org');assert.equal(h.values.size,0);
  assert.equal(h.bodies.length,1);assert.equal(h.retirements,1);
  const next=await h.vault().start(scope,h.remote,'later@example.org',idle.status);assert.equal(next.kind,'pending');
  const raw=[...h.values.values()][0];
  await assert.rejects(h.vault().cancel(scope,h.remote,pending.receipt),/credentials_changed/);
  await assert.rejects(h.vault().acknowledge(scope,h.remote,pending.receipt),/credentials_changed/);
  assert.equal([...h.values.values()][0],raw);assert.equal(h.retirements,1);
});

test('a committed removal wins over cancellation after its first response was lost',async()=>{
  const h=harness();h.loseBegin=true;
  const pending=await h.vault().removeContact(scope,h.remote,await h.remote.status());if(pending.kind!=='removal_pending')throw new Error();h.proof=false;
  const accepted=await h.vault().cancel(scope,h.remote,pending.receipt);assert.equal(accepted.kind,'removed');
  assert.equal(h.bodies.length,1);assert.equal(h.values.size,1);
  assert.equal((await h.vault().cancel(scope,h.remote,pending.receipt)).kind,'removed');assert.equal(h.retirements,1);
});

test('a missing pruned receipt cannot be guessed from an empty contact or erase a later contact',async()=>{
  const h=harness();h.loseBegin=true;
  const pending=await h.vault().removeContact(scope,h.remote,await h.remote.status());if(pending.kind!=='removal_pending')throw new Error();
  h.prune();assert.equal((await h.vault().resume(scope,h.remote)).kind,'removal_stale');assert.equal(h.bodies.length,1);
  h.changeContact();const stale=await h.vault().resume(scope,h.remote);assert.equal(stale.kind,'removal_stale');
  const closed=await h.vault().cancel(scope,h.remote,pending.receipt);
  assert.equal(closed.status.address,'replacement@example.org');assert.equal(h.bodies.length,1);assert.equal(h.values.size,0);
});

test('an accepted cached receipt cannot be relabeled after replacement and closes without retiring the new contact',async()=>{
  const h=harness();const accepted=await h.vault().removeContact(scope,h.remote,await h.remote.status());if(accepted.kind!=='removed')throw new Error();
  h.prune();h.changeContact();assert.equal((await h.vault().resume(scope,h.remote)).kind,'removal_stale');
  const closed=await h.vault().cancel(scope,h.remote,accepted.receipt);
  assert.equal(closed.kind,'idle');assert.equal(closed.status.address,'replacement@example.org');assert.equal(h.retirements,0);
});

test('closing an obsolete accepted receipt needs no removal capability or new mutation',async()=>{
  const h=harness();const accepted=await h.vault().removeContact(scope,h.remote,await h.remote.status());if(accepted.kind!=='removed')throw new Error();
  h.changeContact();h.remote.removal=undefined;
  assert.equal((await h.vault().resume(scope,h.remote)).kind,'removal_stale');
  const closed=await h.vault().cancel(scope,h.remote,accepted.receipt);
  assert.equal(closed.kind,'idle');assert.equal(closed.status.address,'replacement@example.org');assert.equal(h.values.size,0);
});

test('verification and removal intents cannot replace each other across two queued vaults',async()=>{
  const h=harness(),status=await h.remote.status();
  await h.vault().start(scope,h.remote,'next@example.org',status);
  const original=[...h.values.values()][0];await assert.rejects(h.vault().removeContact(scope,h.remote,status),/credentials_changed/);
  assert.equal([...h.values.values()][0],original);assert.equal(h.bodies.length,0);
  const other=harness(),current=await other.remote.status();
  const outcomes=await Promise.allSettled([other.vault().removeContact(scope,other.remote,current),other.vault().removeContact(scope,other.remote,current)]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);assert.equal(other.bodies.length,1);
  assert.equal((await other.vault().start(scope,other.remote,'later@example.org',await other.remote.status())).kind,'removed');
  assert.equal(other.verificationStarts,0);
});

test('failed intent storage, changed displayed contact and hidden token generation prevent the HTTP mutation',async()=>{
  const h=harness();h.failIntent=true;
  await assert.rejects(h.vault().removeContact(scope,h.remote,await h.remote.status()),/private-store-unavailable/);assert.equal(h.bodies.length,0);assert.equal(h.values.size,0);
  h.failIntent=false;const displayed=await h.remote.status();h.changeContact();
  await assert.rejects(h.vault().removeContact(scope,h.remote,displayed),/credentials_changed/);assert.equal(h.bodies.length,0);
  let visible=true;h.duringToken=()=>{visible=false;};
  await assert.rejects(h.vault().removeContact(scope,h.remote,await h.remote.status(),()=>visible),/session_closed/);
  assert.equal(h.bodies.length,0);assert.equal(h.values.size,0);
});

test('a hidden completion preserves the original intent for the next visible runner',async()=>{
  const h=harness();let visible=true;h.afterCommit=()=>{visible=false;};
  await assert.rejects(h.vault().removeContact(scope,h.remote,await h.remote.status(),()=>visible),/session_closed/);
  assert.equal(h.values.size,1);assert.equal(JSON.parse([...h.values.values()][0]).accepted,null);
  visible=true;h.afterCommit=()=>{};
  assert.equal((await h.vault().resume(scope,h.remote,()=>visible)).kind,'removed');assert.equal(h.bodies.length,1);
});

test('a missing receipt with expired proof remains explicitly cancellable',async()=>{
  const h=harness();h.proof=false;
  const pending=await h.vault().removeContact(scope,h.remote,await h.remote.status());if(pending.kind!=='removal_pending')throw new Error();
  assert.equal((await h.vault().resume(scope,h.remote)).kind,'removal_pending');const before=h.bodies.length;
  const closed=await h.vault().cancel(scope,h.remote,pending.receipt);
  assert.equal(closed.status.address,'owner@example.org');assert.equal(h.bodies.length,before);assert.equal(h.values.size,0);
});

test('receipt identity, versions and malformed private records fail closed',async()=>{
  for(const variant of ['identity','same-version','same-head'] as const){
    const h=harness();const current=await h.remote.status();
    h.transform=receipt=>variant==='identity'?{...receipt,context:{...receipt.context,user_id:'other'}}:variant==='same-version'?{...receipt,version:current.version}:{...receipt,verification_version:current.verification_version};
    await assert.rejects(h.vault().removeContact(scope,h.remote,current),variant==='identity'?/server_identity_changed/:/invalid_native_security/);
    assert.equal(h.values.size,1);assert.equal(JSON.parse([...h.values.values()][0]).accepted,null);
  }
  const h=harness();h.beforeBegin=true;await h.vault().removeContact(scope,h.remote,await h.remote.status());
  const key=[...h.values.keys()][0],original=h.values.get(key)!;
  for(const change of [(value:Record<string,unknown>)=>{value.address='private@example.org';},(value:Record<string,unknown>)=>{value.accepted={version:'removed',head:42};}]){
    const value=JSON.parse(original) as Record<string,unknown>;change(value);h.values.set(key,JSON.stringify(value));
    await assert.rejects(h.vault().resume(scope,h.remote),/invalid_native_security/);assert.equal(h.bodies.length,1);
  }
});
