// History share vector (E2EE_HISTORY.md), checked with Node/OpenSSL only:
// certificates, request and share signatures, HPKE base-mode envelope (RFC 9180,
// written out here), per-rank document keys, record signatures, XChaCha20-Poly1305
// decryption (HChaCha20 written out here) and the period chain.
import {readFileSync} from 'node:fs';
import {createCipheriv,createDecipheriv,createHash,createHmac,createPrivateKey,createPublicKey,diffieHellman,verify} from 'node:crypto';
import assert from 'node:assert/strict';
const text=readFileSync(new URL('../fixtures/history-share-v1.json',import.meta.url),'utf8');
const vector=JSON.parse(text);
assert.equal(JSON.stringify(vector)+'\n',text,'canonical serde_json bytes');
const {request,share,records}=vector;
const frame=(purpose,value)=>Buffer.concat([Buffer.from(purpose+'\0'),Buffer.from(JSON.stringify(value))]);
const sha=(...parts)=>{const h=createHash('sha256');for(const p of parts)h.update(p);return h.digest();};
const list=bytes=>[...bytes];
const ed=bytes=>createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:Buffer.from(bytes).toString('base64url')}});
const certificate=c=>{
  assert(verify(null,frame('rocketvibe-device-certificate-v1',c.device),ed(c.device.root.public_key),Buffer.from(c.signature)));
  return list(sha(frame('rocketvibe-certificate-fingerprint-v1',c)));
};

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
const hmac=(key,...parts)=>{const h=createHmac('sha256',key);for(const p of parts)h.update(p);return h.digest();};
const extract=(salt,ikm)=>hmac(salt.length?salt:Buffer.alloc(32),ikm);
const expand=(prk,info,length)=>{
  const out=[];let block=Buffer.alloc(0);
  for(let i=1;Buffer.concat(out).length<length;i++){block=hmac(prk,block,info,Buffer.from([i]));out.push(block);}
  return Buffer.concat(out).subarray(0,length);
};
const u16=n=>Buffer.from([n>>8,n&255]);
const kemSuite=Buffer.concat([Buffer.from('KEM'),u16(0x20)]);
const hpkeSuite=Buffer.concat([Buffer.from('HPKE'),u16(0x20),u16(1),u16(3)]);
const labeledExtract=(suite,salt,label,ikm)=>extract(salt,Buffer.concat([Buffer.from('HPKE-v1'),suite,Buffer.from(label),ikm]));
const labeledExpand=(suite,prk,label,info,length)=>expand(prk,Buffer.concat([u16(length),Buffer.from('HPKE-v1'),suite,Buffer.from(label),info]),length);
const empty=Buffer.alloc(0);
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
const open=(key,nonce,ciphertext,aad)=>{
  const decipher=createDecipheriv('chacha20-poly1305',key,nonce,{authTagLength:16});
  decipher.setAAD(aad,{plaintextLength:ciphertext.length-16});
  decipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]);
};
const envelopeKey=labeledExpand(hpkeSuite,secret,'key',context,32);
const baseNonce=labeledExpand(hpkeSuite,secret,'base_nonce',context,12);
const secrets=JSON.parse(open(envelopeKey,baseNonce,Buffer.from(share.envelope.ciphertext),manifestDigest(share.manifest)));
assert.equal(secrets.length,share.manifest.periods.length);
assert.throws(()=>open(envelopeKey,baseNonce,Buffer.from(share.envelope.ciphertext),sha(Buffer.from('another manifest'))));

// XChaCha20-Poly1305 = HChaCha20 subkey + ChaCha20-Poly1305 with 4 zero bytes.
const hchacha=(key,nonce16)=>{
  const s=new Uint32Array(16);
  s.set([0x61707865,0x3320646e,0x79622d32,0x6b206574]);
  for(let i=0;i<8;i++)s[4+i]=key.readUInt32LE(4*i);
  for(let i=0;i<4;i++)s[12+i]=nonce16.readUInt32LE(4*i);
  const rotl=(v,c)=>(v<<c)|(v>>>(32-c));
  const quarter=(a,b,c,d)=>{
    s[a]+=s[b];s[d]=rotl(s[d]^s[a],16);s[c]+=s[d];s[b]=rotl(s[b]^s[c],12);
    s[a]+=s[b];s[d]=rotl(s[d]^s[a],8);s[c]+=s[d];s[b]=rotl(s[b]^s[c],7);
  };
  for(let i=0;i<10;i++){
    quarter(0,4,8,12);quarter(1,5,9,13);quarter(2,6,10,14);quarter(3,7,11,15);
    quarter(0,5,10,15);quarter(1,6,11,12);quarter(2,7,8,13);quarter(3,4,9,14);
  }
  const out=Buffer.alloc(32);
  [0,1,2,3,12,13,14,15].forEach((w,i)=>out.writeUInt32LE(s[w],4*i));
  return out;
};
// draft-irtf-cfrg-xchacha §2.2.1 test vector.
assert.equal(hchacha(Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f','hex'),Buffer.from('000000090000004a0000000031415927','hex')).toString('hex'),
  '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc');
const xopen=(key,nonce,ciphertext,aad)=>open(hchacha(key,nonce.subarray(0,16)),Buffer.concat([Buffer.alloc(4),nonce.subarray(16)]),ciphertext,aad);
const xseal=(key,nonce,plain,aad)=>{
  const cipher=createCipheriv('chacha20-poly1305',hchacha(key,nonce.subarray(0,16)),Buffer.concat([Buffer.alloc(4),nonce.subarray(16)]),{authTagLength:16});
  cipher.setAAD(aad,{plaintextLength:plain.length});
  return Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
};
// draft-irtf-cfrg-xchacha §A.3.1 AEAD test vector.
{
  const plain=Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const key=Buffer.from('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f','hex');
  const nonce=Buffer.from('404142434445464748494a4b4c4d4e4f5051525354555657','hex');
  const aad=Buffer.from('50515253c0c1c2c3c4c5c6c7','hex');
  const sealed=xseal(key,nonce,plain,aad);
  assert.equal(sealed.subarray(-16).toString('hex'),'c0875924c1c7987947deafd8780acf49');
  assert.deepEqual(xopen(key,nonce,sealed,aad),plain);
}

// Records: rank-bound material, sharing-device attestation, author certificate, chain.
const period=share.manifest.periods[0];
const material=(periodSecret,rank)=>{
  const rankBytes=Buffer.alloc(8);rankBytes.writeBigUInt64BE(BigInt(rank));
  const okm=expand(extract(empty,periodSecret),Buffer.concat([Buffer.from('rocketvibe-history-document-v1\0'),rankBytes]),72);
  return {key:okm.subarray(0,32),keyId:list(okm.subarray(32,48)),nonce:okm.subarray(48,72)};
};
const recordBody=r=>frame('rocketvibe-history-record-v1',[r.header,certificate(r.original_certificate),certificate(r.certificate),r.observed_at,list(sha(Buffer.from(r.ciphertext)))]);
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
