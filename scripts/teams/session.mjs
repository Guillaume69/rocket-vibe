/** Official-browser response collector. No OAuth client ID, refresh call or access-token decoding. */
import { createPublicKey, verify, createCipheriv, randomBytes, generateKeyPairSync, diffieHellman, createHmac } from 'node:crypto';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCES={spaces:'https://api.spaces.skype.com',aggregator:'https://chatsvcagg.teams.microsoft.com',chat:'https://ic3.teams.office.com'};
export class BridgeError extends Error { constructor(code){super(code);this.code=code;} }
function fail(code){throw new BridgeError(code);}
function object(v){if(!v||typeof v!=='object'||Array.isArray(v))fail('invalid_response');return v;}
function part(s){if(typeof s!=='string'||s.length>65536||!s||!/^[A-Za-z0-9_-]+$/.test(s))fail('invalid_identity');const b=Buffer.from(s,'base64url');if(b.toString('base64url')!==s)fail('invalid_identity');return b;}
export function tokenRequest(url,post){
  let u;try{u=new URL(url);}catch{return null;}
  const match=/^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(u.pathname);
  if(u.origin!=='https://login.microsoftonline.com'||!match||u.username||u.password||u.hash||u.search||typeof post!=='string'||post.length>200000)return null;
  if(!['common','organizations'].includes(match[1])&&!UUID.test(match[1]))return null;
  const p=new URLSearchParams(post);if(p.getAll('client_id').length!==1||p.getAll('scope').length!==1)return null;const clientId=p.get('client_id');if(!UUID.test(clientId??''))return null;
  const scopes=(p.get('scope')??'').split(/\s+/),audiences=Object.entries(RESOURCES).filter(([,r])=>scopes.some(s=>s.startsWith(r+'/'))).map(([a])=>a);
  if(audiences.length!==1)return null;
  return {audience:audiences[0],clientId:clientId.toLowerCase(),authority:match[1].toLowerCase()};
}
async function microsoftKeys(fetcher){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
    const r=await fetcher('https://login.microsoftonline.com/common/discovery/v2.0/keys',{redirect:'error',credentials:'omit',signal:controller.signal});if(!r.ok)fail('identity_keys_unavailable');
    const raw=await r.text();if(raw.length>256000)fail('identity_keys_unavailable');const keys=object(JSON.parse(raw)).keys;if(!Array.isArray(keys)||keys.length>100)fail('identity_keys_unavailable');return keys;
  }catch(e){if(e instanceof BridgeError)throw e;fail('identity_keys_unavailable');}finally{clearTimeout(timer);}
}
export async function verifyIdentity(idToken,request,fetcher=fetch,now=Date.now()){
  if(typeof idToken!=='string'||idToken.length>65536)fail('identity_result_missing');
  const parts=idToken.split('.');if(parts.length!==3)fail('invalid_identity');
  let header,claims;try{header=object(JSON.parse(part(parts[0]).toString()));claims=object(JSON.parse(part(parts[1]).toString()));}catch{fail('invalid_identity');}
  const tid=claims.tid,oid=claims.oid;
  if(header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length>128||!UUID.test(tid??'')||!UUID.test(oid??'')||claims.aud!==request.clientId||claims.iss!=='https://login.microsoftonline.com/'+tid+'/v2.0'||claims.ver!=='2.0')fail('invalid_identity');
  if(UUID.test(request.authority)&&request.authority!==tid.toLowerCase())fail('tenant_mismatch');
  if(!Number.isSafeInteger(claims.exp)||claims.exp*1000<=now+60000||!Number.isSafeInteger(claims.nbf)||claims.nbf*1000>now+120000||!Number.isSafeInteger(claims.iat)||claims.iat*1000>now+120000)fail('expired_identity');
  const keys=await microsoftKeys(fetcher),jwk=keys.find(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.alg||k.alg==='RS256')&&(!k.use||k.use==='sig'));
  if(!jwk)fail('identity_key_missing');
  try{if(!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key:jwk,format:'jwk'}),part(parts[2])))fail('invalid_identity');}catch{fail('invalid_identity');}
  return {tenantId:tid.toLowerCase(),accountId:oid.toLowerCase(),expiresAt:claims.exp*1000};
}
export class SessionCollector {
  #entries=new Map(); #identity=null; #clientId=null; #closed=false;
  constructor(fetcher=fetch,clock=()=>Date.now()){this.fetcher=fetcher;this.clock=clock;}
  async accept(request,body){
    if(this.#closed)fail('cancelled');body=object(body);
    if(body.token_type!=='Bearer'||typeof body.access_token!=='string'||body.access_token.length>65536||!body.access_token||!/^[A-Za-z0-9._~+\/-]+=*$/.test(body.access_token)||!Number.isSafeInteger(body.expires_in)||body.expires_in<120||body.expires_in>86400)fail('invalid_token_response');
    // ID token is a supported identity result; opaque API access tokens are never decoded.
    const receivedAt=this.clock();
    const identity=await verifyIdentity(body.id_token,request,this.fetcher,this.clock());
    if(this.#closed)fail('cancelled');
    if(this.#identity&&(this.#identity.tenantId!==identity.tenantId||this.#identity.accountId!==identity.accountId)||this.#clientId&&this.#clientId!==request.clientId){this.close();fail('account_changed');}
    this.#identity={tenantId:identity.tenantId,accountId:identity.accountId};this.#clientId=request.clientId;
    this.#entries.set(request.audience,{token:body.access_token,expiresAt:Math.min(identity.expiresAt,receivedAt+body.expires_in*1000)});
  }
  state(){return {captured:Object.keys(RESOURCES).filter(a=>this.#entries.get(a)?.expiresAt>this.clock()+60000),ready:Object.keys(RESOURCES).every(a=>this.#entries.get(a)?.expiresAt>this.clock()+60000)};}
  seal(pairingKey){
    if(this.#closed)fail('cancelled');if(!this.state().ready)fail('session_incomplete');
    const recipient=part(pairingKey);if(recipient.length!==32)fail('invalid_pairing_key');
    const now=this.clock(),tokens=Object.fromEntries([...this.#entries].map(([a,v])=>[a,v.token]));
    const body={version:1,account:this.#identity,tokens,expiresAt:Math.min(...[...this.#entries.values()].map(v=>v.expiresAt)),transferExpiresAt:now+300000};
    const ephemeral=generateKeyPairSync('x25519'),peer=Buffer.from(ephemeral.publicKey.export({format:'der',type:'spki'})).subarray(-32);
    let shared;try {shared=diffieHellman({privateKey:ephemeral.privateKey,publicKey:createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b656e032100','hex'),recipient]),format:'der',type:'spki'})});}catch{fail('invalid_pairing_key');}
    const prk=createHmac('sha256',Buffer.alloc(32)).update(shared).digest();
    const secret=createHmac('sha256',prk).update('rocketvibe-teams-handoff-v2').update(recipient).update(peer).update(Buffer.from([1])).digest();shared.fill(0);prk.fill(0);
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,nonce);cipher.setAAD(Buffer.from('rocketvibe-teams-handoff-v2'));
    let plain;try{plain=Buffer.from(JSON.stringify(body));const encrypted=Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()]);return 'rvteams2.'+peer.toString('base64url')+'.'+nonce.toString('base64url')+'.'+encrypted.toString('base64url');}finally{secret.fill(0);plain?.fill(0);}
  }
  close(){this.#closed=true;this.#entries.clear();this.#identity=null;this.#clientId=null;}
}
