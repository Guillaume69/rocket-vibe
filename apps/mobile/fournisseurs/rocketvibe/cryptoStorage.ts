import type {CryptoAccount,CryptoInstallationStatus,CryptoStorageBridge} from '../../modules/crypto-native/index.ts';
import {NativeError} from './transport.ts';

type ScopeReader = () => Promise<CryptoAccount>;
function sameAccount(left:CryptoAccount,right:CryptoAccount):boolean {
  return left.origin===right.origin && left.instance===right.instance && left.dataEpoch===right.dataEpoch
    && left.user===right.user && left.device===right.device;
}
function validStatus(value:CryptoInstallationStatus):void {
  if(!['missing','initializing','ready'].includes(value.phase) || !/^[0-9a-f]{64}$/.test(value.accountFingerprint)
    || !(value.phase==='missing'?value.incarnation==='':/^[0-9a-f]{32}$/.test(value.incarnation))) {
    throw new NativeError(0,'crypto_integrity_failed');
  }
}

/** A terminal view of native storage for one verified HTTP device. No local
 * SQL, identity creation, registration or server request is inferred by opening.
 */
export class CryptoStorageAccess {
  private closed=false;
  private queue:Promise<void>=Promise.resolve();
  private closing:Promise<void>|null=null;
  private readonly bridge:CryptoStorageBridge;
  private readonly handle:string;
  private readonly scope:CryptoAccount;
  private readonly fingerprint:string;
  private readonly readScope:ScopeReader;
  private readonly alive:()=>boolean;
  get isClosed():boolean {return this.closed;}
  private constructor(bridge:CryptoStorageBridge,handle:string,scope:CryptoAccount,fingerprint:string,
    readScope:ScopeReader,alive:()=>boolean) {
    this.bridge=bridge;this.handle=handle;this.scope={...scope};this.fingerprint=fingerprint;
    this.readScope=readScope;this.alive=alive;
  }

  static async open(bridge:CryptoStorageBridge,readScope:ScopeReader,alive:()=>boolean):Promise<CryptoStorageAccess> {
    if(!alive())throw new NativeError(0,'session_closed');
    const scope=await readScope();
    if(!alive())throw new NativeError(0,'session_closed');
    const opened=await bridge.open(scope);
    try {
      validStatus(opened);
      if(typeof opened.handle!=='string' || opened.handle.length<1 || opened.handle.length>128)throw new NativeError(0,'crypto_integrity_failed');
      if(!alive())throw new NativeError(0,'session_closed');
      if(!sameAccount(scope,await readScope()))throw new NativeError(409,'crypto_scope_changed');
      if(!alive())throw new NativeError(0,'session_closed');
      return new CryptoStorageAccess(bridge,opened.handle,scope,opened.accountFingerprint,readScope,alive);
    } catch(error) {
      if(typeof opened.handle==='string')await bridge.close(opened.handle).catch(()=>{});
      throw error;
    }
  }

  private check():void {if(this.closed || !this.alive())throw new NativeError(0,'session_closed');}
  private async validateScope():Promise<void> {
    this.check();
    const scope=await this.readScope();this.check();
    if(!sameAccount(scope,this.scope)){void this.close();throw new NativeError(409,'crypto_scope_changed');}
  }
  private run<T>(action:()=>Promise<T>):Promise<T> {
    const request=this.queue.then(async()=>{
      await this.validateScope();
      const result=await action();
      // A late platform write finishes under its Rust lease, but cannot revive
      // a hidden view or publish a result after the session/device has changed.
      await this.validateScope();
      return result;
    });
    this.queue=request.then(()=>{},()=>{});
    return request;
  }
  status():Promise<CryptoInstallationStatus> {return this.run(async()=>{
    const value=await this.bridge.status(this.handle);validStatus(value);
    if(value.accountFingerprint!==this.fingerprint)throw new NativeError(409,'crypto_scope_changed');
    return value;
  });}
  initialize(expectedFingerprint:string):Promise<CryptoInstallationStatus> {return this.run(async()=>{
    if(expectedFingerprint!==this.fingerprint)throw new NativeError(409,'crypto_scope_changed');
    const value=await this.bridge.initialize(this.handle,expectedFingerprint);validStatus(value);
    if(value.accountFingerprint!==this.fingerprint)throw new NativeError(409,'crypto_scope_changed');
    return value;
  });}
  retire(expectedFingerprint:string):Promise<void> {return this.run(async()=>{
    if(expectedFingerprint!==this.fingerprint)throw new NativeError(409,'crypto_scope_changed');
    await this.bridge.retire(this.handle,expectedFingerprint);
  }).then(()=>this.close());}
  close():Promise<void> {
    this.closed=true;
    this.closing??=this.bridge.close(this.handle).catch(()=>{});
    return this.closing;
  }
}
