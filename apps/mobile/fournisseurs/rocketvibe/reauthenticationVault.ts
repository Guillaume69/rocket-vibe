/** Existing-family proof. Only intent metadata enters private platform storage;
 * passwords/codes and the active bearer never do. The queue spans HTTP. */
import type {Hacheur} from '../../lib/auth.ts';
import {sansSlashFinal} from '../../lib/clesStockage.ts';
import type {AuthenticationStorage} from './authenticationVault.ts';
import type {AuthChallenge,BeginReauthentication,FinishReauthentication,ReauthenticationContext,ReauthenticationGrant,ReauthenticationStatus,ReauthenticationStep,ResumeReauthentication,RetireReauthentication,SecondFactor} from './protocol.generated.ts';
import {NativeError,NativeTransport} from './transport.ts';
import {decodeNative} from './validation.ts';
import {emailDeliveryIntent,sendFactorEmail,type EmailDeliveryIntent,type EmailDeliveryRemote} from './factorEmailDelivery.ts';

export type SecurityScope=ReauthenticationContext & {baseUrl:string};
export type SecurityGuard=()=>boolean;
export type ReauthenticationRemote={
  status:()=>Promise<ReauthenticationStatus>;
  begin:(input:BeginReauthentication)=>Promise<ReauthenticationStep>;
  resume:(input:ResumeReauthentication)=>Promise<ReauthenticationStep>;
  finish:(input:FinishReauthentication)=>Promise<ReauthenticationGrant>;
  retire:(input:RetireReauthentication)=>Promise<ReauthenticationStatus>;
  email?:EmailDeliveryRemote;
};
export type ReauthenticationAttempt={scope:SecurityScope;challenge_id:string;operation_id:string;proof_version:string;challenge:AuthChallenge|null;email?:EmailDeliveryIntent};
export type ReauthenticationView={kind:'ready'}|{kind:'password'}|{kind:'challenge';attempt:ReauthenticationAttempt};
export type SecurityDependencies={storage:AuthenticationStorage;hash:Hacheur;token:()=>Promise<string>};
const queues=new Map<string,Promise<void>>();
export function securityQueue<T>(key:string,action:()=>Promise<T>):Promise<T> {
  const result=(queues.get(key)??Promise.resolve()).then(action),settled=result.then(()=>{},()=>{});
  queues.set(key,settled);void settled.then(()=>{if(queues.get(key)===settled)queues.delete(key);});return result;
}
export function securityScope(value:SecurityScope):SecurityScope {
  const context=decodeNative('ReauthenticationContext',{user_id:value.user_id,device_id:value.device_id,instance_id:value.instance_id,data_epoch:value.data_epoch});
  if(Object.values(context).some(id=>!id || id.length>128))throw new NativeError(0,'invalid_native_security');
  return {...context,baseUrl:sansSlashFinal(new NativeTransport(value.baseUrl).baseUrl)};
}
export function securityContext(scope:SecurityScope):ReauthenticationContext {
  return {user_id:scope.user_id,device_id:scope.device_id,instance_id:scope.instance_id,data_epoch:scope.data_epoch};
}
export function checkSecurityScope(scope:SecurityScope,remote:ReauthenticationContext):void {
  if(Object.entries(securityContext(scope)).some(([key,value])=>remote[key as keyof ReauthenticationContext]!==value))throw new NativeError(409,'server_identity_changed');
}
export function securityAlive(guard:SecurityGuard):void {if(!guard())throw new NativeError(0,'session_closed');}
export async function securityKey(scope:SecurityScope,hash:Hacheur):Promise<string> {
  scope=securityScope(scope);
  return `native-security-${(await hash(JSON.stringify(['native-security-v1',scope.baseUrl,scope.user_id,scope.device_id,scope.instance_id,scope.data_epoch]))).slice(0,32)}`;
}
function unavailable(error:unknown):boolean {
  return error instanceof NativeError && ((error.status===404 && error.code==='reauthentication_not_found') || (error.status===400 && error.code==='reauthentication_rejected'));
}
function attempt(value:unknown,scope:SecurityScope):ReauthenticationAttempt {
  try {
    if(!value || typeof value!=='object')throw new Error();
    const v=value as ReauthenticationAttempt,s=securityScope(v.scope);checkSecurityScope(scope,s);
    if(Object.keys(v).some(key=>!['scope','challenge_id','operation_id','proof_version','challenge','email'].includes(key)))throw new Error();
    if(s.baseUrl!==scope.baseUrl || !/^[a-f0-9]{64}$/.test(v.challenge_id) || !/^[a-f0-9]{64}$/.test(v.operation_id)
      || typeof v.proof_version!=='string' || !v.proof_version || v.proof_version.length>128)throw new Error();
    const challenge=v.challenge===null?null:decodeNative('AuthChallenge',v.challenge);
    if(challenge && (challenge.challenge_id!==v.challenge_id || !Number.isFinite(Date.parse(challenge.expires_at))))throw new Error();
    if(v.email!==undefined && !challenge)throw new Error();
    return {scope:s,challenge_id:v.challenge_id,operation_id:v.operation_id,proof_version:v.proof_version,challenge:challenge && {...challenge,methods:[...challenge.methods]},
      ...(v.email!==undefined?{email:emailDeliveryIntent(v.email,challenge!)}:{})};
  } catch {throw new NativeError(0,'invalid_native_security');}
}

export class ReauthenticationVault {
  private readonly deps:SecurityDependencies;
  constructor(deps:SecurityDependencies){this.deps=deps;}
  private async read(key:string,scope:SecurityScope):Promise<ReauthenticationAttempt|null> {
    const raw=await this.deps.storage.read(`${key}-reauth`);if(raw===null)return null;
    let value:unknown;try{value=JSON.parse(raw);}catch{throw new NativeError(0,'invalid_native_security');}
    return attempt(value,scope);
  }
  private async live(scope:SecurityScope,remote:ReauthenticationRemote,guard:SecurityGuard):Promise<ReauthenticationStatus> {
    securityAlive(guard);const status=await remote.status();securityAlive(guard);checkSecurityScope(scope,status);return status;
  }
  private async probe(saved:ReauthenticationAttempt,remote:ReauthenticationRemote,guard:SecurityGuard):Promise<ReauthenticationStep|null> {
    securityAlive(guard);
    try{const result=await remote.resume({challenge_id:saved.challenge_id,operation_id:saved.operation_id});securityAlive(guard);return result;}
    catch(e){securityAlive(guard);if(unavailable(e))return null;throw e;}
  }
  private async accepted(key:string,saved:ReauthenticationAttempt,grant:ReauthenticationGrant,remote:ReauthenticationRemote,guard:SecurityGuard):Promise<ReauthenticationView> {
    checkSecurityScope(saved.scope,grant);
    const status=await this.live(saved.scope,remote,guard);
    if(!status.recent || status.proof_version!==grant.proof_version)throw new NativeError(409,'credentials_changed');
    securityAlive(guard);await this.deps.storage.remove(`${key}-reauth`);securityAlive(guard);return {kind:'ready'};
  }
  private async challenge(key:string,saved:ReauthenticationAttempt,value:AuthChallenge,guard:SecurityGuard):Promise<ReauthenticationView> {
    // SMTP can disappear after a code was delivered. Keep that previously
    // advertised method on this exact saved challenge; the server decides
    // whether its original code is still valid. A new challenge gets no merge.
    if(saved.email && saved.challenge?.methods.includes('email') && value.challenge_id===saved.challenge_id
      && value.expires_at===saved.challenge.expires_at && !value.methods.includes('email')) {
      value={...value,methods:[...value.methods,'email']};
    }
    const next=attempt({...saved,challenge:value},saved.scope);securityAlive(guard);
    await this.deps.storage.write(`${key}-reauth`,JSON.stringify(next));securityAlive(guard);
    return {kind:'challenge',attempt:next};
  }
  /** Empty password is recovery/read-only, never a new password attempt. */
  async prepare(scope:SecurityScope,remote:ReauthenticationRemote,password='',guard:SecurityGuard=()=>true):Promise<ReauthenticationView> {
    scope=securityScope(scope);const key=await securityKey(scope,this.deps.hash);
    return securityQueue(key,async()=>{
      let status=await this.live(scope,remote,guard);
      const saved=await this.read(key,scope);securityAlive(guard);
      if(saved){
        const result=await this.probe(saved,remote,guard);
        if(result?.kind==='granted')return this.accepted(key,saved,result.grant,remote,guard);
        if(result?.kind==='challenge')return this.challenge(key,saved,result.challenge,guard);
        // A missing/expired row alone is not a barrier against a delayed start.
        // Retire its requested head, then recover a finish which won that race.
        securityAlive(guard);status=await remote.retire({context:securityContext(scope),proof_version:saved.proof_version});
        securityAlive(guard);checkSecurityScope(scope,status);
        if(status.proof_version===saved.proof_version)throw new NativeError(502,'invalid_native_security');
        const after=await this.probe(saved,remote,guard);
        if(after?.kind==='granted')return this.accepted(key,saved,after.grant,remote,guard);
        if(after)throw new NativeError(502,'invalid_native_security');
        securityAlive(guard);await this.deps.storage.remove(`${key}-reauth`);securityAlive(guard);
      }
      if(status.recent)return {kind:'ready'};
      if(!password)return {kind:'password'};
      if(password.length>1024)throw new NativeError(0,'invalid_native_security');
      const candidate=await this.deps.token(),operation=await this.deps.token();securityAlive(guard);
      const next=attempt({scope,challenge_id:candidate,operation_id:operation,proof_version:status.proof_version,challenge:null},scope);
      await this.deps.storage.write(`${key}-reauth`,JSON.stringify(next));securityAlive(guard);
      const result=await remote.begin({password,challenge_id:candidate,operation_id:operation,proof_version:status.proof_version,context:securityContext(scope)});securityAlive(guard);
      return result.kind==='granted'?this.accepted(key,next,result.grant,remote,guard):this.challenge(key,next,result.challenge,guard);
    });
  }
  async finish(expected:ReauthenticationAttempt,remote:ReauthenticationRemote,method:SecondFactor,code:string,guard:SecurityGuard=()=>true):Promise<ReauthenticationView> {
    expected=attempt(expected,securityScope(expected.scope));const key=await securityKey(expected.scope,this.deps.hash);
    return securityQueue(key,async()=>{
      await this.live(expected.scope,remote,guard);
      const saved=await this.read(key,expected.scope);securityAlive(guard);
      if(!saved || saved.challenge_id!==expected.challenge_id || saved.operation_id!==expected.operation_id)throw new NativeError(409,'credentials_changed');
      const result=await this.probe(saved,remote,guard);
      if(result?.kind==='granted')return this.accepted(key,saved,result.grant,remote,guard);
      if(!result || result.kind!=='challenge')throw new NativeError(400,'reauthentication_rejected');
      if(!code || code.length>128 || !result.challenge.methods.includes(method) && !(method==='email' && saved.email))throw new NativeError(400,'reauthentication_rejected');
      securityAlive(guard);const grant=await remote.finish({challenge_id:saved.challenge_id,operation_id:saved.operation_id,method,code});securityAlive(guard);
      return this.accepted(key,saved,grant,remote,guard);
    });
  }
  async sendEmail(expected:ReauthenticationAttempt,remote:ReauthenticationRemote,resend=false,guard:SecurityGuard=()=>true):Promise<ReauthenticationView> {
    expected=attempt(expected,securityScope(expected.scope));const key=await securityKey(expected.scope,this.deps.hash);
    return securityQueue(key,async()=>{
      await this.live(expected.scope,remote,guard);
      let saved=await this.read(key,expected.scope);securityAlive(guard);
      if(!saved?.challenge || saved.challenge_id!==expected.challenge_id || saved.operation_id!==expected.operation_id
        || resend && saved.email?.input.delivery_id!==expected.email?.input.delivery_id)throw new NativeError(409,'credentials_changed');
      if(!remote.email)throw new NativeError(501,'unsupported_feature');
      const resumed=await this.probe(saved,remote,guard);
      if(resumed?.kind==='granted')return this.accepted(key,saved,resumed.grant,remote,guard);
      if(!resumed || resumed.kind!=='challenge' || resumed.challenge.challenge_id!==saved.challenge_id
        || resumed.challenge.expires_at!==saved.challenge.expires_at)throw new NativeError(400,'reauthentication_rejected');
      await sendFactorEmail(saved.challenge,saved.email??null,resend,{
        alive:guard,token:this.deps.token,remote:remote.email,
        save:async email=>{
          securityAlive(guard);
          const actual=await this.read(key,expected.scope);
          if(!actual || JSON.stringify(actual)!==JSON.stringify(saved))throw new NativeError(409,'credentials_changed');
          const next=attempt({...saved,email},expected.scope);
          await this.deps.storage.write(`${key}-reauth`,JSON.stringify(next));saved=next;
        },
      });
      return {kind:'challenge',attempt:attempt(saved,expected.scope)};
    });
  }
}
