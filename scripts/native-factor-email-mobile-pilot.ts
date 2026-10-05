/** Disposable HTTP/PostgreSQL/SMTP fixture. Portable private storage exercises
 * vault restart; installed Android Keystore qualification remains separate. */
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {AuthenticationVault} from '../apps/mobile/providers/rocketvibe/authenticationVault.ts';
import {startNativeLogin} from '../apps/mobile/providers/rocketvibe/authentication.ts';
import {ReauthenticationVault} from '../apps/mobile/providers/rocketvibe/reauthenticationVault.ts';
import {NativeChat} from '../apps/mobile/providers/rocketvibe/chat.ts';
import {NativeStore} from '../apps/mobile/providers/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/providers/rocketvibe/testDatabase.ts';
import {NativeError,NativeTransport} from '../apps/mobile/providers/rocketvibe/transport.ts';
import {createWriteQueue} from '../apps/mobile/db/writeQueue.ts';
import type {Session} from '../apps/mobile/lib/auth.ts';

let phase='initialization';
async function main(){
  const base=process.argv[2],token=process.env.RV_FACTOR_EMAIL_PILOT_TOKEN,password=process.env.RV_FACTOR_EMAIL_PILOT_PASSWORD;
  if(!base || !token || !password)throw new Error();
  const lost=new Set<string>();let starts=0,finishes=0;
  const fetcher:typeof fetch=async(url,options)=>{
    const response=await fetch(url,options),path=new URL(String(url)).pathname;
    const lose=['/api/v1/auth/factors/email/start','/api/v1/auth/factors/verify','/api/v1/me/reauth/email/start','/api/v1/me/reauth/finish'].includes(path);
    if(path.endsWith('/email/start'))starts++;
    if(path.endsWith('/factors/verify') || path.endsWith('/reauth/finish'))finishes++;
    if(lose && response.ok && !lost.has(path)){
      lost.add(path);await response.arrayBuffer();throw new NativeError(0,'network_or_protocol_error');
    }
    return response;
  };
  const transport=new NativeTransport(base,fetcher);transport.restore(token);
  const discovery=await transport.discover(),user=await transport.me();
  const active:Session={baseUrl:base,authToken:token,userId:user.id,username:user.username,siteUrl:null,kind:'rocketvibe',
    nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
  const values=new Map<string,string>();
  const deps={hash:async(value:string)=>createHash('sha256').update(value).digest('hex'),token:async()=>randomBytes(32).toString('hex'),
    storage:{read:async(key:string)=>values.get(key)??null,write:async(key:string,value:string)=>{values.set(key,value);},remove:async(key:string)=>{values.delete(key);}}};
  const authentication=()=>new AuthenticationVault({...deps,fetcher}),proof=()=>new ReauthenticationVault(deps);
  async function receive():Promise<string>{
    const response=await fetch(`${base}/__factor_email_fixture/deliver`,{headers:{authorization:`Bearer ${token}`}});
    if(!response.ok)throw new Error();
    const message=await response.json() as {delivered:number;code:string};
    assert(message.delivered===1 && /^\d{8}$/.test(message.code));return message.code;
  }
  phase='password challenge';
  const fresh=await startNativeLogin(base,discovery,{user:user.username,password:password},fetcher);assert(fresh.kind==='challenge');
  const staged=await authentication().stage(fresh.challenge);assert(staged.kind==='challenge');
  phase='lost login mail ACK';await assert.rejects(authentication().sendEmail(staged.challenge));
  const restored=await authentication().load(base,user.username);assert(restored?.email);
  const pending=await authentication().sendEmail(restored);assert(pending.email?.status && starts===1);
  phase='actual login SMTP';let code=await receive();
  const delivered=await authentication().sendEmail(pending);assert(delivered.email?.status?.delivery==='accepted' && starts===1);
  phase='lost factor verification ACK';await assert.rejects(authentication().finish(delivered,'email',code));
  assert([...values.values()].every(raw=>!raw.includes(code)));code='';
  const completed=await authentication().finish(delivered,'email','');
  assert(completed.userId===active.userId && completed.authToken!==active.authToken);
  assert(await authentication().clearCompleted(delivered,completed));assert(values.size===0);
  assert((await transport.me()).id===active.userId);
  const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,createWriteQueue(),active);
  const chat=new NativeChat(active,store,()=>randomBytes(32).toString('hex'),{transport});
  try {
    phase='connected account provider';await chat.connect();assert(chat.status.online);
    const access=await chat.security();
    phase='same-family password challenge';const first=await proof().prepare(access.scope,access.remote.proof,password,access.alive);assert(first.kind==='challenge');
    phase='lost proof mail ACK';await assert.rejects(proof().sendEmail(first.attempt,access.remote.proof,false,access.alive));
    const restored=await proof().prepare(access.scope,access.remote.proof,'',access.alive);assert(restored.kind==='challenge' && restored.attempt.email);
    const pending=await proof().sendEmail(restored.attempt,access.remote.proof,false,access.alive);assert(pending.kind==='challenge' && starts===2);
    phase='actual proof SMTP';code=await receive();
    phase='lost same-family proof ACK';await assert.rejects(proof().finish(pending.attempt,access.remote.proof,'email',code,access.alive));
    assert([...values.values()].every(raw=>!raw.includes(code)));code='';
    const accepted=await proof().prepare(access.scope,access.remote.proof,'',access.alive);assert(accepted.kind==='ready' && values.size===0);
    assert(starts===2 && finishes===2 && (await access.remote.proof.status()).recent);
    phase='closed provider callback';chat.stop();
    await assert.rejects(access.remote.proof.email!.resume(pending.attempt.email!.input),e=>e instanceof NativeError && e.code==='session_closed');
    process.stdout.write('native factor email mobile pilot: verified\n');
  } finally {chat.stop();await store.state();db.close();}
}
void main().catch(()=>{process.stderr.write(`Native factor email mobile pilot failed during ${phase}\n`);process.exitCode=1;});
