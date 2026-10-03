// Independent Node/OpenSSL check of the public v1 fixture, not app crypto.
import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
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
