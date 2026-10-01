/** Disposable PostgreSQL fixture only. Never logs provisioning or bearer codes. */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { NativeError, NativeTransport } from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import { startNativeLogin } from '../apps/mobile/fournisseurs/rocketvibe/authentication.ts';
import { AuthenticationVault } from '../apps/mobile/fournisseurs/rocketvibe/authenticationVault.ts';
import {FactorVault,type FactorRemote} from '../apps/mobile/fournisseurs/rocketvibe/factorVault.ts';
import {ReauthenticationVault,type SecurityScope} from '../apps/mobile/fournisseurs/rocketvibe/reauthenticationVault.ts';

const base=process.argv[2];
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Requires the local disposable SQLx server');
let loseEnableAck=true;
const client=new NativeTransport(base,async(url,options)=>{
  const response=await fetch(url,options);
  if(String(url).endsWith('/me/factors/totp/enable') && response.ok && loseEnableAck){loseEnableAck=false;await response.text();throw new Error('Lost factor enable acknowledgement');}
  return response;
});
const logged=await client.login('owner','factor-test-password-2026');
const initialProof=await client.reauthenticationStatus();
const securityScope:SecurityScope={baseUrl:base,user_id:logged.user.id,device_id:initialProof.device_id,instance_id:initialProof.instance_id,data_epoch:initialProof.data_epoch};
const privateSecurity=new Map<string,string>();
const securityDeps={hash:async(value:string)=>createHash('sha256').update(value).digest('hex'),token:async()=>randomBytes(32).toString('hex'),
  storage:{read:async(key:string)=>privateSecurity.get(key)??null,write:async(key:string,value:string)=>{privateSecurity.set(key,value);},remove:async(key:string)=>{privateSecurity.delete(key);}}};
const remoteFor=(transport:NativeTransport):FactorRemote=>({proof:{status:()=>transport.reauthenticationStatus(),begin:input=>transport.beginReauthentication(input),
  resume:input=>transport.resumeReauthentication(input),finish:input=>transport.finishReauthentication(input),retire:input=>transport.retireReauthentication(input)},
  status:()=>transport.factorStatus(),setup:input=>transport.beginFactorSetup(input),enable:input=>transport.enableFactor(input),
  regenerate:input=>transport.regenerateFactorBackups(input),disable:input=>transport.disableFactor(input)});
const factorVault=new FactorVault(securityDeps),initialRemote=remoteFor(client);
const prepared=await factorVault.start(securityScope,initialRemote,'setup');if(prepared.kind!=='setup')throw new Error('Missing private factor setup');
const setup=prepared.setup;
assert.equal((await new FactorVault(securityDeps).resume(securityScope,initialRemote)).kind,'setup');
// Node's native crypto is the independent test prover. No OTP implementation is
// shipped into the mobile application; users use their authenticator app.
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
let bits='';for (const char of setup.secret) bits+=alphabet.indexOf(char).toString(2).padStart(5,'0');
const secret=Buffer.from(Array.from({length:Math.floor(bits.length/8)},(_,i)=>parseInt(bits.slice(i*8,i*8+8),2)));
const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30_000)));
const digest=createHmac('sha1',secret).update(counter).digest();
const code=String((digest.readUInt32BE(digest[19]&15)&0x7fffffff)%1_000_000).padStart(6,'0');
await assert.rejects(factorVault.enable(securityScope,initialRemote,setup,code),e=>e instanceof NativeError && e.status===0);
const enabledReceipt=await new FactorVault(securityDeps).resume(securityScope,initialRemote);if(enabledReceipt.kind!=='codes')throw new Error('Missing private factor receipt');
const backup=enabledReceipt.codes;
assert.equal(backup.codes.length,10);
assert.equal(backup.factor_version,(await client.factorStatus()).factor_version);
assert.equal(await factorVault.clear(securityScope,'wrong-receipt'),false);
assert.equal(await factorVault.clear(securityScope,enabledReceipt.receipt),true);assert.equal(privateSecurity.size,0);
let loseAck=true,verifications=0;
const fetcher:typeof fetch=async(url,options)=>{
  const response=await fetch(url,options);
  if(String(url).endsWith('/auth/factors/verify'))verifications++;
  if (String(url).endsWith('/auth/factors/verify') && loseAck) {
    loseAck=false;
    assert.equal(response.status,200);
    await response.text();
    throw new Error('Simulated lost acknowledgement');
  }
  return response;
};
const signing=new NativeTransport(base,fetcher);
signing.restore(logged.token);
let revoked=false;signing.surJetonRefuse=()=>{revoked=true;};
const step=await startNativeLogin(base,await client.discover(),{utilisateur:'owner',motDePasse:'factor-test-password-2026'},fetcher);
assert.equal(step.kind,'challenge');
if (step.kind!=='challenge') throw new Error('Missing native second factor');
assert.equal(step.challenge.user.id,logged.user.id);
// Portable storage adapter, not an Android Keystore claim: recreating the vault
// exercises its durable JSON and process-local cross-instance serialization.
const stored=new Map<string,string>();
const deps={fetcher,hash:async(value:string)=>createHash('sha256').update(value).digest('hex'),token:async()=>randomBytes(32).toString('hex'),
  storage:{read:async(key:string)=>stored.get(key)??null,write:async(key:string,value:string)=>{stored.set(key,value);},remove:async(key:string)=>{stored.delete(key);}}};
const vault=new AuthenticationVault(deps);await vault.stage(step.challenge);
await assert.rejects(vault.finish(step.challenge,'recovery_code',backup.codes[0]),e=>e instanceof NativeError && e.status===0);
const durable=await new AuthenticationVault(deps).load(base,step.challenge.user.username);assert(durable?.pending);
assert.equal(stored.size,1);const [storageKey]=stored.keys();
durable.challenge.expires_at=new Date(Date.now()-86_400_000).toISOString();stored.set(storageKey,JSON.stringify(durable));
const [completed,concurrent]=await Promise.all([
  new AuthenticationVault(deps).finish(durable,'recovery_code',''),new AuthenticationVault(deps).finish(durable,'totp',''),
]);
assert.equal(completed.authToken,durable.pending.next_token);
assert.equal(concurrent.authToken,completed.authToken);assert.equal(verifications,1);
assert.equal(completed.userId,logged.user.id);
assert.equal(revoked,false);
assert.equal(await vault.clearCompleted(durable,null),false);assert.equal(stored.size,1);
const fresh=await startNativeLogin(base,await client.discover(),{utilisateur:'owner',motDePasse:'factor-test-password-2026'},fetcher);
assert.equal(fresh.kind,'challenge');if(fresh.kind!=='challenge')throw new Error('Missing fresh challenge');
const recovered=await new AuthenticationVault(deps).stage(fresh.challenge);
assert.equal(recovered.kind,'session');if(recovered.kind==='session')assert.equal(recovered.session.authToken,completed.authToken);
assert.equal((await vault.load(base,durable.user.username))?.challenge.challenge_id,durable.challenge.challenge_id);
assert.equal(await vault.clearCompleted(durable,completed),true);assert.equal(stored.size,0);
signing.restore(completed.authToken);
const status=await signing.factorStatus();
assert.equal(status.backup_codes_remaining,9);
assert.equal(status.totp,true);
assert.equal(status.email,false);
assert.ok(status.factor_version);
// Reauthenticate the original enrolling family, whose password-only login
// predates factor activation. Wrong proofs must keep its chat session alive.
let loseReauthStart=true,loseReauthFinish=true,reauthRevoked=false;
const reauthFetcher:typeof fetch=async(url,options)=>{
  const response=await fetch(url,options);
  const path=String(url);
  if((path.endsWith('/me/reauth/start') && loseReauthStart) || (path.endsWith('/me/reauth/finish') && response.ok && loseReauthFinish)){
    if(path.endsWith('/me/reauth/start'))loseReauthStart=false;else loseReauthFinish=false;
    assert.equal(response.status,200);await response.text();throw new Error('Simulated lost reauthentication acknowledgement');
  }
  return response;
};
const reauth=new NativeTransport(base,reauthFetcher);reauth.restore(logged.token);
reauth.surJetonRefuse=()=>{reauthRevoked=true;};
await assert.rejects(reauth.regenerateFactorBackups({factor_version:status.factor_version,operation_id:'before-reauth'}),e=>e instanceof NativeError && e.status===403);
const proofStatus=await reauth.reauthenticationStatus();assert.equal(proofStatus.recent,false);
const proofVault=new ReauthenticationVault(securityDeps),proofRemote=remoteFor(reauth).proof;
await assert.rejects(proofVault.prepare(securityScope,proofRemote,'factor-test-password-2026'),e=>e instanceof NativeError && e.status===0);
const pending=await new ReauthenticationVault(securityDeps).prepare(securityScope,proofRemote);assert.equal(pending.kind,'challenge');
if(pending.kind!=='challenge')throw new Error('Missing reauthentication challenge');
const proof={challenge_id:pending.attempt.challenge_id,operation_id:pending.attempt.operation_id};
await assert.rejects(proofVault.finish(pending.attempt,proofRemote,'recovery_code','wrong'),e=>e instanceof NativeError && e.status===400);
assert.equal(reauthRevoked,false);assert.equal((await reauth.me()).id,logged.user.id);
await assert.rejects(proofVault.finish(pending.attempt,proofRemote,'recovery_code',backup.codes[1]),e=>e instanceof NativeError && e.status===0);
const proofTransport=new NativeTransport(base);proofTransport.restore(logged.token);
assert.equal((await new ReauthenticationVault(securityDeps).finish(pending.attempt,remoteFor(proofTransport).proof,'totp','')).kind,'ready');
assert.equal(privateSecurity.size,0);
const proven=await proofTransport.resumeReauthentication(proof);assert.equal(proven.kind,'granted');
if(proven.kind!=='granted')throw new Error('Missing accepted reauthentication proof');
assert.equal(proven.grant.user_id,logged.user.id);assert.equal(proven.grant.factor_version,status.factor_version);
assert.equal('token' in proven.grant,false);
let loseRegenerationAck=true;
const regenerating=new NativeTransport(base,async(url,options)=>{
  const response=await fetch(url,options);
  if(String(url).endsWith('/me/factors/recovery/regenerate') && loseRegenerationAck){
    loseRegenerationAck=false;assert.equal(response.status,200);await response.text();
    throw new Error('Simulated lost regeneration acknowledgement');
  }
  return response;
});
regenerating.restore(logged.token);
await assert.rejects(new FactorVault(securityDeps).start(securityScope,remoteFor(regenerating),'regenerate'),e=>e instanceof NativeError && e.status===0);
// A recreated transport reuses the exact original operation/version after ACK
// loss, rather than issuing another destructive regeneration with a new ID.
const resumed=new NativeTransport(base);resumed.restore(logged.token);
const renewalReceipt=await new FactorVault(securityDeps).resume(securityScope,remoteFor(resumed));if(renewalReceipt.kind!=='codes')throw new Error('Missing regeneration receipt');
const renewedBackups=renewalReceipt.codes;
assert.equal(renewedBackups.codes.length,10);
assert.ok(renewedBackups.codes.every(c=>!backup.codes.includes(c)));
const sameReceipt=await new FactorVault(securityDeps).resume(securityScope,remoteFor(resumed));if(sameReceipt.kind!=='codes')throw new Error('Missing repeated receipt');
assert.equal(JSON.stringify(sameReceipt.codes)===JSON.stringify(renewedBackups),true);
const renewedStatus=await resumed.factorStatus();
assert.equal(renewedStatus.backup_codes_remaining,10);assert.equal(renewedStatus.totp,true);
assert.ok(renewedStatus.factor_version);assert.notEqual(renewedStatus.factor_version,status.factor_version);
assert.equal(renewedBackups.factor_version,renewedStatus.factor_version);
assert.equal(await factorVault.clear(securityScope,renewalReceipt.receipt),true);
assert.equal((await factorVault.start(securityScope,remoteFor(resumed),'disable')).kind,'idle');assert.equal(privateSecurity.size,0);
assert.equal((await resumed.factorStatus()).totp,false);
console.log('Native TypeScript factors: enrollment, durable vault, lost ACK, concurrent recovery, fresh password proof, one-use backup, reauthentication on original family, regeneration receipt and recent full-factor disable passed');
