/** One-use encrypted browser handoff. Crypto resolves to native OpenSSL on mobile. */
import { createDecipheriv, randomBytes, createPrivateKey, createPublicKey, diffieHellman, createHmac } from 'crypto';
import { Buffer } from 'buffer';
import { SlackError, validateCredentials } from './client.ts';
function record(v: unknown): Record<string, unknown> { if(!v || typeof v!=='object' || Array.isArray(v)) throw new SlackError('invalid_handoff'); return v as Record<string, unknown>; }

// Node and Quick Crypto accept private KeyObjects; the current Node typings omit that overload.
const publicOf = createPublicKey as unknown as (key: import('crypto').KeyObject | Parameters<typeof createPublicKey>[0]) => import('crypto').KeyObject;
const AAD = 'rocketvibe-slack-handoff-v1';
export type SlackBrowserSession = { account: {teamId:string;userId:string}; token:string; cookie:string; expiresAt:number };
const PRIVATE_PREFIX = Buffer.from('302e020100300506032b656e04220420','hex');
const PUBLIC_PREFIX = Buffer.from('302a300506032b656e032100','hex');
function privateObject(seed: Uint8Array) { return createPrivateKey({key:Buffer.concat([PRIVATE_PREFIX,Buffer.from(seed)]),format:'der',type:'pkcs8'}); }
function derive(seed: Uint8Array, peer: Buffer): Buffer {
  const privateKey=privateObject(seed),recipient=Buffer.from(publicOf(privateKey).export({format:'der',type:'spki'})).subarray(-32);
  const shared=diffieHellman({privateKey,publicKey:createPublicKey({key:Buffer.concat([PUBLIC_PREFIX,peer]),format:'der',type:'spki'})});
  const prk=createHmac('sha256',Buffer.alloc(32)).update(shared).digest();
  try { return createHmac('sha256',prk).update(AAD).update(recipient).update(peer).update(Buffer.from([1])).digest(); }
  finally { shared.fill(0);prk.fill(0); }
}
/** Only the public code enters the clipboard. The private seed never leaves this object. */
export class Pairing {
  #seed: Buffer|null;
  constructor(seed: Uint8Array = randomBytes(32)) { if(seed.length!==32) throw new SlackError('invalid_handoff'); this.#seed=Buffer.from(seed); }
  code(): string { if(!this.#seed) throw new SlackError('pairing_closed'); return encode(Buffer.from(publicOf(privateObject(this.#seed)).export({format:'der',type:'spki'})).subarray(-32)); }
  open(code: string,now=Date.now()): SlackBrowserSession { if(!this.#seed) throw new SlackError('pairing_closed'); const result=openHandoff(this.#seed,code,now);this.close();return result; }
  rotate(): string { this.close();this.#seed=Buffer.from(randomBytes(32));return this.code(); }
  close(): void {this.#seed?.fill(0);this.#seed=null;}
}
function encode(value: Uint8Array): string { return Buffer.from(value).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new SlackError('invalid_handoff');
  const bytes = Buffer.from(value.replace(/-/g,'+').replace(/_/g,'/'),'base64');
  if (encode(bytes) !== value) throw new SlackError('invalid_handoff');
  return bytes;
}
/** Caller consumes its pairing key on successful import, close, hide or cancellation. */
function openHandoff(seed: Uint8Array, code: string, now = Date.now()): SlackBrowserSession {
  if (code.length > 300000 || seed.length !== 32) throw new SlackError('invalid_handoff');
  const pieces = code.split('.');
  if (pieces.length !== 4 || pieces[0] !== 'rvslack1') throw new SlackError('invalid_handoff');
  const peer=decode(pieces[1]), nonce=decode(pieces[2]), sealed=decode(pieces[3]);
  if (peer.length !== 32 || nonce.length !== 12 || sealed.length < 17 || sealed.length > 200000) throw new SlackError('invalid_handoff');
  let plain: Buffer | undefined, secret: Buffer | undefined;
  try {
    secret=derive(seed,peer);
    const decipher=createDecipheriv('aes-256-gcm',secret,nonce);
    decipher.setAAD(Buffer.from(AAD));decipher.setAuthTag(sealed.subarray(-16));
    plain=Buffer.concat([decipher.update(sealed.subarray(0,-16)),decipher.final()]);
    const body=record(JSON.parse(plain.toString('utf8'))), a=record(body.account);
    if (body.version !== 1 || typeof a.teamId !== 'string' || !/^T[A-Z0-9]{1,127}$/.test(a.teamId) || typeof a.userId !== 'string' || !/^[UW][A-Z0-9]{1,127}$/.test(a.userId)) throw new SlackError('invalid_handoff');
    const account={teamId:a.teamId,userId:a.userId};
    if (typeof body.transferExpiresAt !== 'number' || !Number.isSafeInteger(body.transferExpiresAt) || body.transferExpiresAt <= now || body.transferExpiresAt > now+300000 || typeof body.expiresAt !== 'number' || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= now+60000 || body.expiresAt > now+3600000) throw new SlackError('expired_handoff');
    if(typeof body.token!=='string'||typeof body.cookie!=='string') throw new SlackError('invalid_handoff');
    validateCredentials(body.token,body.cookie);
    return {account,token:body.token,cookie:body.cookie,expiresAt:body.expiresAt};
  } catch(e) { if(e instanceof SlackError) throw e; throw new SlackError('invalid_handoff'); }
  finally { secret?.fill(0);plain?.fill(0); }
}
