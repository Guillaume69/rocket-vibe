import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeError, NativeTransport } from './transport.ts';
import { decodeNative } from './validation.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const challenge={kind:'challenge',user:fixture.session.user,challenge:{challenge_id:'a'.repeat(64),methods:['totp','recovery_code'],expires_at:'2026-10-01T09:00:00Z',resend_after_seconds:0}};
const finish={challenge_id:'a'.repeat(64),method:'recovery_code' as const,code:'TEST-BACKUP-CODE',operation_id:'factor-login',next_token:'b'.repeat(64)};

test('anonymous factor steps preserve the active account credential until explicit installation',async()=>{
  const requests:{url:string;options?:RequestInit}[]=[];
  const client=new NativeTransport('https://example.org/chat',async(url,options)=>{
    requests.push({url:String(url),options});
    if (String(url).endsWith('/auth/start')) return Response.json(challenge);
    if (String(url).endsWith('/auth/factors/verify')) return Response.json({...fixture.session,token:finish.next_token});
    return Response.json(fixture.session.user);
  });
  client.restore('active-old-token');
  assert.equal((await client.startLogin('owner','password')).kind,'challenge');
  assert.equal((await client.finishFactor(finish)).token,finish.next_token);
  await client.me();
  assert.equal(new Headers(requests[0].options?.headers).has('authorization'),false);
  assert.equal(new Headers(requests[1].options?.headers).has('authorization'),false);
  assert.equal(new Headers(requests[2].options?.headers).get('authorization'),'Bearer active-old-token');
  assert.equal(requests[1].options?.redirect,'error');
  assert.deepEqual(JSON.parse(String(requests[1].options?.body)),finish);
});

test('rejected anonymous second factor never invokes active-account revocation',async()=>{
  let revoked=false;
  const client=new NativeTransport('https://example.org',async()=>Response.json({code:'session_rejected',request_id:'anonymous-factor-error'},{status:401}));
  client.restore('active-token');client.surJetonRefuse=()=>{revoked=true;};
  await assert.rejects(client.finishFactor(finish),e=>e instanceof NativeError && e.status===401);
  assert.equal(revoked,false);
});

test('factor cooldown spans password starts, code retries and legacy login without blocking me',async t=>{
  t.mock.timers.enable({apis:['Date']});let calls=0;
  const client=new NativeTransport('https://example.org',async url=>{
    calls++;return String(url).endsWith('/me')?Response.json(fixture.session.user):Response.json({code:'auth_rate_limited',request_id:'factor-limit'},{status:429,headers:{'retry-after':'60'}});
  });
  client.restore('active-token');
  const limited=(e:unknown)=>e instanceof NativeError && e.status===429 && e.requestId==='factor-limit';
  await assert.rejects(client.finishFactor(finish),limited);
  await assert.rejects(client.startLogin('owner','password'),limited);
  await assert.rejects(client.login('owner','password'),limited);
  assert.equal(calls,1);await client.me();assert.equal(calls,2);
  t.mock.timers.tick(60_000);await assert.rejects(client.startLogin('owner','password'),limited);assert.equal(calls,3);
});

test('factor contract rejects mixed session/challenge envelopes and forged identities',()=>{
  assert.equal(decodeNative('AuthenticationStep',challenge).kind,'challenge');
  assert.throws(()=>decodeNative('AuthenticationStep',{...challenge,session:fixture.session}));
  assert.throws(()=>decodeNative('AuthenticationStep',{kind:'session',session:fixture.session,challenge:challenge.challenge}));
  assert.throws(()=>decodeNative('FinishFactor',{...finish,user_id:'other-account'}));
  assert.throws(()=>decodeNative('EnableFactor',{setup_id:'setup',operation_id:'enable',code:'123456',totp_cipher:'forged'}));
});
