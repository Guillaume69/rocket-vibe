import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {FactorVault,type FactorRemote} from './factorVault.ts';
import type {SecurityScope} from './reauthenticationVault.ts';
import {NativeError} from './transport.ts';

const scope:SecurityScope={baseUrl:'https://example.org',user_id:'alice',device_id:'mobile',instance_id:'instance',data_epoch:'epoch'};
function harness(){
  const values=new Map<string,string>();let serial=0,version:string|null=null,enabled=false,enables=0,regenerations=0,disables=0,loseEnable=false,loseRegenerate=false,loseDisable=false;
  let onEnable:()=>void=()=>{},afterRegenerate:()=>void=()=>{};
  const deps={hash:async(value:string)=>createHash('sha256').update(value).digest('hex'),token:async()=>String(++serial).padStart(64,'0'),
    storage:{read:async(key:string)=>values.get(key)??null,write:async(key:string,value:string)=>{values.set(key,value);},remove:async(key:string)=>{values.delete(key);}}};
  const bags=new Map<string,{codes:string[];factor_version:string}>();
  const assertSaved=(op:string)=>assert([...values.values()].some(raw=>{const i=JSON.parse(raw).intent;return i.operation_id===op || i.enable_operation_id===op;}));
  const bag=(op:string)=>{const result={codes:Array.from({length:10},(_,i)=>`PRIVATE-BACKUP-${op}-${i}`),factor_version:`revision-${op}`};bags.set(op,result);version=result.factor_version;return result;};
  const remote:FactorRemote={proof:{status:async()=>({...scope,proof_version:'proof',recent:true}),begin:async()=>{throw new Error();},resume:async()=>{throw new Error();},finish:async()=>{throw new Error();},removed:async()=>{throw new Error();}},
    status:async()=>({totp:enabled,email:false,backup_codes_remaining:enabled?10:0,factor_version:version}),
    setup:async input=>{assertSaved(input.operation_id);return {setup_id:'setup-id',secret:'PRIVATE-TOTP-SECRET',provisioning_uri:'otpauth://totp/private',expires_at:new Date(Date.now()+600_000).toISOString()};},
    enable:async input=>{assertSaved(input.operation_id);assert(![...values.values()].some(raw=>raw.includes(input.code) && input.code));
      const saved=bags.get(input.operation_id);if(saved)return saved;
      enables++;enabled=true;const result=bag(input.operation_id);onEnable();if(loseEnable){loseEnable=false;throw new NativeError(0,'network_or_protocol_error');}return result;},
    regenerate:async input=>{assertSaved(input.operation_id);const saved=bags.get(input.operation_id);if(saved)return saved;
      assert.equal(input.factor_version,version);regenerations++;const result=bag(input.operation_id);afterRegenerate();if(loseRegenerate){loseRegenerate=false;throw new NativeError(0,'network_or_protocol_error');}return result;},
    disable:async()=>{disables++;enabled=false;version=null;if(loseDisable){loseDisable=false;throw new NativeError(0,'network_or_protocol_error');}},
  };
  return {deps,values,remote,vault:()=>new FactorVault(deps),get enables(){return enables;},get regenerations(){return regenerations;},get disables(){return disables;},
    set loseEnable(v:boolean){loseEnable=v;},set loseRegenerate(v:boolean){loseRegenerate=v;},set loseDisable(v:boolean){loseDisable=v;},set onEnable(v:()=>void){onEnable=v;},set afterRegenerate(v:()=>void){afterRegenerate=v;},changeVersion:()=>{version='another-revision';}};
}
test('setup and lost enable ACK survive recreation; original bag stays private until explicit acknowledgement',async()=>{
  const h=harness(),setup=await h.vault().start(scope,h.remote,'setup');if(setup.kind!=='setup')throw new Error();h.loseEnable=true;
  await assert.rejects(h.vault().enable(scope,h.remote,setup.setup,'123456'),/network_or_protocol_error/);
  const codes=await h.vault().resume(scope,h.remote);if(codes.kind!=='codes')throw new Error();assert.equal(h.enables,1);assert.equal(codes.codes.codes.length,10);
  assert.equal((await h.vault().resume(scope,h.remote)).kind,'codes');assert.equal(h.enables,1);
  assert.equal(await h.vault().clear(scope,'different-receipt'),false);assert.equal(h.values.size,1);
  assert.equal(await h.vault().clear(scope,codes.receipt),true);assert.equal(h.values.size,0);
});
test('regeneration retries the original version/operation after lost ACK and never replaces a second bag',async()=>{
  const h=harness(),setup=await h.vault().start(scope,h.remote,'setup');if(setup.kind!=='setup')throw new Error();
  const first=await h.vault().enable(scope,h.remote,setup.setup,'123456');if(first.kind!=='codes')throw new Error();await h.vault().clear(scope,first.receipt);
  h.loseRegenerate=true;await assert.rejects(h.vault().start(scope,h.remote,'regenerate'),/network_or_protocol_error/);
  const codes=await h.vault().resume(scope,h.remote);assert.equal(codes.kind,'codes');assert.equal(h.regenerations,1);
  assert.deepEqual(await h.vault().start(scope,h.remote,'regenerate'),codes);assert.equal(h.regenerations,1);
});
test('an intervening factor revision cannot relabel an older code bag as current',async()=>{
  const h=harness(),setup=await h.vault().start(scope,h.remote,'setup');if(setup.kind!=='setup')throw new Error();
  h.onEnable=h.changeVersion;const result=await h.vault().enable(scope,h.remote,setup.setup,'123456');assert.equal(result.kind,'stale');
  const next=await h.vault().resume(scope,h.remote);assert.equal(next.kind,'stale');assert(!JSON.stringify(next).includes('PRIVATE-BACKUP'));
});
test('lost disable ACK resumes from authoritative disabled state without repeating the mutation',async()=>{
  const h=harness(),setup=await h.vault().start(scope,h.remote,'setup');if(setup.kind!=='setup')throw new Error();
  const bag=await h.vault().enable(scope,h.remote,setup.setup,'123456');if(bag.kind!=='codes')throw new Error();await h.vault().clear(scope,bag.receipt);
  h.loseDisable=true;await assert.rejects(h.vault().start(scope,h.remote,'disable'),/network_or_protocol_error/);
  assert.equal((await h.vault().resume(scope,h.remote)).kind,'idle');assert.equal(h.disables,1);assert.equal(h.values.size,0);
});
test('cancelled factor completion retains only the original operation for later receipt recovery',async()=>{
  const h=harness(),setup=await h.vault().start(scope,h.remote,'setup');if(setup.kind!=='setup')throw new Error();
  let alive=true;h.onEnable=()=>{alive=false;};
  await assert.rejects(h.vault().enable(scope,h.remote,setup.setup,'123456',()=>alive),/session_closed/);
  assert(![...h.values.values()].some(raw=>raw.includes('PRIVATE-BACKUP')));assert.equal((await h.vault().resume(scope,h.remote)).kind,'codes');assert.equal(h.enables,1);
});
