import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createCipheriv,createPrivateKey,createPublicKey,diffieHellman,createHmac } from 'node:crypto';
import { Pairing } from './handoff.ts';
import { TeamsError,messageText,parseHistory,discoverRoutes } from './protocol.ts';
import { TeamsReader } from './reader.ts';

// Node and Quick Crypto accept private KeyObjects; the current Node typings omit that overload.
const publicOf = createPublicKey as unknown as (key: import('crypto').KeyObject | Parameters<typeof createPublicKey>[0]) => import('crypto').KeyObject;
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/fixtures/teams-handoff.json',import.meta.url),'utf8'));
const fresh=()=>new Pairing(Buffer.from(fixture.privateKey,'base64url'));
const reads=JSON.parse(readFileSync(new URL('../../../../docs/protocol/fixtures/teams-read.json',import.meta.url),'utf8'));
test('native-compatible AEAD opens the shared Rust vector and keeps access tokens opaque',()=>{
  const session=fresh().open(fixture.code,fixture.now);assert.equal(session.tokens.chat,'synthetic-chat');assert.equal(session.account.accountId,'synthetic-account');assert.equal(new Pairing().code().length,43);
});
test('wrong pairing key, tag corruption, malformed encoding and transfer expiry fail safely',()=>{
  for(const [key,code,now] of [[new Pairing(),fixture.code,fixture.now],[fresh(),fixture.code.slice(0,-8)+'ABCD1234',fixture.now],[fresh(),fixture.code+'=',fixture.now],[fresh(),fixture.code,fixture.now+300001]]) {
    assert.throws(()=>(key as Pairing).open(code as string,now as number),e=>e instanceof TeamsError&&!e.message.includes('synthetic'));
  }
});
test('recipient refuses invalid identity, overlong token life and token header injection',()=>{
  const baseline=fresh().open(fixture.code,fixture.now);
  const seal=(patch:Record<string,unknown>)=>{
    const prefix=Buffer.from('302e020100300506032b656e04220420','hex');
    const receiver=createPrivateKey({key:Buffer.concat([prefix,Buffer.from(fixture.privateKey,'base64url')]),type:'pkcs8',format:'der'}),sender=createPrivateKey({key:Buffer.concat([prefix,Buffer.alloc(32,9)]),type:'pkcs8',format:'der'});
    const recipient=Buffer.from(publicOf(receiver).export({type:'spki',format:'der'})).subarray(-32),peer=Buffer.from(publicOf(sender).export({type:'spki',format:'der'})).subarray(-32);
    const shared=diffieHellman({privateKey:sender,publicKey:publicOf(receiver)}),prk=createHmac('sha256',Buffer.alloc(32)).update(shared).digest();
    const key=createHmac('sha256',prk).update('rocketvibe-teams-handoff-v2').update(recipient).update(peer).update(Buffer.from([1])).digest(),nonce=Buffer.alloc(12,4),c=createCipheriv('aes-256-gcm',key,nonce);c.setAAD(Buffer.from('rocketvibe-teams-handoff-v2'));
    const raw={version:1,...baseline,transferExpiresAt:fixture.now+300000,...patch};const value=Buffer.concat([c.update(JSON.stringify(raw)),c.final(),c.getAuthTag()]);return 'rvteams2.'+peer.toString('base64url')+'.'+nonce.toString('base64url')+'.'+value.toString('base64url');
  };
  for(const patch of [{expiresAt:fixture.now+86400001},{account:{tenantId:'wrong',accountId:'test'}},{tokens:{...baseline.tokens,chat:'secret\r\nInjected: value'}}])assert.throws(()=>fresh().open(seal(patch),fixture.now),TeamsError);
});
test('expired imported sessions never produce network traffic',async()=>{
  let calls=0;const session=fresh().open(fixture.code,fixture.now);
  const reader=new TeamsReader(session.account,session.tokens,async()=>{calls++;return new Response('{}');},Date.now()-1);
  await assert.rejects(reader.discover(),e=>e instanceof TeamsError&&e.code==='session_expired');assert.equal(calls,0);reader.close();
});
test('HTML preview preserves readable text without execution or fetching',()=>{
  const page=parseHistory(reads.history,reads.account,discoverRoutes(reads.authz),reads.conversation),message=page.items[0];
  assert.equal(messageText({...message,content:'<p>Hello &amp; &lt;world&gt;</p><script>secret()</script><p>Next<br>line</p>'}),'Hello & <world>\nNext\nline');
  assert.equal(messageText({...message,content:'Safe<script>hidden'}),'Safe');
});

test('only the recipient private key can import; successful import consumes it',()=>{
  const recipient=fresh();assert.equal(recipient.code(),fixture.pairingCode);
  assert.throws(()=>new Pairing(Buffer.from(fixture.pairingCode,'base64url')).open(fixture.code,fixture.now),TeamsError);
  recipient.open(fixture.code,fixture.now);assert.throws(()=>recipient.open(fixture.code,fixture.now),e=>e instanceof TeamsError&&e.code==='pairing_closed');
  const next=recipient.rotate();assert.notEqual(next,fixture.pairingCode);recipient.close();assert.throws(()=>recipient.code(),TeamsError);
});
