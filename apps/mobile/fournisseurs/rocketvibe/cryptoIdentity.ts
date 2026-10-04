import type {CryptoAccount,CryptoIdentityApproval,CryptoIdentityBridge,CryptoIdentityStatus} from '../../modules/crypto-native/index.ts';
import type {Directory,OperationReceipt,RegisterDevice} from './protocol.generated.ts';
import {decodeNative} from './validation.ts';
import type {CryptoStorageAccess} from './cryptoStorage.ts';
import {NativeError} from './transport.ts';

export type IdentityTransport={
  cryptoDirectory:(user:string,after?:string)=>Promise<Directory>;
  cryptoOperation:(id:string)=>Promise<OperationReceipt>;
  registerCryptoDevice:(input:RegisterDevice)=>Promise<OperationReceipt>;
};
function position(value:string):bigint {
  if(!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value)>9223372036854775807n)throw new NativeError(409,'crypto_integrity_failed');
  return BigInt(value);
}
function status(value:CryptoIdentityStatus):CryptoIdentityStatus {
  const fingerprint=(v:string)=>v==='' || /^[0-9a-f]{64}$/.test(v);
  if(!['missing','identity_created','waiting_for_approval','registering','ready'].includes(value.phase)
    || ![value.rootFingerprint,value.remoteFingerprint,value.requestFingerprint].every(fingerprint)
    || typeof value.controlsRoot!=='boolean' || typeof value.requestCode!=='string' || value.requestCode.length>5500
    || value.phase!=='missing' && !value.rootFingerprint)throw new NativeError(0,'crypto_integrity_failed');
  return value;
}
/** HTTP carries signed public material only. Rust owns the ceremony and its
 * durable original intention; nothing here stores keys or writes ordinary SQL.
 */
export class CryptoIdentityAccess {
  private readonly storage:CryptoStorageAccess;
  private readonly bridge:CryptoIdentityBridge;
  private readonly remote:IdentityTransport;
  constructor(storage:CryptoStorageAccess,bridge:CryptoIdentityBridge,remote:IdentityTransport) {
    this.storage=storage;this.bridge=bridge;this.remote=remote;
  }
  get isClosed():boolean {return this.storage.isClosed;}
  close():Promise<void> {return this.storage.close();}
  private async directory(scope:CryptoAccount,check:()=>Promise<void>,user=scope.user):Promise<string> {
    let complete:Directory|null=null,after:string|undefined,previous=0n;
    for(let page=0;page<128;page++) {
      await check();const next=decodeNative('Directory',await this.remote.cryptoDirectory(user,after));await check();
      if(next.scope.instance_id!==scope.instance || next.scope.data_epoch!==scope.dataEpoch
        || next.devices.length>64)throw new NativeError(409,'crypto_scope_changed');
      if(complete && (JSON.stringify(next.identity)!==JSON.stringify(complete.identity)
        || JSON.stringify(next.devices)!==JSON.stringify(complete.devices)))throw new NativeError(409,'crypto_scope_changed');
      for(const item of next.revocations) {const n=position(item.position);if(n<=previous)throw new NativeError(409,'crypto_integrity_failed');previous=n;}
      if(!complete)complete={...next,revocations:[...next.revocations]};
      else complete.revocations.push(...next.revocations);
      if(complete.revocations.length>4096)throw new NativeError(409,'crypto_integrity_failed');
      if(next.next_revocation==null){complete.next_revocation=null;return JSON.stringify(complete);}
      if(next.revocations.length===0 || next.next_revocation!==previous.toString())throw new NativeError(409,'crypto_integrity_failed');
      after=next.next_revocation;
    }
    throw new NativeError(409,'crypto_integrity_failed');
  }
  view():Promise<CryptoIdentityStatus> {return this.storage.withNative(async(handle,scope,check)=>
    status(await this.bridge.identityView(handle,await this.directory(scope,check))));}
  /** Native peer/group adapters share this terminal view and signed directory reader. */
  withIdentity<T>(action:(handle:string,ownDirectory:string,read:(user:string)=>Promise<string>,check:()=>Promise<void>,scope:CryptoAccount)=>Promise<T>):Promise<T> {
    return this.storage.withNative(async(handle,scope,check)=>action(handle,await this.directory(scope,check),user=>this.directory(scope,check,user),check,scope));
  }
  begin(expectedRoot:string):Promise<CryptoIdentityStatus> {return this.storage.withNative(async(handle,scope,check)=>
    status(await this.bridge.identityBegin(handle,await this.directory(scope,check),expectedRoot)));}
  preview(request:string):Promise<CryptoIdentityApproval> {return this.storage.withNative(async(handle,scope,check)=>{
    if(request.length>5500)throw new NativeError(400,'invalid_request');
    const value=await this.bridge.identityPreview(handle,await this.directory(scope,check),request);
    if(!/^[0-9a-f]{32}$/.test(value.id) || !/^[0-9a-f]{64}$/.test(value.rootFingerprint)
      || !/^[0-9a-f]{64}$/.test(value.requestFingerprint) || !value.device || value.device.length>256
      || !/^[1-9][0-9]{0,19}$/.test(value.expiresAt))throw new NativeError(0,'crypto_integrity_failed');
    return value;
  });}
  approve(id:string):Promise<string> {return this.storage.withNative(async(handle,scope,check)=>{
    const value=await this.bridge.identityApprove(handle,await this.directory(scope,check),id);
    if(typeof value!=='string' || value.length<1 || value.length>11000 || !/^[A-Za-z0-9_-]+$/.test(value))throw new NativeError(0,'crypto_integrity_failed');
    return value;
  });}
  private async resumeInner(handle:string,scope:CryptoAccount,check:()=>Promise<void>):Promise<CryptoIdentityStatus> {
    const directory=await this.directory(scope,check);
    const request=decodeNative('RegisterDevice',JSON.parse(await this.bridge.identityPending(handle,directory)) as unknown);
    if(request.scope.instance_id!==scope.instance || request.scope.data_epoch!==scope.dataEpoch)throw new NativeError(409,'crypto_scope_changed');
    await check();let receipt:OperationReceipt;
    try {receipt=await this.remote.cryptoOperation(request.operation_id);}
    catch(error) {
      if(!(error instanceof NativeError && error.status===404 && error.code==='not_found'))throw error;
      await check();receipt=await this.remote.registerCryptoDevice(request);
    }
    await check();
    return status(await this.bridge.identityAcknowledge(handle,await this.directory(scope,check),JSON.stringify(receipt)));
  }
  install(grant:string):Promise<CryptoIdentityStatus> {return this.storage.withNative(async(handle,scope,check)=>{
    if(grant.length>11000)throw new NativeError(400,'invalid_request');
    const staged=status(await this.bridge.identityInstall(handle,await this.directory(scope,check),grant));
    if(staged.phase!=='registering')throw new NativeError(0,'crypto_integrity_failed');
    await check();return this.resumeInner(handle,scope,check);
  });}
  resume():Promise<CryptoIdentityStatus> {return this.storage.withNative((handle,scope,check)=>this.resumeInner(handle,scope,check));}
}
