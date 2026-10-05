// Public signatures/ciphertext only. This verifies framing with Node/OpenSSL;
// AEAD decryption, key lifetime and author admission are separate private tests.
import {readFileSync} from 'node:fs';
import {createHash,createPublicKey,verify} from 'node:crypto';
import assert from 'node:assert/strict';
const packet=JSON.parse(readFileSync(new URL('../fixtures/archive-document-v1.json',import.meta.url),'utf8'));
const frame=(purpose,value)=>Buffer.concat([Buffer.from(purpose+'\0'),Buffer.from(JSON.stringify(value))]);
const key=bytes=>createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:Buffer.from(bytes).toString('base64url')}});
const certificate=packet.certificate;
assert(verify(null,frame('rocketvibe-device-certificate-v1',certificate.device),key(certificate.device.root.public_key),Buffer.from(certificate.signature)));
const original=packet.original_certificate;
assert(verify(null,frame('rocketvibe-device-certificate-v1',original.device),key(original.device.root.public_key),Buffer.from(original.signature)));
assert.deepEqual(certificate.device.root,original.device.root);
const certificateDigest=c=>[...createHash('sha256').update(frame('rocketvibe-certificate-fingerprint-v1',c)).digest()];
assert.deepEqual(certificateDigest(original),packet.header.origin.header.certificate);
assert.equal(packet.header.origin.position,'9007199254740995');
assert.equal(packet.header.origin.header.group_revision,'9007199254740993');
assert.equal(packet.header.origin.header.epoch,'9007199254740994');
const ciphertext=()=>[...createHash('sha256').update(Buffer.from(packet.ciphertext)).digest()];
const leaf=key(certificate.device.signature_key);
const signature=Buffer.from(packet.signature);
const body=header=>[header,certificateDigest(original),certificateDigest(certificate),ciphertext()];
assert(verify(null,frame('rocketvibe-archive-document-proof-v1',body(packet.header)),leaf,signature));
assert(!verify(null,frame('rocketvibe-mls-application-proof-v1',body(packet.header)),leaf,signature));
const changes=[
  h=>h.origin.header.scope.room='foreign', h=>h.origin.header.scope.data_epoch='restored',
  h=>h.origin.header.scope.incarnation[0]^=1, h=>h.origin.header.author='bob',
  h=>h.origin.header.device='other-device', h=>h.origin.header.incarnation[0]^=1,
  h=>h.origin.header.thread='another-thread', h=>h.origin.position='9007199254740996',
  h=>h.author_membership.access_version='9007199254740998',
  h=>h.author_membership.activation_version='9007199254740998',
  h=>h.key_id[0]^=1, h=>h.nonce[0]^=1,
];
for(const change of changes) {
  const changed=structuredClone(packet.header);change(changed);
  assert(!verify(null,frame('rocketvibe-archive-document-proof-v1',body(changed)),leaf,signature));
}
packet.ciphertext[0]^=1;
assert(!verify(null,frame('rocketvibe-archive-document-proof-v1',body(packet.header)),leaf,signature));
console.log('Public archive vector: root/device signatures, exact positions, packet binding and substitutions verified independently');
