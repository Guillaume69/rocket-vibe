// History share vector (E2EE_HISTORY.md), checked with Node/OpenSSL only:
// certificates, request and share signatures, HPKE base-mode envelope (RFC 9180,
// written out here), per-rank document keys, record signatures, XChaCha20-Poly1305
// decryption (HChaCha20 written out here) and the period chain.
import {readFileSync} from 'node:fs';
import {createPrivateKey,createPublicKey,diffieHellman,verify} from 'node:crypto';
import assert from 'node:assert/strict';
import {certificate,ed,empty,expand,extract,frame,list,material,open,recordBody,sha,xopen} from './history-crypto.mjs';
const text=readFileSync(new URL('../fixtures/history-share-v1.json',import.meta.url),'utf8');
const vector=JSON.parse(text);
assert.equal(JSON.stringify(vector)+'\n',text,'canonical serde_json bytes');
const {request,share,records}=vector;

// Request: signed by the new device, whose certificate carries the account root.
const phone=request.body.certificate;
certificate(phone);
assert(verify(null,frame('rocketvibe-history-request-v1',request.body),ed(phone.device.signature_key),Buffer.from(request.signature)));
assert(BigInt(request.body.expires_at)-BigInt(request.body.issued_at)<=7n*86400n);
const requestFingerprint=list(sha(frame('rocketvibe-history-request-fingerprint-v1',request)));

// Share: another device of the same account, signed over request, manifest, envelope.
const desktop=share.certificate;
const desktopFingerprint=certificate(desktop);
assert.deepEqual(desktop.device.root,phone.device.root);
assert.notEqual(desktop.device.device,phone.device.device);
const manifestDigest=m=>sha(Buffer.from('rocketvibe-history-manifest-v1\0'),Buffer.from(JSON.stringify(m)));
const envelopeDigest=sha(Buffer.from('rocketvibe-history-envelope-v1\0'),Buffer.from(share.envelope.kem_output),Buffer.from(share.envelope.ciphertext));
const shareBody=m=>frame('rocketvibe-history-share-v1',[m.request,list(manifestDigest(m)),list(envelopeDigest),desktopFingerprint]);
const shareSignature=Buffer.from(share.signature);
assert.deepEqual(share.manifest.request,requestFingerprint);
assert(verify(null,shareBody(share.manifest),ed(desktop.device.signature_key),shareSignature));
for(const change of [m=>m.periods[0].count='1',m=>m.periods[0].last='9007199254740995',m=>m.periods[0].chain[0]^=1,m=>m.request[0]^=1,m=>m.periods[0].grant.user='bob']) {
  const changed=structuredClone(share.manifest);change(changed);
  assert(!verify(null,shareBody(changed),ed(desktop.device.signature_key),shareSignature));
}

// HPKE base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305.
const u16=n=>Buffer.from([n>>8,n&255]);
const kemSuite=Buffer.concat([Buffer.from('KEM'),u16(0x20)]);
const hpkeSuite=Buffer.concat([Buffer.from('HPKE'),u16(0x20),u16(1),u16(3)]);
const labeledExtract=(suite,salt,label,ikm)=>extract(salt,Buffer.concat([Buffer.from('HPKE-v1'),suite,Buffer.from(label),ikm]));
const labeledExpand=(suite,prk,label,info,length)=>expand(prk,Buffer.concat([u16(length),Buffer.from('HPKE-v1'),suite,Buffer.from(label),info]),length);
// DeriveKeyPair(recipient_seed) gives the request's recipient key.
const seed=Buffer.from(vector.recipient_seed,'hex');
const sk=labeledExpand(kemSuite,labeledExtract(kemSuite,empty,'dkp_prk',seed),'sk',empty,32);
const x25519Private=createPrivateKey({format:'der',type:'pkcs8',key:Buffer.concat([Buffer.from('302e020100300506032b656e04220420','hex'),sk])});
const pkR=Buffer.from(createPublicKey(x25519Private).export({format:'jwk'}).x,'base64url');
assert.deepEqual(list(pkR),request.body.recipient);
const enc=Buffer.from(share.envelope.kem_output);
const dh=diffieHellman({privateKey:x25519Private,publicKey:createPublicKey({format:'jwk',key:{kty:'OKP',crv:'X25519',x:enc.toString('base64url')}})});
const sharedSecret=labeledExpand(kemSuite,labeledExtract(kemSuite,empty,'eae_prk',dh),'shared_secret',Buffer.concat([enc,pkR]),32);
const info=Buffer.concat([Buffer.from('rocketvibe-history-share-v1\0'),Buffer.from(requestFingerprint)]);
const context=Buffer.concat([Buffer.from([0]),labeledExtract(hpkeSuite,empty,'psk_id_hash',empty),labeledExtract(hpkeSuite,empty,'info_hash',info)]);
const secret=labeledExtract(hpkeSuite,sharedSecret,'secret',empty);
const envelopeKey=labeledExpand(hpkeSuite,secret,'key',context,32);
const baseNonce=labeledExpand(hpkeSuite,secret,'base_nonce',context,12);
const sealed=JSON.parse(open(envelopeKey,baseNonce,Buffer.from(share.envelope.ciphertext),manifestDigest(share.manifest)));
assert.deepEqual(Object.keys(sealed),['secrets','history_key']);
// This share's device held no history key; path B's vector covers one.
assert.equal(sealed.history_key,null);
const secrets=sealed.secrets;
assert.equal(secrets.length,share.manifest.periods.length);
assert.throws(()=>open(envelopeKey,baseNonce,Buffer.from(share.envelope.ciphertext),sha(Buffer.from('another manifest'))));


// Records: rank-bound material, sharing-device attestation, author certificate, chain.
const period=share.manifest.periods[0];
let chain=sha(frame('rocketvibe-history-chain-v1',null));
let previous=0n;
const periodSecret=Buffer.from(secrets[0],'hex');
records.forEach((record,index)=>{
  const route=record.header.origin.header;
  const author=record.original_certificate.device;
  assert.deepEqual(record.certificate,share.certificate);
  assert.deepEqual(route.scope,period.scope);
  assert.notDeepEqual(author.root,desktop.device.root);
  assert.equal(author.root.user,route.author);
  assert.equal(author.device,route.device);
  assert.deepEqual(author.incarnation,route.incarnation);
  assert.deepEqual(certificate(record.original_certificate),route.certificate);
  assert.equal(author.root.user,record.header.author_membership.user);
  // The origin's id derives from its proof fingerprint, never from the server.
  assert.equal(record.header.origin.message,sha(Buffer.concat([Buffer.from('rocketvibe-mls-message-id-v1\0'),Buffer.from(record.header.origin.fingerprint)])).subarray(0,16).toString('hex'));
  const position=BigInt(record.header.origin.position);
  assert(position>previous&&position>=BigInt(period.first)&&position<=BigInt(period.last));
  previous=position;
  const signature=Buffer.from(record.signature);
  assert(verify(null,recordBody(record),ed(desktop.device.signature_key),signature));
  // The sharing device's observation time is attested, as an exact decimal.
  assert.match(record.observed_at,/^[1-9][0-9]*$/);
  assert(!verify(null,recordBody({...record,observed_at:String(BigInt(record.observed_at)+1n)}),ed(desktop.device.signature_key),signature));
  assert(!verify(null,frame('rocketvibe-archive-document-proof-v1',JSON.parse(recordBody(record).subarray('rocketvibe-history-record-v1\0'.length))),ed(desktop.device.signature_key),signature));
  for(const change of [h=>h.origin.header.scope.room='foreign',h=>h.origin.header.author='mallory',h=>h.origin.position='9007199254740999',h=>h.origin.header.thread='another-thread',h=>h.author_membership.access_version='other',h=>h.key_id[0]^=1,h=>h.nonce[0]^=1]) {
    const changed=structuredClone(record);change(changed.header);
    assert(!verify(null,recordBody(changed),ed(desktop.device.signature_key),signature));
  }
  const {key,keyId,nonce}=material(periodSecret,index+1);
  assert.deepEqual(record.header.key_id,keyId);
  assert.deepEqual(list(nonce),record.header.nonce);
  // Served at another rank, the record does not match the derived material.
  assert.notDeepEqual(material(periodSecret,index+2).keyId,record.header.key_id);
  const aad=frame('rocketvibe-history-record-aad-v1',record.header);
  const payload=JSON.parse(xopen(key,nonce,Buffer.from(record.ciphertext),aad));
  assert.equal(payload.version,1);
  assert.equal(payload.message.operation_id,route.operation);
  assert.equal(payload.message.reply_to??null,route.thread);
  assert.match(payload.message.text,/^recovered words general \d$/);
  const moved=structuredClone(record.header);moved.origin.header.scope.room='foreign';
  assert.throws(()=>xopen(key,nonce,Buffer.from(record.ciphertext),frame('rocketvibe-history-record-aad-v1',moved)));
  const fingerprint=list(sha(Buffer.from('rocketvibe-history-record-fingerprint-v1\0'),Buffer.from(JSON.stringify(record))));
  chain=sha(frame('rocketvibe-history-chain-v1',[list(chain),fingerprint]));
});
assert.equal(BigInt(period.count),BigInt(records.length));
assert.deepEqual(list(chain),period.chain);
console.log('Public history vector: request, share, HPKE envelope, rank-bound records, attestations, decryption and chain verified independently');
