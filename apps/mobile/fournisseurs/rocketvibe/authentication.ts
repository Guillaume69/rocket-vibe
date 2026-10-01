/** Pre-authentication state is stored in its own SecureStore namespace, never
 * in the active Session, SQLite, a password or a persisted one-time code. */
import type { Credentials, Session as AccountSession } from '../../lib/auth.ts';
import type { AuthChallenge, Discovery, SecondFactor, Session, User } from './protocol.generated.ts';
import { NativeError, NativeTransport } from './transport.ts';

export type LoginChallenge={baseUrl:string;instanceId:string;dataEpoch:string;user:User;challenge:AuthChallenge;pending:{operation_id:string;next_token:string}|null};
export type LoginStep={kind:'session';session:AccountSession}|{kind:'challenge';challenge:LoginChallenge};
export type FactorDependencies={
  /** CSPRNG: 32 bytes encoded as lowercase hex, never Math.random. */
  token:()=>Promise<string>;
  /** Await a durable write with CAS/lease in the dedicated pre-auth vault. */
  save:(record:LoginChallenge)=>Promise<void>;
  fetcher?:typeof fetch;
};
const token=(value:unknown):value is string=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const timestamp=(value:unknown):value is string=>typeof value==='string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
function identity(record:LoginChallenge,discovery:Discovery):void {
  if(record.instanceId!==discovery.instance_id || record.dataEpoch!==discovery.data_epoch) throw new NativeError(409,'server_identity_changed');
}
export function validLoginChallenge(value:unknown):value is LoginChallenge {
  if(typeof value!=='object' || value===null)return false;
  const record=value as Partial<LoginChallenge>;
  if(Object.keys(record).some(k=>!['baseUrl','instanceId','dataEpoch','user','challenge','pending'].includes(k)))return false;
  if(typeof record.baseUrl!=='string' || typeof record.instanceId!=='string' || !record.instanceId || record.instanceId.length>128
    || typeof record.dataEpoch!=='string' || !record.dataEpoch || record.dataEpoch.length>128
    || typeof record.user?.id!=='string' || !record.user.id || record.user.id.length>128
    || typeof record.user.username!=='string' || !record.user.username || record.user.username.length>128 || typeof record.user.display_name!=='string'
    || Object.keys(record.user).some(k=>!['id','username','display_name'].includes(k))
    || !token(record.challenge?.challenge_id) || !timestamp(record.challenge.expires_at)
    || Object.keys(record.challenge).some(k=>!['challenge_id','methods','expires_at','resend_after_seconds'].includes(k))
    || !Number.isInteger(record.challenge.resend_after_seconds) || record.challenge.resend_after_seconds<0 || record.challenge.resend_after_seconds>4_294_967_295
    || !Array.isArray(record.challenge.methods) || record.challenge.methods.length<1 || record.challenge.methods.length>3
    || new Set(record.challenge.methods).size!==record.challenge.methods.length
    || record.challenge.methods.some(m=>!['totp','email','recovery_code'].includes(m)))return false;
  try {new NativeTransport(record.baseUrl);}catch{return false;}
  if(record.pending===null)return true;
  const p=record.pending;
  return typeof p==='object' && p!==null && Object.keys(p).length===2
    && typeof p.operation_id==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(p.operation_id)
    && token(p.next_token) && p.next_token!==record.challenge.challenge_id;
}
function validate(record:LoginChallenge):void {
  if(!validLoginChallenge(record))throw new NativeError(0,'invalid_native_authentication');
}
function account(record:Pick<LoginChallenge,'baseUrl'|'instanceId'|'dataEpoch'>,session:Session,expected?:string):AccountSession {
  if(!token(session.token) || !session.user.id || session.user.id.length>128 || expected!==undefined && session.user.id!==expected
    || !timestamp(session.expires_at) || Date.parse(session.expires_at)<=Date.now())throw new NativeError(502,'invalid_native_session');
  return {baseUrl:record.baseUrl,userId:session.user.id,username:session.user.username,authToken:session.token,genre:'rocketvibe',siteUrl:null,
    nativeInstanceId:record.instanceId,nativeDataEpoch:record.dataEpoch,nativeExpiresAt:session.expires_at};
}

export async function startNativeLogin(baseUrl:string,discovered:Discovery,credentials:Credentials,fetcher?:typeof fetch):Promise<LoginStep> {
  const transport=new NativeTransport(baseUrl,fetcher);
  const pinned={baseUrl:transport.baseUrl,instanceId:discovered.instance_id,dataEpoch:discovered.data_epoch};
  const fresh=await transport.discover();
  if(fresh.instance_id!==pinned.instanceId || fresh.data_epoch!==pinned.dataEpoch)throw new NativeError(409,'server_identity_changed');
  const step=fresh.capabilities.second_factors
    ? await transport.startLogin(credentials.utilisateur,credentials.motDePasse)
    : {kind:'session' as const,session:await transport.login(credentials.utilisateur,credentials.motDePasse)};
  const after=await transport.discover();
  if(after.instance_id!==pinned.instanceId || after.data_epoch!==pinned.dataEpoch)throw new NativeError(409,'server_identity_changed');
  if(step.kind==='session')return {kind:'session',session:account(pinned,step.session)};
  const record:LoginChallenge={...pinned,user:step.user,challenge:step.challenge,pending:null};
  validate(record);return {kind:'challenge',challenge:record};
}

async function recoverCandidate(record:LoginChallenge,transport:NativeTransport):Promise<AccountSession|null> {
  if(!record.pending)return null;
  transport.restore(record.pending.next_token);
  let user:User;
  try {user=await transport.me();}catch(error){
    if(error instanceof NativeError && error.status===401 && error.code==='session_rejected')return null;
    throw error;
  }
  if(user.id!==record.user.id)throw new NativeError(409,'server_identity_changed');
  const devices=await transport.deviceSessions();
  const active=devices.filter(d=>d.current);
  if(devices.length>64 || new Set(devices.map(d=>d.id)).size!==devices.length || devices.some(d=>!d.id) || active.length!==1)throw new NativeError(502,'invalid_native_session');
  identity(record,await transport.discover());
  return account(record,{token:record.pending.next_token,user,expires_at:active[0].expires_at},record.user.id);
}

/** Invitations and password resets must still finish full factor login. */
export async function startNativeAccountCodeLogin(baseUrl:string,discovered:Discovery,credentials:Credentials,code:string,recovery:boolean,fetcher?:typeof fetch):Promise<LoginStep> {
  const transport=new NativeTransport(baseUrl,fetcher);
  const fresh=await transport.discover();
  if(fresh.instance_id!==discovered.instance_id || fresh.data_epoch!==discovered.data_epoch)throw new NativeError(409,'server_identity_changed');
  if(!(recovery?fresh.capabilities.account_recovery:fresh.capabilities.account_invitations))throw new NativeError(409,recovery?'recovery_unavailable':'invitation_unavailable');
  const user=recovery
    ? await transport.recoverAccount({token:code,username:credentials.utilisateur,new_password:credentials.motDePasse})
    : await transport.acceptInvitation({token:code,username:credentials.utilisateur,password:credentials.motDePasse});
  const after=await transport.discover();
  if(after.instance_id!==discovered.instance_id || after.data_epoch!==discovered.data_epoch)throw new NativeError(409,'server_identity_changed');
  const result=await startNativeLogin(baseUrl,discovered,credentials,fetcher);
  const uid=result.kind==='session'?result.session.userId:result.challenge.user.id;
  if(uid!==user.id)throw new NativeError(409,'server_identity_changed');
  return result;
}

export async function recoverNativeFactor(record:LoginChallenge,fetcher?:typeof fetch):Promise<AccountSession|null> {
  validate(record);const transport=new NativeTransport(record.baseUrl,fetcher);
  identity(record,await transport.discover());
  return recoverCandidate(record,transport);
}

/** Leave the pending record intact until the active session has been saved.
 * Recover an acknowledged-on-server session even after the challenge expired. */
export async function finishNativeFactor(saved:LoginChallenge,method:SecondFactor,code:string,deps:FactorDependencies):Promise<AccountSession> {
  validate(saved);
  const record:LoginChallenge={...saved,user:{...saved.user},challenge:{...saved.challenge,methods:[...saved.challenge.methods]},pending:saved.pending && {...saved.pending}};
  const transport=new NativeTransport(record.baseUrl,deps.fetcher);
  const discovery=await transport.discover();identity(record,discovery);
  const completed=await recoverCandidate(record,transport);if(completed)return completed;
  if(!discovery.capabilities.second_factors)throw new NativeError(503,'factor_unavailable');
  if(Date.parse(record.challenge.expires_at)<=Date.now())throw new NativeError(400,'factor_expired');
  if(!record.challenge.methods.includes(method) || !code.trim() || code.length>128)throw new NativeError(400,'invalid_factor_code');
  if(!record.pending){
    record.pending={operation_id:await deps.token(),next_token:await deps.token()};validate(record);
    await deps.save(record); // No factor mutation if the secure write fails.
  }
  const pending=record.pending;
  const session=await transport.finishFactor({challenge_id:record.challenge.challenge_id,method,code:code.trim(),...pending});
  if(session.token!==pending.next_token)throw new NativeError(502,'invalid_native_session');
  identity(record,await transport.discover());
  return account(record,session,record.user.id);
}
