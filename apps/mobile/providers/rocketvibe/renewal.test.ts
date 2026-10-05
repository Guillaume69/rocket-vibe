import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import type {Session} from '../../lib/auth.ts';
import {renewCredentials,renewalDue,validRenewal,type CredentialRecord} from './renewal.ts';
import {NativeError,NativeTransport} from './transport.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const session:Session={baseUrl:'http://localhost:3400',authToken:'a'.repeat(64),userId:fixture.session.user.id,username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
const initial=():CredentialRecord=>({session:{...session},pending:null,expires_at:null});

test('a lost renewal response recovers its saved successor without renewing twice or revoking the old session locally',async()=>{
  let stored=initial();let current=session.authToken;let requests=0;let random=0;let rejected=0;
  const factory=(record:Session)=>{
    const transport=new NativeTransport(record.baseUrl,async(url,options)=>{
      const path=String(url);const token=(options?.headers as Record<string,string>).authorization?.slice(7);
      if (path.endsWith('/.well-known/rocketvibe')) return Response.json({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,session_rotation:true,device_sessions:true}});
      if (path.endsWith('/auth/renew')) {
        requests++;const input=JSON.parse(String(options?.body));
        assert(stored.pending);
        assert.deepEqual(input,stored.pending,'the successor must already be durable before HTTP');
        assert.equal(token,session.authToken);current=input.next_token;
        return Response.json({code:'response_lost',request_id:'renew-test'},{status:503});
      }
      if (token!==current) return Response.json({code:'session_rejected',request_id:'probe'},{status:401});
      if (path.endsWith('/me')) return Response.json(fixture.session.user);
      if (path.endsWith('/me/sessions')) return Response.json([{id:'device-1',label:'Mobile',created_at:'2026-10-01T00:00:00Z',last_seen_at:'2026-10-01T00:00:00Z',expires_at:'2026-11-01T00:00:00Z',current:true}]);
      throw new Error('Unexpected renewal request');
    });transport.restore(record.authToken);transport.onTokenRejected=()=>{rejected++;};return transport;
  };
  const deps={token:async()=>String(++random).repeat(64),save:async(record:CredentialRecord)=>{stored=structuredClone(record);},transport:factory};
  await assert.rejects(renewCredentials(stored,deps),/response_lost/);
  assert(stored.pending);assert.equal(stored.session.authToken,session.authToken);assert(renewalDue(stored));
  const pending=stored.pending!;
  const recovered=await renewCredentials(stored,deps);
  assert.equal(recovered.session.authToken,pending.next_token);assert.equal(requests,1);assert.equal(random,2);assert.equal(rejected,0);
  assert.equal(stored.pending,null);assert.equal(stored.expires_at,'2026-11-01T00:00:00Z');
});

test('an uncommitted successor repeats its original intent and vault failure prevents any network mutation',async()=>{
  const pending={operation_id:'b'.repeat(64),next_token:'c'.repeat(64)};
  const record={...initial(),pending};let sent=0;
  const transport={restore:()=>{},discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,session_rotation:true}}),me:async()=>{throw new NativeError(401,'session_rejected');},renew:async(input:unknown)=>{sent++;assert.deepEqual(input,pending);return {...fixture.session,token:pending.next_token,expires_at:'2026-11-01T00:00:00Z'};}} as unknown as NativeTransport;
  const next=await renewCredentials(record,{token:async()=>{throw new Error('No new random secret');},save:async()=>{},transport:()=>transport});
  assert.equal(next.session.authToken,pending.next_token);assert.equal(sent,1);
  await assert.rejects(renewCredentials(initial(),{token:async()=>'d'.repeat(64),save:async()=>{throw new Error('Vault unavailable');},transport:()=>transport}),/Vault unavailable/);
  assert.equal(sent,1);
});

test('identity changes and a successor belonging to another account cannot replace saved credentials',async()=>{
  const record={...initial(),pending:{operation_id:'b'.repeat(64),next_token:'c'.repeat(64)}};
  let writes=0;let renews=0;
  const transport={restore:()=>{},discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,session_rotation:true}}),me:async()=>({...fixture.session.user,id:'another-account'}),renew:async()=>{renews++;throw new Error('Unexpected mutation');}} as unknown as NativeTransport;
  await assert.rejects(renewCredentials(record,{token:async()=>'',save:async()=>{writes++;},transport:()=>transport}),/session_rejected/);
  assert.equal(writes,0);assert.equal(renews,0);
  transport.discover=async()=>({...fixture.discovery,data_epoch:'restored'});
  await assert.rejects(renewCredentials(record,{token:async()=>'',save:async()=>{writes++;},transport:()=>transport}),/server_identity_changed/);
  assert.equal(writes,0);
});

test('recovery retains the durable successor when current device metadata is invalid',async()=>{
  const record={...initial(),pending:{operation_id:'b'.repeat(64),next_token:'c'.repeat(64)}};
  let writes=0;
  const active={id:'device-1',label:'Mobile',created_at:'2026-10-01T00:00:00Z',last_seen_at:'2026-10-01T00:00:00Z',expires_at:'2026-11-01T00:00:00Z',current:true};
  let devices=[active];
  const transport={restore:()=>{},discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,session_rotation:true}}),me:async()=>fixture.session.user,deviceSessions:async()=>devices} as unknown as NativeTransport;
  const deps={token:async()=>{throw new Error('No new secret');},save:async()=>{writes++;},transport:()=>transport};
  for (const invalid of [[],[active,active],[{...active,expires_at:'invalid'}]]) {
    devices=invalid;
    await assert.rejects(renewCredentials(record,deps),/invalid_native_session/);
    assert.equal(writes,0);assert(record.pending);
  }
  devices=[active];await renewCredentials(record,deps);assert.equal(writes,1);
});

test('malformed secure-store intentions are rejected before discovery or authenticated requests',async()=>{
  const intent={operation_id:'b'.repeat(64),next_token:'c'.repeat(64)};
  assert(validRenewal(intent,session.authToken));
  for (const value of [null,{...intent,next_token:session.authToken},{...intent,extra:'field'},{...intent,operation_id:'contains space'},{...intent,next_token:'C'.repeat(64)}]) assert(!validRenewal(value,session.authToken));
  await assert.rejects(renewCredentials({...initial(),pending:{...intent,next_token:'short'}},{token:async()=>'',save:async()=>{throw new Error('Unexpected save');},transport:()=>{throw new Error('Unexpected discovery');}}),/invalid_native_credentials/);
});
