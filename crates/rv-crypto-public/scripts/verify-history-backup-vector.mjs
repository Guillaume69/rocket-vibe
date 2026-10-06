// History backup vector (E2EE_HISTORY_BACKUP.md), checked with Node/OpenSSL only:
// the rvh1 code and its checksum, the key package opened under the code key, the
// device-signed publication, the period id and secret, rank-bound records, the
// signed checkpoint and its chain.
import {readFileSync} from 'node:fs';
import {verify} from 'node:crypto';
import assert from 'node:assert/strict';
import {certificate,chainNext,chainStart,ed,empty,expand,extract,frame,list,openRecord,recordBody,recordFingerprint,sha,xopen} from './history-crypto.mjs';

const text=readFileSync(new URL('../fixtures/history-backup-v1.json',import.meta.url),'utf8');
const vector=JSON.parse(text);
assert.equal(JSON.stringify(vector)+'\n',text,'canonical serde_json bytes');
const {code,publication,checkpoint,records}=vector;
const {body,package:pkg}=publication;

// The code: rvh1-, 64 hex digits of key, a checksum under its own domain.
assert.match(code,/^rvh1-[0-9a-f]{64}-[0-9a-f]{8}$/);
const codeKey=Buffer.from(code.slice(5,69),'hex');
assert.equal(sha(Buffer.from('rocketvibe-history-code-v1\0'),codeKey).subarray(0,4).toString('hex'),code.slice(70));

// The publication: the publishing device's certificate under the package's root,
// its leaf signature over the body, and the body bound to the package digest.
const device=vector.certificate;
certificate(device);
assert.deepEqual(device.device.root,pkg.header.root);
assert.equal(device.device.device,body.device);
assert.deepEqual(device.device.incarnation,body.incarnation);
assert.deepEqual(list(sha(Buffer.from(JSON.stringify(pkg)))),body.package_digest);
const publicationSignature=Buffer.from(publication.signature);
assert(verify(null,frame('rocketvibe-history-key-publication-v1',body),ed(device.device.signature_key),publicationSignature));
for(const change of [b=>b.operation='other',b=>b.expected_revision='1',b=>b.package_digest[0]^=1,b=>b.device_revision='2']){
  const changed=structuredClone(body);change(changed);
  assert(!verify(null,frame('rocketvibe-history-key-publication-v1',changed),ed(device.device.signature_key),publicationSignature));
}

// The package opens under the code key; its header is the AEAD's associated data.
const aad=frame('rocketvibe-history-key-v1',pkg.header);
const historyKey=JSON.parse(xopen(codeKey,Buffer.from(pkg.nonce),Buffer.from(pkg.ciphertext),aad));
assert.deepEqual(Object.keys(historyKey),['generation','key']);
assert.deepEqual(historyKey.generation,pkg.header.generation);
assert.throws(()=>xopen(Buffer.alloc(32,1),Buffer.from(pkg.nonce),Buffer.from(pkg.ciphertext),aad));
const moved=structuredClone(pkg.header);moved.created_at=String(BigInt(moved.created_at)+1n);
assert.throws(()=>xopen(codeKey,Buffer.from(pkg.nonce),Buffer.from(pkg.ciphertext),frame('rocketvibe-history-key-v1',moved)));

// The checkpoint: signed by the uploading device over its body and certificate.
const cp=checkpoint.body;
const uploader=certificate(checkpoint.certificate);
assert.deepEqual(cp.generation,historyKey.generation);
assert.equal(cp.period.device,checkpoint.certificate.device.device);
const checkpointSignature=Buffer.from(checkpoint.signature);
const checkpointBody=b=>frame('rocketvibe-history-backup-checkpoint-v1',[b,uploader]);
assert(verify(null,checkpointBody(cp),ed(checkpoint.certificate.device.signature_key),checkpointSignature));
for(const change of [b=>b.count='1',b=>b.chain[0]^=1,b=>b.period.scope.room='foreign',b=>b.generation[0]^=1]){
  const changed=structuredClone(cp);change(changed);
  assert(!verify(null,checkpointBody(changed),ed(checkpoint.certificate.device.signature_key),checkpointSignature));
}

// Period id and secret: HKDF of the history key with the period domain and id.
const periodId=sha(frame('rocketvibe-history-backup-period-v1',[cp.generation,cp.period]));
const periodSecret=expand(extract(empty,Buffer.from(historyKey.key,'hex')),
  Buffer.concat([Buffer.from('rocketvibe-history-backup-period-v1\0'),periodId]),32);

// Records: attested by the uploader, rank-bound, decrypted, chained to the checkpoint.
let chain=chainStart();
records.forEach((record,index)=>{
  assert.deepEqual(record.certificate,checkpoint.certificate);
  assert.deepEqual(record.header.origin.header.scope,cp.period.scope);
  assert(verify(null,recordBody(record),ed(record.certificate.device.signature_key),Buffer.from(record.signature)));
  const payload=openRecord(record,periodSecret,index+1);
  assert.equal(payload.message.operation_id,record.header.origin.header.operation);
  assert.equal(payload.message.reply_to??null,record.header.origin.header.thread);
  assert.throws(()=>openRecord(record,periodSecret,index+2));
  chain=chainNext(chain,recordFingerprint(record));
});
assert.equal(cp.count,String(records.length));
assert.equal(cp.first,records[0].header.origin.position);
assert.equal(cp.last,records.at(-1).header.origin.position);
assert.deepEqual(list(chain),cp.chain);
console.log('Public history backup vector: code, key package, publication, period secret, records and checkpoint verified independently');
