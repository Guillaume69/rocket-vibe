// Code TOTP (RFC 6238, SHA-1, 6 chiffres, 30 s) depuis un secret base32.
// Aucune dépendance : node:crypto suffit.
//
//   node e2e/harness/totp.mjs <SECRET_BASE32>

import { createHmac } from 'node:crypto';

export function decoderBase32(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let valeur = 0;
  const octets = [];
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const i = alphabet.indexOf(c);
    if (i === -1) continue;
    valeur = (valeur << 5) | i;
    bits += 5;
    if (bits >= 8) {
      octets.push((valeur >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(octets);
}

export function totp(secretBase32, quand = Date.now()) {
  const compteur = Math.floor(quand / 1000 / 30);
  const tampon = Buffer.alloc(8);
  tampon.writeBigUInt64BE(BigInt(compteur));
  const hmac = createHmac('sha1', decoderBase32(secretBase32)).update(tampon).digest();
  const decalage = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(decalage) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secret = process.argv[2];
  // Décalage optionnel en secondes : `+30` = code de la fenêtre SUIVANTE,
  // encore valide (tolérance ±1) pendant toute la durée d'un flow Maestro.
  const decalage = Number(process.argv[3] ?? 0) * 1000;
  if (!secret) {
    console.error('usage: node totp.mjs <SECRET_BASE32> [décalage_s]');
    process.exit(1);
  }
  console.log(totp(secret, Date.now() + decalage));
}
