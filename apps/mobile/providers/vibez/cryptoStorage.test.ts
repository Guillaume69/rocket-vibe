import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CryptoStorageAccess} from './cryptoStorage.ts';
import type {CryptoAccount,CryptoInstallationStatus,CryptoStorageBridge} from '../../modules/crypto-native/index.ts';

const scope:CryptoAccount={origin:'https://example.org',instance:'instance',dataEpoch:'epoch',user:'alice',device:'android'};
const fingerprint='ab'.repeat(32);
function fixture() {
  let current=scope,visible=true,initialized=0;
  const closed:string[]=[];
  const status:CryptoInstallationStatus={phase:'missing',accountFingerprint:fingerprint,incarnation:''};
  const bridge:CryptoStorageBridge={
    open:async()=>({...status,handle:'original-native-view'}),status:async()=>({...status}),
    initialize:async()=>{initialized++;status.phase='ready';status.incarnation='cd'.repeat(16);return {...status};},
    removed:async()=>{},close:async handle=>{closed.push(handle);},
  };
  return {bridge,closed,status,read:async()=>current,alive:()=>visible,
    change:(next:CryptoAccount)=>{current=next;},hide:()=>{visible=false;},initialized:()=>initialized};
}

test('opening only reads native storage, explicit initialization binds reviewed scope, closing is terminal',async()=>{
  const f=fixture(),access=await CryptoStorageAccess.open(f.bridge,f.read,f.alive);
  assert.equal((await access.status()).phase,'missing');assert.equal(f.initialized(),0);
  await assert.rejects(access.initialize('ef'.repeat(32)),/crypto_scope_changed/);
  assert.equal(f.initialized(),0);
  assert.equal((await access.initialize(fingerprint)).phase,'ready');assert.equal(f.initialized(),1);
  await access.close();await access.close();
  assert.deepEqual(f.closed,['original-native-view']);
  await assert.rejects(access.initialize(fingerprint),/session_closed/);
  assert.equal(f.initialized(),1);
});

test('a late native open is closed if the original settings view disappears',async()=>{
  const f=fixture();let release:()=>void=()=>{},started:()=>void=()=>{};
  const waiting=new Promise<void>(resolve=>{started=resolve;}),done=new Promise<void>(resolve=>{release=resolve;});
  f.bridge.open=async()=>{started();await done;return {...f.status,handle:'late-original'};};
  const opening=CryptoStorageAccess.open(f.bridge,f.read,f.alive);await waiting;
  f.hide();release();await assert.rejects(opening,/session_closed/);
  assert.deepEqual(f.closed,['late-original']);assert.equal(f.initialized(),0);
});

test('a changed HTTP device, account or epoch refuses the captured action before platform mutation',async()=>{
  for(const field of ['device','user','dataEpoch','instance','origin'] as const){
    const f=fixture(),access=await CryptoStorageAccess.open(f.bridge,f.read,f.alive);
    f.change({...scope,[field]:scope[field]+'-changed'});
    await assert.rejects(access.initialize(fingerprint),/crypto_scope_changed/);
    assert.equal(f.initialized(),0);assert.equal(access.isClosed,true);
    await access.close();assert.deepEqual(f.closed,['original-native-view']);
  }
});

test('an interrupted platform write completes but cannot publish into a resumed or hidden view',async()=>{
  const f=fixture(),access=await CryptoStorageAccess.open(f.bridge,f.read,f.alive);
  let release:()=>void=()=>{},started:()=>void=()=>{};
  const waiting=new Promise<void>(resolve=>{started=resolve;}),done=new Promise<void>(resolve=>{release=resolve;});
  const initialize=f.bridge.initialize;
  f.bridge.initialize=async(...args)=>{started();await done;return initialize(...args);};
  const writing=access.initialize(fingerprint);await waiting;await access.close();release();
  await assert.rejects(writing,/session_closed/);assert.equal(f.initialized(),1);
  assert.deepEqual(f.closed,['original-native-view']);
});

test('unavailable Keystore stays unavailable without a fallback, initialization or replacement',async()=>{
  const f=fixture();f.bridge.open=async()=>{throw new Error('crypto_storage_unavailable');};
  await assert.rejects(CryptoStorageAccess.open(f.bridge,f.read,f.alive),/crypto_storage_unavailable/);
  assert.equal(f.initialized(),0);assert.deepEqual(f.closed,[]);
});
