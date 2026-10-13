// Re-signs the public vectors that no Rust example writes: the archive and
// root backup fixtures, and the protocol fixture's copies of the identity,
// enrollment, revocation and root backup vectors. Every key comes from a
// public fixture seed, never an account key.
//   node crates/rv-crypto-public/scripts/sign-vectors.mjs [domain-prefix]
// Run the identity and enrollment examples of crates/rv-crypto first.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';

const prefix = process.argv[2] ?? 'vibez';
const at = (path) => new URL(`../../../${path}`, import.meta.url);
const read = (path) => JSON.parse(readFileSync(at(path), 'utf8'));
const frame = (purpose, value) =>
  Buffer.concat([Buffer.from(`${prefix}-${purpose}-v1\0`), Buffer.from(JSON.stringify(value))]);
const sha = (...parts) => [...parts.reduce((h, p) => h.update(p), createHash('sha256')).digest()];
const seeded = (byte) => {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, byte)]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const raw = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(12);
  return { public: [...raw], sign: (bytes) => [...sign(null, bytes, key)] };
};
const root = (r) => ({ version: r.version, instance: r.instance, user: r.user, generation: r.generation, public_key: r.public_key });
const rootFingerprint = (r) => sha(frame('root-fingerprint', root(r)));
const certify = (rootKey, device) => ({ device, signature: rootKey.sign(frame('device-certificate', device)) });
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const unb64 = (text) => JSON.parse(Buffer.from(text, 'base64url'));

// Archive document: a disposable root and device over the stored header.
const archive = read('crates/rv-crypto-public/fixtures/archive-document-v1.json');
const archiveRoot = seeded(0x31);
const archiveDevice = seeded(0x32);
const device = archive.certificate.device;
device.root.public_key = archiveRoot.public;
device.signature_key = archiveDevice.public;
archive.certificate = certify(archiveRoot, device);
archive.original_certificate = structuredClone(archive.certificate);
const certificateDigest = (c) => sha(frame('certificate-fingerprint', c));
const origin = archive.header.origin;
origin.header.certificate = certificateDigest(archive.original_certificate);
origin.message = hex(sha(Buffer.from(`${prefix}-mls-message-id-v1\0`), Buffer.from(origin.fingerprint))).slice(0, 32);
archive.signature = archiveDevice.sign(frame('archive-document-proof', [
  archive.header, certificateDigest(archive.original_certificate), certificateDigest(archive.certificate),
  sha(Buffer.from(archive.ciphertext)),
]));

// Root backup publication: signed by its own disposable root.
const publication = read('crates/rv-crypto-public/fixtures/root-backup-publication-v1.json');
const backupRoot = seeded(0x25);
publication.packet.header.root.public_key = backupRoot.public;
publication.body.packet_digest = sha(Buffer.from(JSON.stringify(publication.packet)));
publication.signature = backupRoot.sign(frame('root-backup-publication', publication.body));

// The protocol fixture carries the same vectors, base64url-encoded.
const protocol = read('docs/protocol/v1.fixture.json');
const p = protocol.parity;
const identity = read('crates/rv-crypto/fixtures/identity-certificate-v1.json');
const enrollment = read('crates/rv-crypto/fixtures/enrollment-v1.json');
p.e2ee_directory.devices[0].certificate = b64(identity);
p.e2ee_register_device.request = b64(enrollment.request);
p.e2ee_register_device.grant = b64(enrollment.grant);
const identityRoot = seeded(7);
const revocation = unb64(p.e2ee_revoke_device.signed);
revocation.signature = identityRoot.sign(frame('device-revocation', [root(revocation.root), revocation.device, revocation.incarnation]));
p.e2ee_revoke_device.signed = b64(revocation);
p.e2ee_directory.identity.fingerprint = hex(rootFingerprint(unb64(p.e2ee_directory.identity.root)));
p.e2ee_operation_receipt.root_fingerprint = hex(rootFingerprint(identity.device.root));
p.e2ee_publish_root_backup.publication = b64(publication);
p.e2ee_root_backup.active.publication = b64(publication);
for (const receipt of [p.e2ee_root_backup.active.receipt, p.e2ee_root_backup_settlement.data]) {
  receipt.root_fingerprint = hex(rootFingerprint(publication.packet.header.root));
  receipt.packet_digest = hex(publication.body.packet_digest);
}

const write = (path, value, text) => writeFileSync(at(path), text(value));
// Exactly the canonical bytes: the archive parser refuses anything else.
write('crates/rv-crypto-public/fixtures/archive-document-v1.json', archive, (v) => JSON.stringify(v));
write('crates/rv-crypto-public/fixtures/root-backup-publication-v1.json', publication, (v) => JSON.stringify(v) + '\n');
const source = readFileSync(at('docs/protocol/v1.fixture.json'), 'utf8');
const lines = source.split('\n').map((line) => {
  const match = /^    "(e2ee_[a-z_]+)": (.*?)(,?)$/.exec(line);
  return match && match[1] in p ? `    "${match[1]}": ${JSON.stringify(p[match[1]])}${match[3]}` : line;
});
writeFileSync(at('docs/protocol/v1.fixture.json'), lines.join('\n'));
console.log(`signed the public vectors under ${prefix}-*-v1`);
