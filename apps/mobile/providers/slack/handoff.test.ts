import assert from 'node:assert/strict';import { test } from 'node:test';import { readFileSync } from 'node:fs';
import { Pairing } from './handoff.ts';import { SlackReader,SlackError } from './client.ts';
const f=JSON.parse(readFileSync(new URL('../../../../docs/protocol/fixtures/slack-handoff.json',import.meta.url),'utf8'));
const fresh=()=>new Pairing(Buffer.from(f.privateKey,'base64url'));
test('Slack native crypto opens shared Rust vector and preserves original cookie bytes',()=>{const p=fresh();assert.equal(p.code(),f.pairingCode);const s=p.open(f.code,f.now);assert.equal(s.cookie,f.body.cookie);assert.deepEqual(s.account,f.body.account);assert.throws(()=>p.open(f.code,f.now),SlackError);});
test('wrong recipient, tampering, cross-provider codes, invalid encoding and expiry fail',()=>{
 for(const [pair,code,now] of [[new Pairing(),f.code,f.now],[fresh(),f.code.slice(0,-8)+'ABCD1234',f.now],[fresh(),f.code.replace('rvslack1','rvteams2'),f.now],[fresh(),f.code+'=',f.now],[fresh(),f.code,f.now+300001]])assert.throws(()=>(pair as Pairing).open(code as string,now as number),SlackError);
 const p=fresh();p.close();assert.throws(()=>p.code(),SlackError);assert.equal(p.rotate().length,43);
});
test('browser identity is checked again on the native transport and mismatch closes reader',async()=>{
 const reader=SlackReader.fromBrowser({...f.body,expiresAt:Date.now()+3600000},async()=>Response.json({ok:true,team_id:'TOTHER',user_id:'UTEST',url:'https://test.slack.com/'}));await assert.rejects(reader.authenticate(),e=>e instanceof SlackError&&e.code==='identity_mismatch');await assert.rejects(reader.authenticate(),e=>e instanceof SlackError&&e.code==='cancelled');
});
test('expired imported session emits no credential-bearing request',async()=>{let calls=0;const reader=SlackReader.fromBrowser({...f.body,expiresAt:Date.now()-1},async()=>{calls++;return Response.json({});});await assert.rejects(reader.authenticate(),e=>e instanceof SlackError&&e.code==='session_expired');assert.equal(calls,0);});

test('authenticated but invalid plaintext schema, identity, lifetime and header data are rejected',()=>{for(const code of f.invalid)assert.throws(()=>fresh().open(code,f.now),SlackError);});
