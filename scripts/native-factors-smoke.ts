/** Disposable PostgreSQL fixture only. Never logs provisioning or bearer codes. */
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { NativeError, NativeTransport } from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';

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
let loseAck=true;
const signing=new NativeTransport(base,async(url,options)=>{
  const response=await fetch(url,options);
  if (String(url).endsWith('/auth/factors/verify') && loseAck) {
    loseAck=false;
    assert.equal(response.status,200);
    await response.text();
    throw new Error('Simulated lost acknowledgement');
  }
  return response;
});
signing.restore(logged.token);
let revoked=false;signing.surJetonRefuse=()=>{revoked=true;};
const step=await signing.startLogin('owner','factor-test-password-2026');
assert.equal(step.kind,'challenge');
if (step.kind!=='challenge') throw new Error('Missing native second factor');
assert.equal(step.user.id,logged.user.id);
const input={challenge_id:step.challenge.challenge_id,method:'recovery_code' as const,code:backup.codes[0],operation_id:'typescript-factor-login',next_token:randomBytes(32).toString('hex')};
await assert.rejects(signing.finishFactor(input),e=>e instanceof NativeError && e.status===0);
const completed=await signing.finishFactor(input);
assert.equal(completed.token,input.next_token);
assert.equal(completed.user.id,logged.user.id);
assert.equal(revoked,false);
signing.restore(completed.token);
const status=await signing.factorStatus();
assert.equal(status.backup_codes_remaining,9);
assert.equal(status.totp,true);
assert.equal(status.email,false);
assert.ok(status.factor_version);
await signing.disableFactor({factor_version:status.factor_version});
assert.equal((await signing.factorStatus()).totp,false);
console.log('Native TypeScript factors: enrollment, lost ACK, one-use backup, recent full-factor disable passed');
