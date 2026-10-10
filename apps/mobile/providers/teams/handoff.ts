/** One-use encrypted browser handoff. Crypto resolves to native OpenSSL on mobile. */
import { createDecipheriv, randomBytes, createPrivateKey, createPublicKey, diffieHellman, createHmac } from 'crypto';
import { Buffer } from 'buffer';
import { TeamsError, accountKey, record, type TeamsAccount } from './protocol.ts';
import type { TeamsSessionTokens } from './reader.ts';

// Node and Quick Crypto accept private KeyObjects; the current Node typings omit that overload.
const publicOf = createPublicKey as unknown as (key: import('crypto').KeyObject | Parameters<typeof createPublicKey>[0]) => import('crypto').KeyObject;
const AAD = 'rocketvibe-teams-handoff-v2';
export type TeamsBrowserSession = { account: TeamsAccount; tokens: TeamsSessionTokens; expiresAt: number };
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
  constructor(seed: Uint8Array = randomBytes(32)) { if(seed.length!==32) throw new TeamsError('invalid_handoff'); this.#seed=Buffer.from(seed); }
  code(): string { if(!this.#seed) throw new TeamsError('pairing_closed'); return encode(Buffer.from(publicOf(privateObject(this.#seed)).export({format:'der',type:'spki'})).subarray(-32)); }
  open(code: string,now=Date.now()): TeamsBrowserSession { if(!this.#seed) throw new TeamsError('pairing_closed'); const result=openHandoff(this.#seed,code,now);this.close();return result; }
  rotate(): string { this.close();this.#seed=Buffer.from(randomBytes(32));return this.code(); }
  close(): void {this.#seed?.fill(0);this.#seed=null;}
}
function encode(value: Uint8Array): string { return Buffer.from(value).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TeamsError('invalid_handoff');
  const bytes = Buffer.from(value.replace(/-/g,'+').replace(/_/g,'/'),'base64');
  if (encode(bytes) !== value) throw new TeamsError('invalid_handoff');
  return bytes;
}
/** Caller consumes its pairing key on successful import, close, hide or cancellation. */
function openHandoff(seed: Uint8Array, code: string, now = Date.now()): TeamsBrowserSession {
  if (code.length > 300000 || seed.length !== 32) throw new TeamsError('invalid_handoff');
  const pieces = code.split('.');
  if (pieces.length !== 4 || pieces[0] !== 'rvteams2') throw new TeamsError('invalid_handoff');
  const peer=decode(pieces[1]), nonce=decode(pieces[2]), sealed=decode(pieces[3]);
  if (peer.length !== 32 || nonce.length !== 12 || sealed.length < 17 || sealed.length > 200000) throw new TeamsError('invalid_handoff');
  let plain: Buffer | undefined, secret: Buffer | undefined;
  try {
    secret=derive(seed,peer);
    const decipher=createDecipheriv('aes-256-gcm',secret,nonce);
    decipher.setAAD(Buffer.from(AAD));decipher.setAuthTag(sealed.subarray(-16));
    plain=Buffer.concat([decipher.update(sealed.subarray(0,-16)),decipher.final()]);
    const body=record(JSON.parse(plain.toString('utf8'))), a=record(body.account), t=record(body.tokens);
    if (body.version !== 1 || typeof a.tenantId !== 'string' || typeof a.accountId !== 'string') throw new TeamsError('invalid_handoff');
    const account={tenantId:a.tenantId,accountId:a.accountId};accountKey(account);
    if (typeof body.transferExpiresAt !== 'number' || !Number.isSafeInteger(body.transferExpiresAt) || body.transferExpiresAt <= now || body.transferExpiresAt > now+300000 || typeof body.expiresAt !== 'number' || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= now+60000 || body.expiresAt > now+86400000) throw new TeamsError('expired_handoff');
    if ([t.spaces,t.aggregator,t.chat].some(v=>typeof v !== 'string' || !v || v.length>65536 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(v))) throw new TeamsError('invalid_handoff');
    return {account,tokens:{spaces:t.spaces as string,aggregator:t.aggregator as string,chat:t.chat as string},expiresAt:body.expiresAt};
  } catch(e) { if(e instanceof TeamsError) throw e; throw new TeamsError('invalid_handoff'); }
  finally { secret?.fill(0);plain?.fill(0); }
}
