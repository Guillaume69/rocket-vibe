// Independent Node/OpenSSL check of the public v1 fixture, not app crypto.
import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import assert from 'node:assert/strict';
const certificate = JSON.parse(readFileSync(new URL('../fixtures/identity-certificate-v1.json', import.meta.url), 'utf8'));
const source = certificate.device;
// Reconstruct the prescribed field order rather than trusting input JSON order.
const device = {
  version: source.version,
  root: { version: source.root.version, instance: source.root.instance, user: source.root.user,
    generation: source.root.generation, public_key: source.root.public_key },
  device: source.device, incarnation: source.incarnation, serial: source.serial, suite: source.suite,
  signature_key: source.signature_key, issued_at: source.issued_at, expires_at: source.expires_at,
};
const key = createPublicKey({ format: 'jwk', key: {
  kty: 'OKP', crv: 'Ed25519', x: Buffer.from(source.root.public_key).toString('base64url'),
}});
const frame = (payload) => Buffer.concat([Buffer.from('rocketvibe-device-certificate-v1\0'), Buffer.from(JSON.stringify(payload))]);
assert.equal(verify(null, frame(device), key, Buffer.from(certificate.signature)), true);
assert.equal(verify(null, frame({ ...device, device: 'substituted-device' }), key, Buffer.from(certificate.signature)), false);
assert.equal(verify(null, Buffer.concat([Buffer.from('rocketvibe-device-revocation-v1\0'), Buffer.from(JSON.stringify(device))]), key, Buffer.from(certificate.signature)), false);
console.log('Public identity fixture: independent Node Ed25519 verification and substitution/domain checks passed');
const enrollment = JSON.parse(readFileSync(new URL('../fixtures/enrollment-v1.json', import.meta.url), 'utf8'));
const rootValue = (root) => ({ version: root.version, instance: root.instance, user: root.user,
  generation: root.generation, public_key: root.public_key });
const body = enrollment.request.body;
const requestBody = { version: body.version, root: rootValue(body.root), device: body.device,
  incarnation: body.incarnation, request_id: body.request_id, signature_key: body.signature_key,
  issued_at: body.issued_at, expires_at: body.expires_at };
const purposeFrame = (domain, value) => Buffer.concat([Buffer.from(`${domain}\0`), Buffer.from(JSON.stringify(value))]);
const leafKey = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519',
  x: Buffer.from(body.signature_key).toString('base64url') } });
assert.equal(verify(null, purposeFrame('rocketvibe-device-request-v1', requestBody), leafKey,
  Buffer.from(enrollment.request.signature)), true);
assert.equal(verify(null, purposeFrame('rocketvibe-device-request-v1', { ...requestBody, device: 'foreign-device' }),
  leafKey, Buffer.from(enrollment.request.signature)), false);
const orderedRequest = { body: requestBody, signature: enrollment.request.signature };
const digest = createHash('sha256').update(purposeFrame('rocketvibe-request-fingerprint-v1', orderedRequest)).digest();
assert.deepEqual(digest, Buffer.from(enrollment.grant.request));
assert.deepEqual(enrollment.grant.certificate, certificate);
const orderedCertificate = { device, signature: certificate.signature };
assert.equal(verify(null, purposeFrame('rocketvibe-device-grant-v1', [enrollment.grant.request, orderedCertificate]), key,
  Buffer.from(enrollment.grant.signature)), true);
assert.equal(verify(null, purposeFrame('rocketvibe-device-grant-v1', [Array(32).fill(0), orderedCertificate]), key,
  Buffer.from(enrollment.grant.signature)), false);
console.log('Public enrollment fixture: independent request proof, request fingerprint and exact grant verification passed');
const protocol=JSON.parse(readFileSync(new URL('../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const withdrawal=JSON.parse(Buffer.from(protocol.parity.e2ee_revoke_device.signed,'base64url').toString('utf8'));
const withdrawalFrame=(device)=>purposeFrame('rocketvibe-device-revocation-v1',
  [rootValue(withdrawal.root),device,withdrawal.incarnation]);
assert.deepEqual(withdrawal.root,device.root);
assert.equal(verify(null,withdrawalFrame(withdrawal.device),key,Buffer.from(withdrawal.signature)),true);
assert.equal(verify(null,withdrawalFrame('substituted-leaf'),key,Buffer.from(withdrawal.signature)),false);
console.log('Public revocation fixture: independent root signature and target substitution checks passed');
