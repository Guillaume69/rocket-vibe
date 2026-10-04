import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {CryptoAccount,CryptoPeerBridge,CryptoPeerStatus} from '../../modules/crypto-native/index.ts';
import {CryptoIdentityAccess} from './cryptoIdentity.ts';
import {CryptoPeerAccess} from './cryptoPeers.ts';
import {CryptoStorageAccess} from './cryptoStorage.ts';
import type {Directory} from './protocol.generated.ts';

const scope:CryptoAccount={origin:'https://example.org',instance:'instance',dataEpoch:'epoch',user:'alice',device:'phone'};
const fp='ab'.repeat(32),incarnation='cd'.repeat(16),id='ef'.repeat(16);
test('peer controls use opaque native consent and current public directories, without identity creation or group admission',async()=>{
  const pinCalls:unknown[][]=[],approveCalls:unknown[][]=[];let current=scope,visible=true,changed=false;
  let trust:CryptoPeerStatus['trust']='unknown',approved=false;
  const status=()=>({user:'bob',fingerprint:fp,previous_fingerprint:trust==='unknown'?'':fp,trust,
    devices:[{id:'bob-phone',fingerprint:fp,incarnation,expires_at:'2000000000',approved}]});
  const review=()=>({id,statusJson:JSON.stringify(status())});
  const forbidden=async()=>{throw Error('No identity mutation or group admission from profile controls');};
  const bridge:CryptoPeerBridge={open:async()=>({handle:'native-peer-view',phase:'ready',accountFingerprint:fp,incarnation}),
    status:forbidden,initialize:forbidden,retire:forbidden,close:async()=>{},
    identityView:forbidden,identityBegin:forbidden,identityPreview:forbidden,identityApprove:forbidden,
    identityInstall:forbidden,identityPending:forbidden,identityAcknowledge:forbidden,
    peerView:async()=>review(),peerPin:async(...args)=>{pinCalls.push(args);trust='unverified';return review();},
    peerPreview:async()=>({id,user:'bob',rootFingerprint:fp,device:'bob-phone',fingerprint:fp,incarnation,expiresAt:'2000000000'}),
    peerApprove:async(...args)=>{approveCalls.push(args);approved=true;return review();},
  };
  const directories:string[]=[];
  const remote={cryptoDirectory:async(user:string):Promise<Directory>=>{
    directories.push(user);if(changed && user==='bob')current={...scope,device:'replacement-phone'};
    return {scope:{instance_id:scope.instance,data_epoch:scope.dataEpoch},identity:null,devices:[],revocations:[],next_revocation:null};
  },cryptoOperation:forbidden,registerCryptoDevice:forbidden};
  const storage=await CryptoStorageAccess.open(bridge,async()=>current,()=>visible);
  const access=new CryptoPeerAccess(new CryptoIdentityAccess(storage,bridge,remote),bridge,'bob');
  const observed=await access.read();assert.equal(observed.trust,'unknown');assert.equal(observed.devices[0].approved,false);
  assert.deepEqual(directories,['alice','bob']);assert.equal(pinCalls.length,0);assert.equal(approveCalls.length,0);
  const pinned=await access.pin(observed,'first_contact',fp);
  assert.equal(pinned.trust,'unverified');assert.equal(pinned.devices[0].approved,false);
  assert.equal(pinCalls[0][3],id);assert.equal(pinCalls[0][4],'first_contact');
  const consent=await access.preview(pinned,'bob-phone');assert.equal(approveCalls.length,0);
  const accepted=await access.approve(consent);assert.equal(accepted.devices[0].approved,true);
  assert.equal(approveCalls[0][3],id);
  await assert.rejects(access.approve({...consent,user:'mallory'}));assert.equal(approveCalls.length,1);
  changed=true;
  await assert.rejects(access.pin(accepted,'verify',fp),/crypto_scope_changed/);assert.equal(pinCalls.length,1);
  visible=false;await assert.rejects(access.approve(consent),/session_closed/);assert.equal(approveCalls.length,1);
  await access.close();
});
