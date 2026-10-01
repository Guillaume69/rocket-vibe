import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {test} from 'node:test';
import {nativeRegister} from './auth.ts';
import {NativeError,NativeTransport} from './transport.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const discovery={...fixture.discovery,capabilities:{...fixture.discovery.capabilities,account_invitations:true}};
const credentials={utilisateur:'alice',motDePasse:'new-password-2026'};

test('invitation signup resumes a lost acknowledgement without persisting a secret or accepting another account',async()=>{
  let accepts=0;let lose=true;
  const fetcher:typeof fetch=async(url,options)=>{
    assert.equal(new Headers(options?.headers).has('authorization'),false);
    if(String(url).endsWith('/.well-known/rocketvibe'))return Response.json(discovery);
    if(String(url).endsWith('/invitations/accept')){
      accepts++;assert.deepEqual(JSON.parse(String(options?.body)),{token:'a'.repeat(64),username:'alice',password:credentials.motDePasse});
      if(lose){lose=false;throw new Error('lost acknowledgement');}return Response.json(fixture.session.user);
    }
    return Response.json(fixture.session);
  };
  await assert.rejects(nativeRegister('https://example.org',discovery,credentials,'a'.repeat(64),fetcher),e=>e instanceof NativeError&&e.code==='network_or_protocol_error');
  const session=await nativeRegister('https://example.org',discovery,credentials,'a'.repeat(64),fetcher);
  assert.equal(accepts,2);assert.equal(session.userId,fixture.session.user.id);
  assert.equal(JSON.stringify(session).includes('new-password'),false);assert.equal('invitation' in session,false);
});

test('signup checks capability, generation before and after acceptance, and the authenticated UID',async()=>{
  for(const scenario of ['capability','before','after','uid','after-login']){
    let reads=0,accepts=0,logins=0;
    const fetcher:typeof fetch=async url=>{
      if(String(url).endsWith('/.well-known/rocketvibe')){
        reads++;
        return Response.json({...discovery,capabilities:{...discovery.capabilities,account_invitations:scenario!=='capability'},data_epoch:
          scenario==='before'||scenario==='after'&&reads>=2||scenario==='after-login'&&reads>=4?'changed':discovery.data_epoch});
      }
      if(String(url).endsWith('/invitations/accept')){accepts++;return Response.json({...fixture.session.user,id:scenario==='uid'?'different':fixture.session.user.id});}
      logins++;return Response.json(fixture.session);
    };
    await assert.rejects(nativeRegister('https://example.org',discovery,credentials,'a'.repeat(64),fetcher),e=>e instanceof NativeError&&e.code===(scenario==='capability'?'invitation_unavailable':'server_identity_changed'));
    assert.equal(accepts,scenario==='before'||scenario==='capability'?0:1);
    assert.equal(logins,scenario==='uid'||scenario==='after-login'?1:0);
  }
});

test('anonymous signup failure neither revokes nor sends the saved session; its cooldown covers login',async t=>{
  t.mock.timers.enable({apis:['Date']});let calls=0,revocations=0;
  const transport=new NativeTransport('https://example.org',async(_,options)=>{
    calls++;assert.equal(new Headers(options?.headers).has('authorization'),false);
    return Response.json({code:calls===1?'session_rejected':'auth_rate_limited',request_id:'signup-request'},{status:calls===1?401:429,headers:{'retry-after':'30'}});
  });
  transport.restore('existing-token');transport.surJetonRefuse=()=>{revocations++;};
  const input={token:'a'.repeat(64),username:'alice',password:credentials.motDePasse};
  await assert.rejects(transport.acceptInvitation(input),e=>e instanceof NativeError&&e.status===401);
  await assert.rejects(transport.acceptInvitation(input),e=>e instanceof NativeError&&e.status===429);
  await assert.rejects(transport.login('alice',credentials.motDePasse),e=>e instanceof NativeError&&e.status===429&&e.requestId==='signup-request');
  assert.equal(calls,2);assert.equal(revocations,0);
});
