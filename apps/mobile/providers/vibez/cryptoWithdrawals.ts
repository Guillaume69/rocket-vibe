import type {CryptoWithdrawalBridge,CryptoAccount} from '../../modules/crypto-native/index.ts';
import type {CryptoIdentityAccess} from './cryptoIdentity.ts';
import type {OperationReceipt,RevokeDevice} from './protocol.generated.ts';
import {decodeNative} from './validation.ts';
import {NativeError} from './transport.ts';

export type WithdrawalSubject={device:string;incarnation:string};
export type WithdrawalDevice=WithdrawalSubject & {fingerprint:string;revision:string;expires_at:string};
export type WithdrawalStatus={controls_root:boolean;devices:WithdrawalDevice[];withdrawn:WithdrawalSubject[];pending:WithdrawalSubject|null};
export type WithdrawalPreview=WithdrawalSubject & {id:string;fingerprint:string;root_fingerprint:string;expires_at:string};
type Transport={cryptoOperation:(id:string)=>Promise<OperationReceipt>;revokeCryptoDevice:(request:RevokeDevice)=>Promise<OperationReceipt>};
function fail():never {throw new NativeError(0,'crypto_integrity_failed');}
function record(value:unknown):Record<string,unknown> {if(!value || typeof value!=='object' || Array.isArray(value))fail();return value as Record<string,unknown>;}
function subject(value:unknown):WithdrawalSubject {
  const r=record(value);
  if(typeof r.device!=='string' || !r.device || r.device.length>256 || typeof r.incarnation!=='string' || !/^[0-9a-f]{32}$/.test(r.incarnation))fail();
  return {device:r.device,incarnation:r.incarnation};
}
function fp(value:unknown):string {if(typeof value!=='string' || !/^[0-9a-f]{64}$/.test(value))fail();return value;}
function decimal(value:unknown,max:bigint):string {if(typeof value!=='string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value)>max)fail();return value;}
function status(value:unknown):WithdrawalStatus {
  const r=record(value);
  if(typeof r.controls_root!=='boolean' || !Array.isArray(r.devices) || r.devices.length>64 || !Array.isArray(r.withdrawn) || r.withdrawn.length>4096)fail();
  const devices=r.devices.map(value=>{const d=record(value);return {...subject(d),fingerprint:fp(d.fingerprint),revision:decimal(d.revision,9223372036854775807n),expires_at:decimal(d.expires_at,253402300799n)};});
  const withdrawn=r.withdrawn.map(subject);
  if(new Set(devices.map(d=>d.device)).size!==devices.length || new Set(withdrawn.map(d=>`${d.device}:${d.incarnation}`)).size!==withdrawn.length)fail();
  return {controls_root:r.controls_root,devices,withdrawn,pending:r.pending===null?null:subject(r.pending)};
}
function preview(value:unknown):WithdrawalPreview {
  const r=record(value);
  if(typeof r.id!=='string' || !/^[0-9a-f]{32}$/.test(r.id))fail();
  return {...subject(r),id:r.id,fingerprint:fp(r.fingerprint),root_fingerprint:fp(r.root_fingerprint),expires_at:decimal(r.expires_at,253402300799n)};
}
/** The existing account handle owns consent and private state. HTTP never
 * receives keys; only Rust can prepare or acknowledge the protected original.
 */
export class CryptoWithdrawalAccess {
  private readonly identity:CryptoIdentityAccess;
  private readonly bridge:CryptoWithdrawalBridge;
  private readonly remote:Transport;
  constructor(identity:CryptoIdentityAccess,bridge:CryptoWithdrawalBridge,remote:Transport) {
    this.identity=identity;this.bridge=bridge;this.remote=remote;
  }
  private async action(handle:string,own:string,input:unknown,check:()=>Promise<void>):Promise<unknown> {
    await check();const json=await this.bridge.withdrawalAction(handle,own,JSON.stringify(input));await check();
    if(typeof json!=='string' || json.length>4*1024*1024)fail();
    return JSON.parse(json) as unknown;
  }
  view():Promise<WithdrawalStatus> {return this.identity.withIdentity(async(handle,own,_read,check)=>status(await this.action(handle,own,{action:'view'},check)));}
  preview(device:WithdrawalDevice):Promise<WithdrawalPreview> {
    return this.identity.withIdentity(async(handle,own,_read,check)=>{
      const fresh=preview(await this.action(handle,own,{action:'preview',device:device.device,fingerprint:device.fingerprint},check));
      if(fresh.device!==device.device || fresh.incarnation!==device.incarnation || fresh.fingerprint!==device.fingerprint)fail();
      return fresh;
    });
  }
  private async resumeInner(handle:string,own:string,read:(user:string)=>Promise<string>,check:()=>Promise<void>,scope:CryptoAccount):Promise<WithdrawalStatus> {
    const request=decodeNative('RevokeDevice',await this.action(handle,own,{action:'pending'},check));
    if(request.scope.instance_id!==scope.instance || request.scope.data_epoch!==scope.dataEpoch)throw new NativeError(409,'crypto_scope_changed');
    await check();let receipt:OperationReceipt;
    try {receipt=await this.remote.cryptoOperation(request.operation_id);}
    catch(error) {
      if(!(error instanceof NativeError && error.status===404 && error.code==='not_found'))throw error;
      await check();receipt=await this.remote.revokeCryptoDevice(request);
    }
    await check();return status(await this.action(handle,await read(scope.user),{action:'acknowledge',receipt:decodeNative('OperationReceipt',receipt)},check));
  }
  confirm(id:string):Promise<WithdrawalStatus> {
    if(!/^[0-9a-f]{32}$/.test(id))fail();
    return this.identity.withIdentity(async(handle,own,read,check,scope)=>{
      decodeNative('RevokeDevice',await this.action(handle,own,{action:'prepare',id},check));
      return this.resumeInner(handle,await read(scope.user),read,check,scope);
    });
  }
  resume():Promise<WithdrawalStatus> {return this.identity.withIdentity((handle,own,read,check,scope)=>this.resumeInner(handle,own,read,check,scope));}
}
