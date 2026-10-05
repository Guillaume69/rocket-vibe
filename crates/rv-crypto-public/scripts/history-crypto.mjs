// Node/OpenSSL primitives shared by the history vector verifiers, written out
// independently of the Rust code: canonical framing, certificates, HKDF,
// ChaCha20-Poly1305, HChaCha20 / XChaCha20-Poly1305 and history records.
import {createCipheriv,createDecipheriv,createHash,createHmac,createPublicKey,verify} from 'node:crypto';
import assert from 'node:assert/strict';

export const frame=(purpose,value)=>Buffer.concat([Buffer.from(purpose+'\0'),Buffer.from(JSON.stringify(value))]);
export const sha=(...parts)=>{const h=createHash('sha256');for(const p of parts)h.update(p);return h.digest();};
export const list=bytes=>[...bytes];
export const empty=Buffer.alloc(0);
export const ed=bytes=>createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:Buffer.from(bytes).toString('base64url')}});
/** Checks the root signature of a device certificate and returns its fingerprint. */
export const certificate=c=>{
  assert(verify(null,frame('rocketvibe-device-certificate-v1',c.device),ed(c.device.root.public_key),Buffer.from(c.signature)));
  return list(sha(frame('rocketvibe-certificate-fingerprint-v1',c)));
};
export const hmac=(key,...parts)=>{const h=createHmac('sha256',key);for(const p of parts)h.update(p);return h.digest();};
export const extract=(salt,ikm)=>hmac(salt.length?salt:Buffer.alloc(32),ikm);
export const expand=(prk,info,length)=>{
  const out=[];let block=Buffer.alloc(0);
  for(let i=1;Buffer.concat(out).length<length;i++){block=hmac(prk,block,info,Buffer.from([i]));out.push(block);}
  return Buffer.concat(out).subarray(0,length);
};
export const open=(key,nonce,ciphertext,aad)=>{
  const decipher=createDecipheriv('chacha20-poly1305',key,nonce,{authTagLength:16});
  decipher.setAAD(aad,{plaintextLength:ciphertext.length-16});
  decipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]);
};
// XChaCha20-Poly1305 = HChaCha20 subkey + ChaCha20-Poly1305 with 4 zero bytes.
export const hchacha=(key,nonce16)=>{
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
export const xopen=(key,nonce,ciphertext,aad)=>open(hchacha(key,nonce.subarray(0,16)),Buffer.concat([Buffer.alloc(4),nonce.subarray(16)]),ciphertext,aad);
export const xseal=(key,nonce,plain,aad)=>{
  const cipher=createCipheriv('chacha20-poly1305',hchacha(key,nonce.subarray(0,16)),Buffer.concat([Buffer.alloc(4),nonce.subarray(16)]),{authTagLength:16});
  cipher.setAAD(aad,{plaintextLength:plain.length});
  return Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
};
// draft-irtf-cfrg-xchacha §2.2.1 and §A.3.1 test vectors.
assert.equal(hchacha(Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f','hex'),Buffer.from('000000090000004a0000000031415927','hex')).toString('hex'),
  '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc');
{
  const plain=Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const key=Buffer.from('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f','hex');
  const nonce=Buffer.from('404142434445464748494a4b4c4d4e4f5051525354555657','hex');
  const aad=Buffer.from('50515253c0c1c2c3c4c5c6c7','hex');
  const sealed=xseal(key,nonce,plain,aad);
  assert.equal(sealed.subarray(-16).toString('hex'),'c0875924c1c7987947deafd8780acf49');
  assert.deepEqual(xopen(key,nonce,sealed,aad),plain);
}
/** Key, key id and nonce of a period's `rank`-th document. */
export const material=(periodSecret,rank)=>{
  const rankBytes=Buffer.alloc(8);rankBytes.writeBigUInt64BE(BigInt(rank));
  const okm=expand(extract(empty,periodSecret),Buffer.concat([Buffer.from('rocketvibe-history-document-v1\0'),rankBytes]),72);
  return {key:okm.subarray(0,32),keyId:list(okm.subarray(32,48)),nonce:okm.subarray(48,72)};
};
/** The signed body of a history record. */
export const recordBody=r=>frame('rocketvibe-history-record-v1',[r.header,certificate(r.original_certificate),certificate(r.certificate),r.observed_at,list(sha(Buffer.from(r.ciphertext)))]);
export const recordFingerprint=r=>list(sha(Buffer.from('rocketvibe-history-record-fingerprint-v1\0'),Buffer.from(JSON.stringify(r))));
export const chainStart=()=>sha(frame('rocketvibe-history-chain-v1',null));
export const chainNext=(head,fingerprint)=>sha(frame('rocketvibe-history-chain-v1',[list(head),fingerprint]));
/** Opens a record with its rank's material and returns its payload. */
export const openRecord=(record,periodSecret,rank)=>{
  const {key,keyId,nonce}=material(periodSecret,rank);
  assert.deepEqual(record.header.key_id,keyId);
  assert.deepEqual(list(nonce),record.header.nonce);
  return JSON.parse(xopen(key,nonce,Buffer.from(record.ciphertext),frame('rocketvibe-history-record-aad-v1',record.header)));
};
