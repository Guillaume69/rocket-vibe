/** Platform-independent vault rules. Storage adapters MUST be a system secure
 * store. The queue spans HTTP and writes, and is shared between vault instances. */
import type { Hacheur, Session } from '../../lib/auth.ts';
import {cleAuthentificationNative} from '../../lib/clesStockage.ts';
import {finishNativeFactor,recoverNativeFactor,validLoginChallenge,type LoginChallenge,type LoginStep} from './authentication.ts';
import type {SecondFactor} from './protocol.generated.ts';
import {NativeError,NativeTransport} from './transport.ts';

export type AuthenticationStorage={read:(key:string)=>Promise<string|null>;write:(key:string,value:string)=>Promise<void>;remove:(key:string)=>Promise<void>};
export type AuthenticationVaultDependencies={storage:AuthenticationStorage;hash:Hacheur;token:()=>Promise<string>;fetcher?:typeof fetch};
const queues=new Map<string,Promise<void>>();
function serialized<T>(key:string,action:()=>Promise<T>):Promise<T> {
  const result=(queues.get(key)??Promise.resolve()).then(action);
  const settled=result.then(()=>{},()=>{});queues.set(key,settled);
  void settled.then(()=>{if(queues.get(key)===settled)queues.delete(key);});return result;
}
function canonical(base:string):string {return new NativeTransport(base).baseUrl;}
function sameIdentity(a:LoginChallenge,b:LoginChallenge):boolean {
  return canonical(a.baseUrl)===canonical(b.baseUrl) && a.user.id===b.user.id && a.user.username===b.user.username && a.instanceId===b.instanceId && a.dataEpoch===b.dataEpoch;
}
function snapshot(value:LoginChallenge):LoginChallenge {
  if(!validLoginChallenge(value))throw new NativeError(0,'invalid_native_authentication');
  return {...value,user:{...value.user},challenge:{...value.challenge,methods:[...value.challenge.methods]},pending:value.pending && {...value.pending}};
}

export class AuthenticationVault {
  private readonly deps:AuthenticationVaultDependencies;
  constructor(deps:AuthenticationVaultDependencies){this.deps=deps;}
  private async key(base:string,username:string):Promise<string> {return cleAuthentificationNative(canonical(base),username,this.deps.hash);}
  private async read(key:string,base:string,username:string):Promise<LoginChallenge|null> {
    const raw=await this.deps.storage.read(key);if(raw===null)return null;
    let value:unknown;try {value=JSON.parse(raw);}catch{throw new NativeError(0,'invalid_native_authentication');}
    if(!validLoginChallenge(value) || canonical(value.baseUrl)!==canonical(base) || value.user.username!==username)throw new NativeError(0,'invalid_native_authentication');
    return value;
  }
  async load(base:string,username:string):Promise<LoginChallenge|null> {
    const key=await this.key(base,username);return serialized(key,()=>this.read(key,base,username));
  }
  /** A freshly verified password step cannot overwrite an unresolved candidate.
   * If the old challenge expired before the NEW challenge was issued, a second
   * candidate probe after that account-lock barrier makes replacement safe. */
  async stage(fresh:LoginChallenge):Promise<LoginStep> {
    fresh=snapshot(fresh);
    if(!validLoginChallenge(fresh) || fresh.pending!==null)throw new NativeError(0,'invalid_native_authentication');
    const key=await this.key(fresh.baseUrl,fresh.user.username);
    return serialized(key,async()=>{
      const previous=await this.read(key,fresh.baseUrl,fresh.user.username);
      if(previous?.pending){
        if(!sameIdentity(previous,fresh))throw new NativeError(409,'server_identity_changed');
        const completed=await recoverNativeFactor(previous,this.deps.fetcher);
        if(completed)return {kind:'session',session:completed};
        // The server fixes challenge TTL at five minutes. start_login holds the
        // same account lock as verify, so a new proof issued after old expiry
        // cannot race an old verification that will commit in the future.
        const issued=Date.parse(fresh.challenge.expires_at)-300_000;
        // Date.parse truncates PostgreSQL's sub-millisecond precision. Equality
        // is ambiguous: retain the old proof until at least one whole ms later.
        if(Date.parse(previous.challenge.expires_at)>=issued)return {kind:'challenge',challenge:previous};
      }
      await this.deps.storage.write(key,JSON.stringify(fresh));
      return {kind:'challenge',challenge:{...fresh,user:{...fresh.user},challenge:{...fresh.challenge,methods:[...fresh.challenge.methods]},pending:null}};
    });
  }
  async recover(expected:LoginChallenge):Promise<Session|null> {
    expected=snapshot(expected);
    if(!validLoginChallenge(expected))throw new NativeError(0,'invalid_native_authentication');
    const key=await this.key(expected.baseUrl,expected.user.username);
    return serialized(key,async()=>{
      const current=await this.read(key,expected.baseUrl,expected.user.username);
      if(!current || !sameIdentity(current,expected) || current.challenge.challenge_id!==expected.challenge.challenge_id)throw new NativeError(409,'credentials_changed');
      return recoverNativeFactor(current,this.deps.fetcher);
    });
  }
  async finish(expected:LoginChallenge,method:SecondFactor,code:string):Promise<Session> {
    expected=snapshot(expected);
    if(!validLoginChallenge(expected))throw new NativeError(0,'invalid_native_authentication');
    const key=await this.key(expected.baseUrl,expected.user.username);
    return serialized(key,async()=>{
      let current=await this.read(key,expected.baseUrl,expected.user.username);
      if(!current || !sameIdentity(current,expected) || current.challenge.challenge_id!==expected.challenge.challenge_id)throw new NativeError(409,'credentials_changed');
      return finishNativeFactor(current,method,code,{fetcher:this.deps.fetcher,token:this.deps.token,save:async(record)=>{
        const actual=await this.read(key,expected.baseUrl,expected.user.username);
        if(!actual || !sameIdentity(actual,current!) || actual.challenge.challenge_id!==current!.challenge.challenge_id || JSON.stringify(actual.pending)!==JSON.stringify(current!.pending))throw new NativeError(409,'credentials_changed');
        await this.deps.storage.write(key,JSON.stringify(record));current=record;
      }});
    });
  }
  /** Call AFTER committing the active session. CAS protects a newer attempt. */
  async clearCompleted(expected:LoginChallenge,active:Session|null):Promise<boolean> {
    expected=snapshot(expected);
    active=active && {...active};
    if(!validLoginChallenge(expected))throw new NativeError(0,'invalid_native_authentication');
    const key=await this.key(expected.baseUrl,expected.user.username);
    return serialized(key,async()=>{
      const current=await this.read(key,expected.baseUrl,expected.user.username);
      if(!current)return true;
      if(!active || active.genre!=='rocketvibe' || canonical(active.baseUrl)!==canonical(current.baseUrl)
        || active.userId!==current.user.id || active.nativeInstanceId!==current.instanceId || active.nativeDataEpoch!==current.dataEpoch
        || !sameIdentity(current,expected) || current.challenge.challenge_id!==expected.challenge.challenge_id
        || !current.pending || active.authToken!==current.pending.next_token)return false;
      await this.deps.storage.remove(key);return true;
    });
  }
}
