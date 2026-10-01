/** Disposable PostgreSQL fixture only. Never logs provisioning or bearer codes. */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { NativeError, NativeTransport } from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import { startNativeLogin } from '../apps/mobile/fournisseurs/rocketvibe/authentication.ts';
import { AuthenticationVault } from '../apps/mobile/fournisseurs/rocketvibe/authenticationVault.ts';

const base=process.argv[2];
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Requires the local disposable SQLx server');
const client=new NativeTransport(base);
const logged=await client.login('owner','factor-test-password-2026');
const setup=await client.beginFactorSetup({operation_id:'typescript-setup'});
assert.equal((await client.beginFactorSetup({operation_id:'typescript-setup'})).setup_id,setup.setup_id);
// Node's native crypto is the independent test prover. No OTP implementation is
// shipped into the mobile application; users use their authenticator app.
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
let bits='';for (const char of setup.secret) bits+=alphabet.indexOf(char).toString(2).padStart(5,'0');
const secret=Buffer.from(Array.from({length:Math.floor(bits.length/8)},(_,i)=>parseInt(bits.slice(i*8,i*8+8),2)));
const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30_000)));
const digest=createHmac('sha1',secret).update(counter).digest();
const code=String((digest.readUInt32BE(digest[19]&15)&0x7fffffff)%1_000_000).padStart(6,'0');
const backup=await client.enableFactor({setup_id:setup.setup_id,operation_id:'typescript-enable',code});
assert.equal(backup.codes.length,10);
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
await signing.disableFactor({factor_version:status.factor_version});
assert.equal((await signing.factorStatus()).totp,false);
console.log('Native TypeScript factors: enrollment, durable vault, lost ACK, concurrent recovery, fresh password proof, one-use backup and recent full-factor disable passed');
