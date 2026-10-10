/** Slack-only acquisition and encrypted transfer. Never imports an existing profile. */
import { createPublicKey,createCipheriv,randomBytes,generateKeyPairSync,diffieHellman,createHmac } from 'node:crypto';
export class BridgeError extends Error { constructor(code){super(code);this.code=code;} }
const fail=code=>{throw new BridgeError(code);};
export function slackUrl(raw,client=false){
 try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port||!/^([a-z0-9-]+\.)?slack\.com$/.test(u.hostname))return null;
 if(client&&!/^\/(client|app)(\/|$)/.test(u.pathname))return null;return u;}catch{return null;}
}
export function credentials(token,cookie){if(typeof token!=='string'||!/^xoxc-[A-Za-z0-9-]+$/.test(token)||token.length>16384||typeof cookie!=='string'||!cookie.startsWith('xoxd-')||cookie.length<=5||cookie.length>16384||/[^\x21-\x7e]|[;,"\\]/.test(cookie))fail('invalid_credentials');}
export function candidates(url,config,bootToken){
 const u=slackUrl(url,true);if(!u)return [];
 const selected=/^\/(?:client|app)\/(T[A-Z0-9]+)(?:\/|$)/.exec(u.pathname)?.[1];
 let teams;try{if(typeof config==='string'&&config.length<=2000000)teams=JSON.parse(config)?.teams;}catch{}
 const found=new Map();
 if(teams&&typeof teams==='object')for(const [key,t] of Object.entries(teams).slice(0,100)){
  if(!t||typeof t!=='object')continue;const id=typeof t.id==='string'?t.id:key;
  const url=typeof t.url==='string'&&t.url?t.url:typeof t.domain==='string'&&/^[a-z0-9-]+$/.test(t.domain)?'https://'+t.domain+'.slack.com/':null;
  if(!/^T[A-Z0-9]{1,127}$/.test(id)||!slackUrl(url))continue;
  try{credentials(t.token,'xoxd-placeholder');found.set(id,{teamId:id,token:t.token});}catch{}
 }
 if(selected&&typeof bootToken==='string'){try{credentials(bootToken,'xoxd-placeholder');found.set(selected,{teamId:selected,token:bootToken});}catch{}}
 return [...found.values()].slice(0,20);
}
export function sessionCookie(cookies,url,now=Date.now()){
 const u=slackUrl(url,true);if(!u||!Array.isArray(cookies))return null;
 const accepted=cookies.filter(c=>{
  const domain=typeof c.domain==='string'?c.domain.replace(/^\./,''):'';
  return c.name==='d'&&c.secure===true&&c.httpOnly===true&&slackUrl('https://'+domain)&& (u.hostname===domain||c.domain.startsWith('.')&&u.hostname.endsWith('.'+domain))&&typeof c.path==='string'&&u.pathname.startsWith(c.path)&&(!c.expires||c.expires===-1||c.expires*1000>now+60000);
 });
 if(accepted.length!==1)return null;
 try{credentials('xoxc-placeholder',accepted[0].value);}catch{return null;}
 return {cookie:accepted[0].value,expiresAt:accepted[0].expires>0?Math.min(now+3600000,Math.floor(accepted[0].expires*1000)):now+3600000};
}
async function bounded(response){let raw='';for await(const chunk of response.body){raw+=Buffer.from(chunk).toString();if(raw.length>256000)fail('response_too_large');}return JSON.parse(raw);}
export class SessionCollector {
 #sessions=new Map();#closed=false;#requests=new Set();
 constructor(fetcher=fetch,clock=()=>Date.now()){this.fetcher=fetcher;this.clock=clock;}
 async accept(candidate,session){
  if(this.#closed)fail('cancelled');credentials(candidate.token,session.cookie);this.#sessions.delete(candidate.teamId);
  const controller=new AbortController();this.#requests.add(controller);const timer=setTimeout(()=>controller.abort(),15000);
  try{
   const response=await this.fetcher('https://slack.com/api/auth.test',{method:'POST',redirect:'error',credentials:'omit',signal:controller.signal,headers:{Authorization:'Bearer '+candidate.token,Cookie:'d='+session.cookie,'Content-Type':'application/x-www-form-urlencoded; charset=utf-8'},body:''});
   if(!response.ok)fail(response.status===429?'ratelimited':'authentication_failed');
   const b=await bounded(response);if(b.ok!==true)fail('authentication_failed');
   if(b.team_id!==candidate.teamId||!/^T[A-Z0-9]{1,127}$/.test(b.team_id)||!/^([UW])[A-Z0-9]{1,127}$/.test(b.user_id)||!slackUrl(b.url))fail('identity_mismatch');
   if(this.#closed)fail('cancelled');
   this.#sessions.set(candidate.teamId,{account:{teamId:b.team_id,userId:b.user_id},token:candidate.token,cookie:session.cookie,expiresAt:Math.min(session.expiresAt,this.clock()+3600000),label:typeof b.team==='string'?b.team.slice(0,200):b.team_id});
  }catch(e){if(e instanceof BridgeError)throw e;fail(this.#closed?'cancelled':'authentication_failed');}finally{clearTimeout(timer);this.#requests.delete(controller);}
 }
 state(){const workspaces=[...this.#sessions.values()].filter(s=>s.expiresAt>this.clock()+60000).map(s=>({id:s.account.teamId,label:s.label}));return {ready:!this.#closed&&workspaces.length>0,workspaces};}
 seal(pairingKey,teamId){
  if(this.#closed)fail('cancelled');const s=this.#sessions.get(teamId);if(!s||s.expiresAt<=this.clock()+60000)fail('session_incomplete');
  return sealSession(pairingKey,{version:1,account:s.account,token:s.token,cookie:s.cookie,expiresAt:s.expiresAt,transferExpiresAt:this.clock()+300000});
 }
 invalidate(){this.#sessions.clear();}
 close(){this.#closed=true;this.#sessions.clear();for(const r of this.#requests)r.abort();}
}
export function sealSession(pairingKey,body){
 if(typeof pairingKey!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(pairingKey))fail('invalid_pairing_key');
 const recipient=Buffer.from(pairingKey,'base64url');if(recipient.length!==32||recipient.toString('base64url')!==pairingKey)fail('invalid_pairing_key');
 const ephemeral=generateKeyPairSync('x25519'),peer=Buffer.from(ephemeral.publicKey.export({format:'der',type:'spki'})).subarray(-32);
 let shared;try{shared=diffieHellman({privateKey:ephemeral.privateKey,publicKey:createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b656e032100','hex'),recipient]),format:'der',type:'spki'})});}catch{fail('invalid_pairing_key');}
 const aad='rocketvibe-slack-handoff-v1',prk=createHmac('sha256',Buffer.alloc(32)).update(shared).digest(),secret=createHmac('sha256',prk).update(aad).update(recipient).update(peer).update(Buffer.from([1])).digest();shared.fill(0);prk.fill(0);
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,nonce);cipher.setAAD(Buffer.from(aad));let plain;
 try{plain=Buffer.from(JSON.stringify(body));const encrypted=Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()]);return 'rvslack1.'+peer.toString('base64url')+'.'+nonce.toString('base64url')+'.'+encrypted.toString('base64url');}finally{secret.fill(0);plain?.fill(0);}
}
