/** Factor operation receipts stay in the same private family scope as proof.
 * Persist operation/version BEFORE HTTP; a retry never rotates a second bag. */
import type {BeginFactorSetup,DisableFactor,EnableFactor,FactorBackupCodes,FactorSetup,FactorStatus,RegenerateFactorBackups} from './protocol.generated.ts';
import {NativeError} from './transport.ts';
import {decodeNative} from './validation.ts';
import {checkSecurityScope,securityAlive,securityKey,securityQueue,securityScope,type ReauthenticationRemote,type SecurityDependencies,type SecurityGuard,type SecurityScope} from './reauthenticationVault.ts';

export type FactorRemote={
  proof:ReauthenticationRemote;
  status:()=>Promise<FactorStatus>;
  setup:(input:BeginFactorSetup)=>Promise<FactorSetup>;
  enable:(input:EnableFactor)=>Promise<FactorBackupCodes>;
  regenerate:(input:RegenerateFactorBackups)=>Promise<FactorBackupCodes>;
  disable:(input:DisableFactor)=>Promise<void>;
};
type FactorIntent={kind:'setup';operation_id:string;setup:FactorSetup|null;enable_operation_id:string|null}
  |{kind:'regenerate';operation_id:string;factor_version:string}
  |{kind:'disable';operation_id:string;factor_version:string}
  |{kind:'codes';operation_id:string;factor_version:string;codes:FactorBackupCodes};
type Record={scope:SecurityScope;intent:FactorIntent};
export type FactorView={kind:'idle'}|{kind:'setup';setup:FactorSetup}|{kind:'codes';receipt:string;codes:FactorBackupCodes}|{kind:'stale';receipt:string};
export class FactorVault {
  private readonly deps:SecurityDependencies;
  constructor(deps:SecurityDependencies){this.deps=deps;}
  private async read(key:string,scope:SecurityScope):Promise<Record|null> {
    const raw=await this.deps.storage.read(`${key}-factors`);if(raw===null)return null;
    try {
      const v=JSON.parse(raw) as Record,s=securityScope(v.scope);checkSecurityScope(scope,s);
      if(s.baseUrl!==scope.baseUrl || !/^[a-f0-9]{64}$/.test(v.intent.operation_id))throw new Error();
      const i=v.intent;
      if(i.kind==='setup'){
        if(i.setup!==null)decodeNative('FactorSetup',i.setup);
        if(i.enable_operation_id!==null && !/^[a-f0-9]{64}$/.test(i.enable_operation_id))throw new Error();
      } else if(i.kind==='regenerate' || i.kind==='disable' || i.kind==='codes') {
        if(typeof i.factor_version!=='string' || !i.factor_version || i.factor_version.length>128)throw new Error();
        if(i.kind==='codes'){decodeNative('FactorBackupCodes',i.codes);if(i.codes.codes.length!==10 || i.codes.codes.some(code=>!code || code.length>128))throw new Error();}
      } else throw new Error();
      return {scope:s,intent:i};
    } catch{throw new NativeError(0,'invalid_native_security');}
  }
  private async save(key:string,scope:SecurityScope,intent:FactorIntent,guard:SecurityGuard):Promise<void> {
    securityAlive(guard);await this.deps.storage.write(`${key}-factors`,JSON.stringify({scope,intent}));securityAlive(guard);
  }
  private async status(scope:SecurityScope,remote:FactorRemote,guard:SecurityGuard):Promise<FactorStatus> {
    securityAlive(guard);const proof=await remote.proof.status();securityAlive(guard);checkSecurityScope(scope,proof);
    const status=await remote.status();securityAlive(guard);return status;
  }
  private async bag(key:string,scope:SecurityScope,operation:string,codes:FactorBackupCodes,remote:FactorRemote,guard:SecurityGuard):Promise<FactorView> {
    const status=await this.status(scope,remote,guard);
    if(!codes.factor_version || codes.codes.length!==10)throw new NativeError(502,'invalid_native_security');
    await this.save(key,scope,{kind:'codes',operation_id:operation,factor_version:codes.factor_version,codes:{...codes,codes:[...codes.codes]}},guard);
    if(!status.totp || status.factor_version!==codes.factor_version)return {kind:'stale',receipt:operation};
    return {kind:'codes',receipt:operation,codes:{...codes,codes:[...codes.codes]}};
  }
  private async recover(key:string,scope:SecurityScope,remote:FactorRemote,guard:SecurityGuard):Promise<FactorView> {
    const status=await this.status(scope,remote,guard),saved=await this.read(key,scope);securityAlive(guard);
    if(!saved)return {kind:'idle'};
    const intent=saved.intent;
    if(intent.kind==='codes') {
      if(intent.factor_version!==status.factor_version)return {kind:'stale',receipt:intent.operation_id};
      return {kind:'codes',receipt:intent.operation_id,codes:{...intent.codes,codes:[...intent.codes.codes]}};
    }
    if(intent.kind==='disable'){
      if(status.totp){
        if(status.factor_version!==intent.factor_version)return {kind:'stale',receipt:intent.operation_id};
        securityAlive(guard);await remote.disable({factor_version:intent.factor_version});securityAlive(guard);
      }
      await this.deps.storage.remove(`${key}-factors`);securityAlive(guard);return {kind:'idle'};
    }
    if(intent.kind==='regenerate'){
      securityAlive(guard);
      try {const codes=await remote.regenerate({operation_id:intent.operation_id,factor_version:intent.factor_version});securityAlive(guard);return this.bag(key,scope,intent.operation_id,codes,remote,guard);}
      catch(e){securityAlive(guard);if(e instanceof NativeError && e.status===409 && (await this.status(scope,remote,guard)).factor_version!==intent.factor_version)return {kind:'stale',receipt:intent.operation_id};throw e;}
    }
    if(status.totp && intent.setup && intent.enable_operation_id){
      // Accepted enable replays before code validation. With no active factor,
      // recovery never sends an empty code (and never burns a failed attempt).
      securityAlive(guard);
      try{const codes=await remote.enable({setup_id:intent.setup.setup_id,operation_id:intent.enable_operation_id,code:''});securityAlive(guard);return this.bag(key,scope,intent.enable_operation_id,codes,remote,guard);}
      catch(e){securityAlive(guard);if(e instanceof NativeError && e.status===400 && e.code==='factor_rejected')return {kind:'stale',receipt:intent.operation_id};throw e;}
    }
    if(status.totp)return {kind:'stale',receipt:intent.operation_id};
    securityAlive(guard);const setup=await remote.setup({operation_id:intent.operation_id});securityAlive(guard);
    const same=intent.setup?.setup_id===setup.setup_id;
    await this.save(key,scope,{...intent,setup,enable_operation_id:same?intent.enable_operation_id:null},guard);
    return {kind:'setup',setup:{...setup}};
  }
  async resume(scope:SecurityScope,remote:FactorRemote,guard:SecurityGuard=()=>true):Promise<FactorView> {
    scope=securityScope(scope);const key=await securityKey(scope,this.deps.hash);return securityQueue(key,()=>this.recover(key,scope,remote,guard));
  }
  async start(scope:SecurityScope,remote:FactorRemote,kind:'setup'|'regenerate'|'disable',guard:SecurityGuard=()=>true):Promise<FactorView> {
    scope=securityScope(scope);const key=await securityKey(scope,this.deps.hash);
    return securityQueue(key,async()=>{
      const saved=await this.read(key,scope);securityAlive(guard);
      if(saved)return this.recover(key,scope,remote,guard);
      const status=await this.status(scope,remote,guard),operation=await this.deps.token();securityAlive(guard);
      if(!/^[a-f0-9]{64}$/.test(operation))throw new NativeError(0,'invalid_native_security');
      if(kind==='setup'){
        if(status.totp)throw new NativeError(409,'credentials_changed');
        await this.save(key,scope,{kind,operation_id:operation,setup:null,enable_operation_id:null},guard);
      } else {
        if(!status.totp || !status.factor_version)throw new NativeError(409,'credentials_changed');
        await this.save(key,scope,{kind,operation_id:operation,factor_version:status.factor_version},guard);
      }
      return this.recover(key,scope,remote,guard);
    });
  }
  async enable(scope:SecurityScope,remote:FactorRemote,expected:FactorSetup,code:string,guard:SecurityGuard=()=>true):Promise<FactorView> {
    scope=securityScope(scope);expected={...expected};const key=await securityKey(scope,this.deps.hash);
    return securityQueue(key,async()=>{
      const status=await this.status(scope,remote,guard),saved=await this.read(key,scope);securityAlive(guard);
      if(saved?.intent.kind==='codes')return this.recover(key,scope,remote,guard);
      if(saved?.intent.kind!=='setup' || saved.intent.setup?.setup_id!==expected.setup_id)throw new NativeError(409,'credentials_changed');
      if(status.totp)return this.recover(key,scope,remote,guard);
      if(!code || code.length>128)throw new NativeError(400,'factor_rejected');
      const operation=saved.intent.enable_operation_id??await this.deps.token();securityAlive(guard);
      if(!/^[a-f0-9]{64}$/.test(operation))throw new NativeError(0,'invalid_native_security');
      await this.save(key,scope,{...saved.intent,enable_operation_id:operation},guard);
      const codes=await remote.enable({setup_id:expected.setup_id,operation_id:operation,code});securityAlive(guard);
      return this.bag(key,scope,operation,codes,remote,guard);
    });
  }
  /** Acknowledgement/discard is explicit, and cannot clear a newer receipt. */
  async clear(scope:SecurityScope,receipt:string,guard:SecurityGuard=()=>true):Promise<boolean> {
    scope=securityScope(scope);const key=await securityKey(scope,this.deps.hash);
    return securityQueue(key,async()=>{
      securityAlive(guard);const saved=await this.read(key,scope);securityAlive(guard);
      if(!saved)return true;
      if(saved.intent.operation_id!==receipt)return false;
      await this.deps.storage.remove(`${key}-factors`);securityAlive(guard);return true;
    });
  }
}
