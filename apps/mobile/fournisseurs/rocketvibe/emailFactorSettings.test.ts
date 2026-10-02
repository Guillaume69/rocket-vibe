import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {FactorVault,type FactorRemote,type EmailFactorExpectation} from './factorVault.ts';
import type {EmailFactorChange,EmailStatus,FactorBackupCodes} from './protocol.generated.ts';
import type {SecurityScope} from './reauthenticationVault.ts';
import {NativeError} from './transport.ts';

const scope:SecurityScope={baseUrl:'https://example.org',user_id:'alice',device_id:'mobile',instance_id:'instance',data_epoch:'epoch'};
const context={user_id:scope.user_id,device_id:scope.device_id,instance_id:scope.instance_id,data_epoch:scope.data_epoch};
function harness(totp=false){
  const values=new Map<string,string>(),receipts=new Map<string,EmailFactorChange>();
  const bags=new Map<string,FactorBackupCodes>();
  let serial=0,email=false,version:string|null=totp?'totp-version':null,contactVersion='contact',changes=0,calls=0,smtp=true;
  let lose=false,failWrite=false,wrongEpoch=false,wrongCodes=false;let onChange:()=>void=()=>{};
  const deps={hash:async(value:string)=>createHash('sha256').update(value).digest('hex'),token:async()=>String(++serial).padStart(64,'0'),
    storage:{read:async(key:string)=>values.get(key)??null,write:async(key:string,value:string)=>{if(failWrite)throw new NativeError(0,'secure_storage_unavailable');values.set(key,value);},remove:async(key:string)=>{values.delete(key);}}};
  const unused=async():Promise<never>=>{throw new Error('Unrelated factor operation');};
  const status=async()=>({totp,email,backup_codes_remaining:totp||email?10:0,factor_version:version});
  const contact=async():Promise<EmailStatus>=>({address:'private@example.test',verified_at:'2026-10-02T00:00:00Z',version:contactVersion,verification_version:'head',context:{...context}});
  const remote:FactorRemote={proof:{status:async()=>({...context,proof_version:'proof',recent:true}),begin:unused,resume:unused,finish:unused,retire:unused},
    status,setup:unused,enable:unused,regenerate:async input=>{
      const prior=bags.get(input.operation_id);if(prior)return prior;
      assert(input.factor_version===version && (email || totp));
      assert([...values.values()].some(raw=>JSON.parse(raw).intent.operation_id===input.operation_id));
      version=`regenerated-${input.operation_id}`;
      const bag={factor_version:version,codes:Array.from({length:10},(_,i)=>`PRIVATE-REGENERATED-${i}`)};bags.set(input.operation_id,bag);return bag;
    },disable:unused,emailSettings:{status:contact,change:async(input,enabled)=>{
      calls++;assert([...values.values()].some(raw=>JSON.parse(raw).intent.operation_id===input.operation_id),'Persist before HTTP');
      const prior=receipts.get(input.operation_id);if(prior)return {...prior,codes:[...prior.codes],context:{...prior.context}};
      if(input.email_version!==contactVersion || input.factor_version!==version || email===enabled)throw new NativeError(409,'credentials_changed');
      if(enabled && !smtp)throw new NativeError(503,'email_unavailable');
      const committed=`factor-${input.operation_id}`;email=enabled;version=email||totp?committed:null;changes++;
      const receipt:EmailFactorChange={enabled,codes:enabled?Array.from({length:10},(_,i)=>`PRIVATE-BACKUP-${i}`):[],factor_version:committed,email_version:contactVersion,context:{...context}};
      receipts.set(input.operation_id,receipt);onChange();
      if(lose){lose=false;throw new NativeError(0,'network_or_protocol_error');}
      return {...receipt,codes:wrongCodes?['PRIVATE-MALFORMED']:receipt.codes,context:{...receipt.context,data_epoch:wrongEpoch?'wrong-epoch':context.data_epoch}};
    }}};
  const approval=async(enabled:boolean):Promise<EmailFactorExpectation>=>({contact:await contact(),factors:await status(),enabled});
  return {values,remote,approval,vault:()=>new FactorVault(deps),get changes(){return changes;},get calls(){return calls;},
    set lose(v:boolean){lose=v;},set failWrite(v:boolean){failWrite=v;},set smtp(v:boolean){smtp=v;},set wrongEpoch(v:boolean){wrongEpoch=v;},set wrongCodes(v:boolean){wrongCodes=v;},
    set onChange(v:()=>void){onChange=v;},changeContact:()=>{contactVersion='changed-contact';},changeProfile:()=>{version='changed-profile';}};
}
test('email factor lost enable and disable replies resume one original operation and private bag without SMTP',async()=>{
  const h=harness();h.lose=true;
  await assert.rejects(h.vault().startEmail(scope,h.remote,await h.approval(true)),/network_or_protocol_error/);
  h.smtp=false;
  const [a,b]=await Promise.all([h.vault().resume(scope,h.remote),h.vault().resume(scope,h.remote)]);
  assert(a.kind==='codes' && b.kind==='codes');assert(a.codes.factor_version===b.codes.factor_version && a.codes.codes.every((code,i)=>code===b.codes.codes[i]));
  assert.equal(h.changes,1);assert.equal(a.codes.codes.length,10);
  assert.equal((await h.vault().startEmail(scope,h.remote,await h.approval(false))).kind,'codes');assert.equal(h.changes,1);
  assert.equal(await h.vault().clear(scope,'other-receipt'),false);assert.equal(await h.vault().clear(scope,a.receipt),true);
  h.lose=true;await assert.rejects(h.vault().startEmail(scope,h.remote,await h.approval(false)),/network_or_protocol_error/);
  assert.equal((await h.vault().resume(scope,h.remote)).kind,'idle');assert.equal(h.changes,2);assert.equal(h.values.size,0);
  const status=await h.remote.status();assert(!status.email && !status.totp && status.factor_version===null);
});
test('displayed contact and installed version are checked before storing or dispatching an email change',async()=>{
  const h=harness(),contact=await h.approval(true);h.changeContact();
  await assert.rejects(h.vault().startEmail(scope,h.remote,contact),/credentials_changed/);
  const profile=await h.approval(true);h.changeProfile();
  await assert.rejects(h.vault().startEmail(scope,h.remote,profile),/invalid_native_security|credentials_changed/);
  const wrong=await h.approval(true);wrong.contact.context.device_id='other-family';
  await assert.rejects(h.vault().startEmail(scope,h.remote,wrong),/server_identity_changed/);
  assert.equal(h.changes,0);assert.equal(h.calls,0);assert.equal(h.values.size,0);
});
test('email changes fail before HTTP when storage fails or the form has already closed',async()=>{
  const h=harness(),approved=await h.approval(true);h.failWrite=true;
  await assert.rejects(h.vault().startEmail(scope,h.remote,approved),/secure_storage_unavailable/);h.failWrite=false;
  await assert.rejects(h.vault().startEmail(scope,h.remote,approved,()=>false),/session_closed/);
  assert.equal(h.calls,0);assert.equal(h.values.size,0);
});
test('closing after server acceptance keeps only the original candidate for receipt recovery',async()=>{
  const h=harness();let alive=true;h.onChange=()=>{alive=false;};
  await assert.rejects(h.vault().startEmail(scope,h.remote,await h.approval(true),()=>alive),/session_closed/);
  assert(![...h.values.values()].some(raw=>raw.includes('PRIVATE-BACKUP')));
  assert.equal((await h.vault().resume(scope,h.remote)).kind,'codes');assert.equal(h.changes,1);
});
test('concurrent email approvals keep one code bag and another profile version hides its presentation',async()=>{
  const h=harness(),approved=await h.approval(true);
  const [a,b]=await Promise.all([h.vault().startEmail(scope,h.remote,approved),h.vault().startEmail(scope,h.remote,approved)]);
  assert(a.kind==='codes' && b.kind==='codes' && a.codes.factor_version===b.codes.factor_version);assert.equal(h.changes,1);
  h.changeProfile();const stale=await h.vault().resume(scope,h.remote);assert.equal(stale.kind,'stale');assert(!JSON.stringify(stale).includes('PRIVATE-BACKUP'));
});
test('wrong receipt scope or code count cannot enter the private code-bag presentation',async()=>{
  for(const kind of ['epoch','codes']){
    const h=harness();if(kind==='epoch')h.wrongEpoch=true;else h.wrongCodes=true;
    await assert.rejects(h.vault().startEmail(scope,h.remote,await h.approval(true)),/server_identity_changed|invalid_native_security/);
    assert(![...h.values.values()].some(raw=>raw.includes('PRIVATE-BACKUP')));
    assert.equal((await h.vault().resume(scope,h.remote)).kind,'codes');assert.equal(h.changes,1);
  }
});
test('removing email leaves the other TOTP profile and original common backups available',async()=>{
  const h=harness(true);const enabled=await h.vault().startEmail(scope,h.remote,await h.approval(true));assert(enabled.kind==='codes');
  await h.vault().clear(scope,enabled.receipt);
  assert.equal((await h.vault().startEmail(scope,h.remote,await h.approval(false))).kind,'idle');
  const status=await h.remote.status();assert(status.totp && !status.email && status.factor_version!==null);assert.equal(status.backup_codes_remaining,10);
});
test('an email-only profile can regenerate the common backup bag without SMTP or TOTP',async()=>{
  const h=harness(),enabled=await h.vault().startEmail(scope,h.remote,await h.approval(true));assert(enabled.kind==='codes');
  await h.vault().clear(scope,enabled.receipt);h.smtp=false;
  const renewed=await h.vault().start(scope,h.remote,'regenerate');assert(renewed.kind==='codes');
  assert(renewed.codes.factor_version!==enabled.codes.factor_version && renewed.codes.codes.length===10);
  const status=await h.remote.status();assert(status.email && !status.totp);
});
test('corrupt private email intents are rejected before another request',async()=>{
  const h=harness();h.lose=true;await assert.rejects(h.vault().startEmail(scope,h.remote,await h.approval(true)),/network_or_protocol_error/);
  const [key,raw]=[...h.values.entries()][0],saved=JSON.parse(raw);saved.intent.unexpected='PRIVATE-EXTRA';h.values.set(key,JSON.stringify(saved));
  await assert.rejects(h.vault().resume(scope,h.remote),/invalid_native_security/);assert.equal(h.calls,1);
});
