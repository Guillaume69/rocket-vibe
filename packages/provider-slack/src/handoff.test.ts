import assert from 'node:assert/strict';import { test } from 'node:test';import { readFileSync } from 'node:fs';
import { Pairing } from './handoff.ts';import { SlackError } from './client.ts';import { loginSlack } from './auth.ts';
const f=JSON.parse(readFileSync(new URL('../../../docs/protocol/fixtures/slack-handoff.json',import.meta.url),'utf8'));
const fresh=()=>new Pairing(Buffer.from(f.privateKey,'base64url'));
test('Slack native crypto opens shared Rust vector and preserves original cookie bytes',()=>{const p=fresh();assert.equal(p.code(),f.pairingCode);const s=p.open(f.code,f.now);assert.equal(s.cookie,f.body.cookie);assert.deepEqual(s.account,f.body.account);assert.throws(()=>p.open(f.code,f.now),SlackError);});
test('wrong recipient, tampering, cross-provider codes, invalid encoding and expiry fail',()=>{
 for(const [pair,code,now] of [[new Pairing(),f.code,f.now],[fresh(),f.code.slice(0,-8)+'ABCD1234',f.now],[fresh(),f.code.replace('rvslack1','rvteams2'),f.now],[fresh(),f.code+'=',f.now],[fresh(),f.code,f.now+300001]])assert.throws(()=>(pair as Pairing).open(code as string,now as number),SlackError);
 const p=fresh();p.close();assert.throws(()=>p.code(),SlackError);assert.equal(p.rotate().length,43);
});
test('browser identity is checked again by auth.test and a mismatch saves nothing',async()=>{
 const opened=fresh().open(f.code,f.now);await assert.rejects(loginSlack(opened.token,opened.cookie,opened.account,{fetch:async()=>Response.json({ok:true,team_id:'TOTHER',user_id:opened.account.userId,url:'https://test.slack.com/'})}),e=>e instanceof SlackError&&e.code==='identity_mismatch');
});

test('authenticated but invalid plaintext schema, identity, lifetime and header data are rejected',()=>{for(const code of f.invalid)assert.throws(()=>fresh().open(code,f.now),SlackError);});
