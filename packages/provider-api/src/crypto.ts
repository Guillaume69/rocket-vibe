/**
 * `content` object of an encrypted message. Three observed shapes:
 *   - `rc.v2` GCM (recent server): `{kid, iv(12 B), ciphertext(+tag)}`;
 *   - `rc.v2` CBC (old account): `{kid, iv(16 B), ciphertext}`;
 *   - `rc.v1` (legacy): `{ciphertext}` alone, where `ciphertext = keyID(12) +
 *     base64(IV(16) || AES-CBC)`, with no separate `iv`/`kid` field.
 * Hence OPTIONAL `iv`/`kid`.
 */
export type EncryptedContent = {
  algorithm: string;
  ciphertext: string;
  kid?: string;
  iv?: string;
};

/** A sent file's key, in the JWK shape the web client reimports (AES-CTR, extractable). */
export type FileJwk = { kty: 'oct'; alg: 'A256CTR'; k: string; ext: true; key_ops: ['encrypt', 'decrypt'] };
