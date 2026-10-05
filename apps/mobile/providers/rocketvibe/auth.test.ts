import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkIdentity, transportFor } from './auth.ts';
import { NativeError, NativeTransport } from './transport.ts';
import { discoverServer } from '../../lib/serverKind.ts';
import { clientForSession } from '../../lib/sessionTransport.ts';
import type { Session } from '../../lib/auth.ts';
import { decodeNative } from './validation.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const discovery = decodeNative('Discovery',fixture.discovery);
const session:Session = {baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
test('identity and epoch mismatches fail before authenticated calls',() => {
  checkIdentity(session,discovery);
  assert.throws(() => checkIdentity(session,{...discovery,instance_id:'another'}),NativeError);
  assert.throws(() => checkIdentity(session,{...discovery,data_epoch:'another'}),NativeError);
});
test('only a structured authenticated native 401 revokes the token actually sent',async () => {
  const rejected:string[] = [];
  let body:unknown = fixture.error; let status = 401;
  const transport = transportFor(session,token => rejected.push(token),async () => Response.json(body,{status}));
  await assert.rejects(transport.me()); assert.deepEqual(rejected,['test-token']);
  body = {message:'Proxy access denied'}; await assert.rejects(transport.me());
  status = 403; body = fixture.error; await assert.rejects(transport.me());
  assert.deepEqual(rejected,['test-token']);
  const login = new NativeTransport(session.baseUrl,async () => Response.json(fixture.error,{status:401}));
  login.onTokenRejected = token => rejected.push(token);
  await assert.rejects(login.login('alice','wrong')); assert.deepEqual(rejected,['test-token']);
});
test('unsupported advertised native versions never fall back to RC discovery',async () => {
  const calls:string[] = [];
  await assert.rejects(discoverServer(session.baseUrl,undefined,async url => {
    calls.push(String(url)); return Response.json({...discovery,protocol_versions:[99]});
  }));
  assert(calls.every(url => url.endsWith('/.well-known/rocketvibe')));
});
test('the metadata client blocks legacy Rocket.Chat endpoints on a native account',async () => {
  const client = clientForSession(session,() => {});
  await assert.rejects(client.get('users.info'));
  assert.equal(client.auth?.userId,session.userId);
});
