// Encrypted file vector (E2EE_FILES.md, rv-file-v1), rebuilt with Node/OpenSSL
// only: chunking, STREAM nonces with the last flag, sizes and digests, then
// every object opened again and a truncated one refused.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {xopen,xseal} from './history-crypto.mjs';

const text=readFileSync(new URL('../fixtures/file-v1.json',import.meta.url),'utf8');
const vector=JSON.parse(text);
assert.equal(JSON.stringify(vector)+'\n',text,'canonical serde_json bytes');
assert.equal(vector.format,'rv-file-v1');
const key=Buffer.from(vector.key,'base64url');
assert.equal(key.length,32);
const prefix=Buffer.from(vector.prefix,'hex');
assert.equal(prefix.length,19);
const CHUNK=65536,AAD=Buffer.from('rocketvibe-file-v1');
const sha=b=>createHash('sha256').update(b).digest('hex');
const nonce=(i,last)=>{const n=Buffer.alloc(24);prefix.copy(n);n.writeUInt32BE(i,19);n[23]=last?1:0;return n;};

function seal(plain) {
  const count=Math.max(1,Math.ceil(plain.length/CHUNK)),parts=[Buffer.from('RVF1'),prefix];
  for(let i=0;i<count;i++)parts.push(xseal(key,nonce(i,i===count-1),plain.subarray(i*CHUNK,(i+1)*CHUNK),AAD));
  return Buffer.concat(parts);
}
function open(object,bytes) {
  assert.equal(object.subarray(0,4).toString(),'RVF1');
  const count=Math.max(1,Math.ceil(bytes/CHUNK)),out=[];let at=23;
  for(let i=0;i<count;i++){
    const length=Math.min(CHUNK,bytes-i*CHUNK)+16;
    if(object.length<at+length)throw Error('truncated object');
    out.push(xopen(key,nonce(i,i===count-1),object.subarray(at,at+length),AAD));at+=length;
  }
  if(at!==object.length)throw Error('trailing bytes');
  return Buffer.concat(out);
}

for(const c of vector.cases) {
  const bytes=Number(c.bytes),plain=Buffer.from(Array.from({length:bytes},(_,i)=>i%251));
  assert.equal(sha(plain),c.sha256);
  const object=seal(plain);
  assert.equal(object.length,23+bytes+16*Math.max(1,Math.ceil(bytes/CHUNK)));
  assert.equal(String(object.length),c.object_bytes);
  assert.equal(sha(object),c.object_sha256);
  assert.equal(object.subarray(0,64).toString('hex'),c.object_head);
  assert.equal(sha(open(object,bytes)),c.sha256);
  if(bytes>CHUNK)assert.throws(()=>open(object.subarray(0,23+CHUNK+16),CHUNK),'a dropped last chunk is refused');
}
console.log('Public file vector: chunking, STREAM nonces, sizes, digests and opening verified independently');
