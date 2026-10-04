// TOTP code (RFC 6238, SHA-1, 6 digits, 30 s) from a base32 secret.
// No dependency: node:crypto is enough.
//
//   node e2e/harness/totp.mjs <SECRET_BASE32>

import { createHmac } from 'node:crypto';

export function decodeBase32(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const i = alphabet.indexOf(c);
    if (i === -1) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totp(secretBase32, when = Date.now()) {
  const counter = Math.floor(when / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', decodeBase32(secretBase32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secret = process.argv[2];
  // Optional offset in seconds: `+30` = code of the NEXT window, still valid
  // (±1 tolerance) for the whole length of a Maestro flow.
  const offset = Number(process.argv[3] ?? 0) * 1000;
  if (!secret) {
    console.error('usage: node totp.mjs <SECRET_BASE32> [offset_s]');
    process.exit(1);
  }
  console.log(totp(secret, Date.now() + offset));
}
