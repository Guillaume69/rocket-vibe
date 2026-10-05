/** Private anonymous delivery intent. Reading never sends a mail; retry repeats
 * the original command. No password, received code, address or bearer is stored. */
import type {AuthenticationVaultDependencies} from './authenticationVault.ts';
import {nativeEmailRecoveryKey} from '../../lib/storageKeys.ts';
import type {Discovery,RequestEmailRecovery,EmailRecoveryRequested} from './protocol.generated.ts';
import {NativeError,NativeTransport} from './transport.ts';
import {decodeNative} from './validation.ts';

export type EmailRecoveryScope={baseUrl:string;username:string;instanceId:string;dataEpoch:string};
export type EmailRecoveryIntent={scope:EmailRecoveryScope;input:RequestEmailRecovery;createdAt:number;expiresAt:number;accepted:boolean;retryAt:number|null};
const queues=new Map<string,Promise<void>>();
function serialized<T>(key:string,run:()=>Promise<T>):Promise<T>{
  const result=(queues.get(key)??Promise.resolve()).then(run),settled=result.then(()=>{},()=>{});
  queues.set(key,settled);void settled.then(()=>{if(queues.get(key)===settled)queues.delete(key);});return result;
}
function invalid():NativeError{return new NativeError(0,'invalid_native_recovery');}
function identifier(value:unknown):value is string{return typeof value==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);}
function exact(value:unknown,keys:string[]):void{
  if(!value || typeof value!=='object' || Object.keys(value).length!==keys.length || Object.keys(value).some(key=>!keys.includes(key)))throw invalid();
}
export function emailRecoveryScope(baseUrl:string,username:string,discovery:Discovery):EmailRecoveryScope{
  return scope({baseUrl,username,instanceId:discovery.instance_id,dataEpoch:discovery.data_epoch});
}
function scope(value:EmailRecoveryScope):EmailRecoveryScope{
  exact(value,['baseUrl','username','instanceId','dataEpoch']);
  if(typeof value.baseUrl!=='string' || !identifier(value.username) || !identifier(value.instanceId) || !identifier(value.dataEpoch))throw invalid();
  try{return {...value,baseUrl:new NativeTransport(value.baseUrl).baseUrl};}catch{throw invalid();}
}
export function emailRecoveryIntent(value:unknown):EmailRecoveryIntent{
  try{
    exact(value,['scope','input','createdAt','expiresAt','accepted','retryAt']);
    const saved=value as EmailRecoveryIntent,pinned=scope(saved.scope),input=decodeNative('RequestEmailRecovery',saved.input);
    if(!/^[a-f0-9]{64}$/.test(input.operation_id) || input.username!==pinned.username || input.instance_id!==pinned.instanceId || input.data_epoch!==pinned.dataEpoch
      || !Number.isSafeInteger(saved.createdAt) || saved.createdAt<0 || !Number.isSafeInteger(saved.expiresAt) || saved.expiresAt-saved.createdAt!==3_600_000 || typeof saved.accepted!=='boolean'
      || saved.retryAt!==null && (!Number.isSafeInteger(saved.retryAt) || saved.retryAt<saved.createdAt || saved.retryAt>saved.expiresAt || saved.accepted))throw invalid();
    return {scope:pinned,input:{...input},createdAt:saved.createdAt,expiresAt:saved.expiresAt,accepted:saved.accepted,retryAt:saved.retryAt};
  }catch{throw invalid();}
}
function sameScope(a:EmailRecoveryScope,b:EmailRecoveryScope):boolean{
  a=scope(a);b=scope(b);return a.baseUrl===b.baseUrl && a.username===b.username && a.instanceId===b.instanceId && a.dataEpoch===b.dataEpoch;
}
function sameRequest(a:EmailRecoveryIntent,b:EmailRecoveryIntent):boolean{
  return sameScope(a.scope,b.scope) && a.input.operation_id===b.input.operation_id && a.createdAt===b.createdAt && a.expiresAt===b.expiresAt;
}
function alive(guard:()=>boolean):void{if(!guard())throw new NativeError(0,'session_closed');}
export function emailRecoveryExpired(intent:EmailRecoveryIntent):boolean{return Date.now()<intent.createdAt || Date.now()>=intent.expiresAt;}
export function emailRecoveryRetryAfter(intent:EmailRecoveryIntent):number{return intent.retryAt===null?0:Math.min(300,Math.max(0,Math.ceil((intent.retryAt-Date.now())/1000)));}

export class EmailRecoveryVault{
  private readonly deps:AuthenticationVaultDependencies;
  constructor(deps:AuthenticationVaultDependencies){this.deps=deps;}
  private key(base:string,username:string):Promise<string>{return nativeEmailRecoveryKey(new NativeTransport(base).baseUrl,username,this.deps.hash);}
  private async read(key:string,base:string,username:string):Promise<EmailRecoveryIntent|null>{
    const raw=await this.deps.storage.read(key);if(raw===null)return null;
    let saved:EmailRecoveryIntent;try{saved=emailRecoveryIntent(JSON.parse(raw));}catch{throw invalid();}
    if(saved.scope.baseUrl!==new NativeTransport(base).baseUrl || saved.scope.username!==username)throw invalid();
    return saved;
  }
  async load(base:string,username:string):Promise<EmailRecoveryIntent|null>{
    if(!identifier(username))throw invalid();const key=await this.key(base,username);
    return serialized(key,()=>this.read(key,base,username));
  }
  private async live(pinned:EmailRecoveryScope,transport:NativeTransport,guard:()=>boolean,requireCapability=true):Promise<void>{
    alive(guard);const discovery=await transport.discover();alive(guard);
    if(discovery.instance_id!==pinned.instanceId || discovery.data_epoch!==pinned.dataEpoch)throw new NativeError(409,'server_identity_changed');
    if(requireCapability && !discovery.capabilities.email_recovery)throw new NativeError(501,'recovery_unavailable');
  }
  /** Explicit first send. A pending or acknowledged record needs its own retry
   * or explicit dismissal; neither expiration nor a new form overwrites it. */
  async begin(pinned:EmailRecoveryScope,guard:()=>boolean=()=>true):Promise<EmailRecoveryIntent>{
    pinned=scope(pinned);const key=await this.key(pinned.baseUrl,pinned.username);
    return serialized(key,async()=>{
      alive(guard);const current=await this.read(key,pinned.baseUrl,pinned.username);alive(guard);
      if(current)throw new NativeError(409,sameScope(current.scope,pinned)?'recovery_pending':'server_identity_changed');
      const transport=new NativeTransport(pinned.baseUrl,this.deps.fetcher);await this.live(pinned,transport,guard);
      const operation=await this.deps.token();alive(guard);const now=Date.now();
      const saved=emailRecoveryIntent({scope:pinned,input:{operation_id:operation,username:pinned.username,instance_id:pinned.instanceId,data_epoch:pinned.dataEpoch},createdAt:now,expiresAt:now+3_600_000,accepted:false,retryAt:null});
      await this.deps.storage.write(key,JSON.stringify(saved));alive(guard);
      return this.dispatch(key,saved,transport,guard);
    });
  }
  async retry(expected:EmailRecoveryIntent,guard:()=>boolean=()=>true):Promise<EmailRecoveryIntent>{
    expected=emailRecoveryIntent(expected);const key=await this.key(expected.scope.baseUrl,expected.scope.username);
    return serialized(key,async()=>{
      alive(guard);const current=await this.read(key,expected.scope.baseUrl,expected.scope.username);alive(guard);
      if(!current || !sameRequest(current,expected))throw new NativeError(409,'credentials_changed');
      if(emailRecoveryExpired(current))throw new NativeError(400,'recovery_expired');
      const cooldown=emailRecoveryRetryAfter(current);if(cooldown>0)throw new NativeError(429,'email_recovery_cooldown',cooldown);
      if(current.accepted){await this.live(current.scope,new NativeTransport(current.scope.baseUrl,this.deps.fetcher),guard,false);return current;}
      return this.dispatch(key,current,new NativeTransport(current.scope.baseUrl,this.deps.fetcher),guard);
    });
  }
  private async dispatch(key:string,saved:EmailRecoveryIntent,transport:NativeTransport,guard:()=>boolean):Promise<EmailRecoveryIntent>{
    await this.live(saved.scope,transport,guard);
    if(emailRecoveryExpired(saved))throw new NativeError(400,'recovery_expired');
    let reply:EmailRecoveryRequested;
    try{reply=await transport.requestEmailRecovery({...saved.input});}catch(error){
      alive(guard);
      if(error instanceof NativeError && error.status===429){
        const seconds=Math.min(300,Math.max(1,error.retryAfter??1));
        const limited=emailRecoveryIntent({...saved,retryAt:Math.min(saved.expiresAt,Date.now()+seconds*1000)});
        await this.deps.storage.write(key,JSON.stringify(limited));alive(guard);
      }
      throw error;
    }
    alive(guard);
    // An accepted response is generic; never turn it into a delivery assertion.
    if(!reply.accepted)throw invalid();await this.live(saved.scope,transport,guard,false);
    const current=await this.read(key,saved.scope.baseUrl,saved.scope.username);alive(guard);
    if(!current || !sameRequest(current,saved) || current.accepted)throw new NativeError(409,'credentials_changed');
    const accepted=emailRecoveryIntent({...saved,accepted:true,retryAt:null});
    await this.deps.storage.write(key,JSON.stringify(accepted));alive(guard);return accepted;
  }
  /** Local dismissal only. A late old view cannot erase a newer request and
   * dismissing a record cannot revoke a mail already queued on the server. */
  async forget(expected:EmailRecoveryIntent,guard:()=>boolean=()=>true):Promise<boolean>{
    expected=emailRecoveryIntent(expected);const key=await this.key(expected.scope.baseUrl,expected.scope.username);
    return serialized(key,async()=>{
      alive(guard);const current=await this.read(key,expected.scope.baseUrl,expected.scope.username);alive(guard);
      if(!current)return true;if(!sameRequest(current,expected))return false;
      await this.deps.storage.remove(key);alive(guard);return true;
    });
  }
}
