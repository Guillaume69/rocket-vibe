import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeError, NativeTransport } from './transport.ts';
import { decodeNative } from './validation.ts';
import type { NativeTypes } from './protocol.generated.ts';

const context = {user_id:'owner',device_id:'device',instance_id:'instance',data_epoch:'epoch'};
const change:NativeTypes['ChangeEmailFactor'] = {operation_id:'enroll',email_version:'contact',factor_version:null,context};
const receipt:NativeTypes['EmailFactorChange'] = {enabled:true,codes:['private-fixture-code'],factor_version:'installed',email_version:'contact',context};
const delivery:NativeTypes['RequestFactorEmail'] = {challenge_id:'a'.repeat(64),delivery_id:'b'.repeat(64),operation_id:'deliver'};
const pending:NativeTypes['FactorEmailDelivery'] = {delivery:'queued',expires_at:'2026-10-02T12:00:00Z',resend_after_seconds:60};

test('email factor commands pin scope while anonymous login delivery keeps an active credential',async()=>{
  const requests:{path:string;authorization:string|null;body:unknown}[]=[];
  const client=new NativeTransport('https://example.org/chat',async(url,options)=>{
    const path=new URL(String(url)).pathname;
    assert.equal(options?.redirect,'error');
    requests.push({path,authorization:new Headers(options?.headers).get('authorization'),body:JSON.parse(String(options?.body))});
    return Response.json(path.includes('/factors/email/enable') || path.includes('/factors/email/disable') ? receipt : pending);
  });
  client.restore('current-token');
  await client.enableEmailFactor(change);
  await client.disableEmailFactor({...change,operation_id:'retire',factor_version:'installed'});
  await client.beginFactorEmail(delivery);
  await client.resumeFactorEmail(delivery);
  await client.beginReauthenticationEmail(delivery);
  await client.resumeReauthenticationEmail(delivery);
  assert.deepEqual(requests.map(r=>r.authorization),['Bearer current-token','Bearer current-token',null,null,'Bearer current-token','Bearer current-token']);
  assert.deepEqual(requests.map(r=>r.path),[
    '/chat/api/v1/me/factors/email/enable','/chat/api/v1/me/factors/email/disable',
    '/chat/api/v1/auth/factors/email/start','/chat/api/v1/auth/factors/email/resume',
    '/chat/api/v1/me/reauth/email/start','/chat/api/v1/me/reauth/email/resume',
  ]);
  assert.deepEqual(requests.slice(2).map(r=>r.body),[delivery,delivery,delivery,delivery]);
});

test('shared SMTP cooldown permits receipt recovery and factor retirement',async t=>{
  t.mock.timers.enable({apis:['Date']});
  const paths:string[]=[];
  let revoked=false;
  const client=new NativeTransport('https://example.org',async url=>{
    const path=new URL(String(url)).pathname;paths.push(path);
    if(path.endsWith('/start')) return Response.json({code:'email_delivery_limit',request_id:'mail-limit'},{status:429,headers:{'retry-after':'30'}});
    return Response.json(path.endsWith('/disable')?{...receipt,enabled:false,codes:[]}:pending);
  });
  client.restore('current-token');client.onTokenRejected=()=>{revoked=true;};
  const limited=(e:unknown)=>e instanceof NativeError && e.status===429 && e.requestId==='mail-limit';
  await assert.rejects(client.beginFactorEmail(delivery),limited);
  await assert.rejects(client.beginReauthenticationEmail(delivery),limited);
  await assert.rejects(client.beginEmailVerification({address:'owner@example.test',verification_id:'c'.repeat(64),operation_id:'contact',expected_version:'contact',verification_version:'head',context}),limited);
  await client.resumeFactorEmail(delivery);
  await client.resumeReauthenticationEmail(delivery);
  await client.disableEmailFactor(change);
  assert.equal(paths.filter(p=>p.endsWith('/start')).length,1);
  assert.equal(revoked,false);
  t.mock.timers.tick(30_000);
  await assert.rejects(client.beginReauthenticationEmail(delivery),limited);
  assert.equal(paths.filter(p=>p.endsWith('/start')).length,2);
});

test('delivery candidates cannot carry forged account, address or purpose fields',()=>{
  for(const field of [{user_id:'another'},{address:'another@example.test'},{purpose:'reauth'}]) {
    assert.throws(()=>decodeNative('RequestFactorEmail',{...delivery,...field}));
  }
  assert.throws(()=>decodeNative('ChangeEmailFactor',{...change,enabled:true}));
  assert.throws(()=>decodeNative('FactorEmailDelivery',{...pending,delivery:'delivered_to_inbox'}));
  assert.throws(()=>decodeNative('EmailFactorChange',{...receipt,context:{...context,device_id:4}}));
});
