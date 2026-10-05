import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {nativeRecover} from './auth.ts';
import {NativeError,NativeTransport} from './transport.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const discovery={...fixture.discovery,capabilities:{...fixture.discovery.capabilities,account_recovery:true}};
const credentials={user:'alice',password:'recovered-password-2026'};
test('lost recovery acknowledgement resumes the bound account, then uses normal login and excludes code from session',async()=>{
  let attempts=0,lose=true;
  const fetcher:typeof fetch=async(url,options)=>{
    assert.equal(new Headers(options?.headers).has('authorization'),false);
    if(String(url).endsWith('/.well-known/rocketvibe'))return Response.json(discovery);
    if(String(url).endsWith('/auth/recovery')){
      attempts++;assert.deepEqual(JSON.parse(String(options?.body)),{token:'b'.repeat(64),username:'alice',new_password:credentials.password});
      if(lose){lose=false;throw new Error('lost acknowledgement');}return Response.json(fixture.session.user);
    }
    return Response.json(fixture.session);
  };
  await assert.rejects(nativeRecover('https://example.org',discovery,credentials,'b'.repeat(64),fetcher),e=>e instanceof NativeError&&e.code==='network_or_protocol_error');
  const session=await nativeRecover('https://example.org',discovery,credentials,'b'.repeat(64),fetcher);
  assert.equal(attempts,2);assert.equal(session.userId,fixture.session.user.id);
  assert.equal(JSON.stringify(session).includes('recovered-password'),false);assert.equal('recovery' in session,false);
});
test('recovery respects capability, generation and UID barriers before storing a session',async()=>{
  for(const scenario of ['capability','before','after','uid','after-login']){
    let reads=0,resets=0,logins=0;
    const fetcher:typeof fetch=async url=>{
      if(String(url).endsWith('/.well-known/rocketvibe')){
        reads++;return Response.json({...discovery,capabilities:{...discovery.capabilities,account_recovery:scenario!=='capability'},data_epoch:
          scenario==='before'||scenario==='after'&&reads>=2||scenario==='after-login'&&reads>=4?'changed':discovery.data_epoch});
      }
      if(String(url).endsWith('/auth/recovery')){resets++;return Response.json({...fixture.session.user,id:scenario==='uid'?'another':fixture.session.user.id});}
      logins++;return Response.json(fixture.session);
    };
    await assert.rejects(nativeRecover('https://example.org',discovery,credentials,'b'.repeat(64),fetcher),e=>e instanceof NativeError&&e.code===(scenario==='capability'?'recovery_unavailable':'server_identity_changed'));
    assert.equal(resets,scenario==='capability'||scenario==='before'?0:1);assert.equal(logins,scenario==='uid'||scenario==='after-login'?1:0);
  }
});
test('anonymous recovery errors preserve the current session and share the login cooldown',async t=>{
  t.mock.timers.enable({apis:['Date']});let calls=0,revoked=0;
  const transport=new NativeTransport('https://example.org',async(_,options)=>{
    calls++;assert.equal(new Headers(options?.headers).has('authorization'),false);
    return Response.json({code:calls===1?'session_rejected':'auth_rate_limited',request_id:'recovery-request'},{status:calls===1?401:429,headers:{'retry-after':'30'}});
  });
  transport.restore('existing-token');transport.onTokenRejected=()=>{revoked++;};const input={token:'b'.repeat(64),username:'alice',new_password:credentials.password};
  await assert.rejects(transport.recoverAccount(input));await assert.rejects(transport.recoverAccount(input));
  await assert.rejects(transport.login('alice',credentials.password),e=>e instanceof NativeError&&e.status===429&&e.requestId==='recovery-request');
  assert.equal(calls,2);assert.equal(revoked,0);
});
