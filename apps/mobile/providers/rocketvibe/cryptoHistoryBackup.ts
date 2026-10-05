import type {CryptoHistoryBackupBridge} from '../../modules/crypto-native/index.ts';
import type {CryptoIdentityAccess} from './cryptoIdentity.ts';
import type {HistoryBackupPage,HistoryBackupPeriods,HistoryBackupReceipt,HistoryKeyReceipt,HistoryKeySettlement,HistoryKeyState,PublishHistoryKey,UploadHistoryBackup} from './protocol.generated.ts';
import {decodeNative} from './validation.ts';
import {NativeError} from './transport.ts';

/** History backup (E2EE_HISTORY_BACKUP.md, path B). The bridge keeps the key,
 * the period secrets and the documents; the history code crosses only the
 * explicit code view and the join input. This adapter carries HTTP. */
export type HistoryBackupStatus={holds_key:boolean;generation:string|null;receipt:HistoryKeyReceipt|null;pending:boolean;code_saved:boolean;cancel_requested:boolean};
export type HistoryBackupPreview={id:string;generation_revision:string|null};
type Remote={
  cryptoHistoryKey:()=>Promise<HistoryKeyState>;
  publishCryptoHistoryKey:(input:PublishHistoryKey)=>Promise<HistoryKeyReceipt>;
  cryptoHistoryKeyOperation:(operation:string)=>Promise<HistoryKeyReceipt>;
  cancelCryptoHistoryKey:(input:PublishHistoryKey)=>Promise<HistoryKeySettlement>;
  cryptoHistoryBackupPeriods:(generation:string,after?:string)=>Promise<HistoryBackupPeriods>;
  uploadCryptoHistoryBackup:(period:string,input:UploadHistoryBackup)=>Promise<HistoryBackupReceipt>;
  cryptoHistoryBackupRecords:(period:string,after:string)=>Promise<HistoryBackupPage>;
};
type Check=()=>Promise<void>;
function fail():never{throw new NativeError(0,'crypto_integrity_failed');}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail();return value as Record<string,unknown>;}
function id(value:unknown):string{if(typeof value!=='string'||!/^[0-9a-f]{32}$/.test(value))fail();return value;}
function status(value:unknown):HistoryBackupStatus {
  const r=record(value);
  if(typeof r.holds_key!=='boolean'||typeof r.pending!=='boolean'||typeof r.code_saved!=='boolean'||typeof r.cancel_requested!=='boolean'
    ||r.generation!==null&&(typeof r.generation!=='string'||!/^[0-9a-f]{32}$/.test(r.generation)))fail();
  return {holds_key:r.holds_key,generation:r.generation as string|null,receipt:r.receipt===null?null:decodeNative('HistoryKeyReceipt',r.receipt),
    pending:r.pending,code_saved:r.code_saved,cancel_requested:r.cancel_requested};
}
function after(value:unknown):string|null {
  const r=record(value);
  if(r.after===null)return null;
  if(typeof r.after!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(r.after))fail();
  return r.after;
}
export class CryptoHistoryBackupAccess {
  private readonly identity:CryptoIdentityAccess;
  private readonly bridge:CryptoHistoryBackupBridge;
  private readonly remote:Remote;
  constructor(identity:CryptoIdentityAccess,bridge:CryptoHistoryBackupBridge,remote:Remote){this.identity=identity;this.bridge=bridge;this.remote=remote;}
  private async action(handle:string,own:string,input:unknown,check:Check):Promise<unknown> {
    await check();const json=await this.bridge.historyBackupAction(handle,own,JSON.stringify(input));await check();
    if(typeof json!=='string'||json.length>8*1024*1024)fail();return JSON.parse(json) as unknown;
  }
  view():Promise<HistoryBackupStatus>{return this.identity.withIdentity(async(handle,own,_read,check)=>status(await this.action(handle,own,{action:'view'},check)));}
  clearPreview():Promise<void>{return this.identity.withIdentity(async(handle,own,_read,check)=>{
    if(record(await this.action(handle,own,{action:'clear_preview'},check)).cleared!==true)fail();
  });}
  /** Review before a new generation replaces the active one. */
  preview():Promise<HistoryBackupPreview>{return this.identity.withIdentity(async(handle,own,_read,check)=>{
    await check();const remote=decodeNative('HistoryKeyState',await this.remote.cryptoHistoryKey());await check();
    const r=record(await this.action(handle,own,{action:'preview',remote},check));
    if(r.generation_revision!==null&&(typeof r.generation_revision!=='string'||!/^[1-9][0-9]{0,18}$/.test(r.generation_revision)))fail();
    return {id:id(r.id),generation_revision:r.generation_revision as string|null};
  });}
  prepare(preview:string):Promise<HistoryBackupStatus>{return this.identity.withIdentity(async(handle,own,_read,check)=>status(await this.action(handle,own,{action:'prepare',id:id(preview)},check)));}
  /** Explicit code view only. The caller clears this text on blur or account change. */
  code():Promise<string>{return this.identity.withIdentity(async(handle,own,_read,check)=>{
    const r=record(await this.action(handle,own,{action:'code'},check));
    if(typeof r.code!=='string'||!/^rvh1-[0-9a-f]{64}-[0-9a-f]{8}$/.test(r.code))fail();return r.code;
  });}
  /** The user saved the code: the generation is published. */
  confirmSaved():Promise<HistoryBackupStatus>{return this.identity.withIdentity(async(handle,own,read,check,scope)=>{
    status(await this.action(handle,own,{action:'confirm_saved'},check));return this.resumeInner(handle,read,check,scope.user);
  });}
  resume():Promise<HistoryBackupStatus>{return this.identity.withIdentity((handle,_own,read,check,scope)=>this.resumeInner(handle,read,check,scope.user));}
  cancel():Promise<HistoryBackupStatus>{return this.identity.withIdentity(async(handle,own,read,check,scope)=>{
    decodeNative('PublishHistoryKey',await this.action(handle,own,{action:'request_cancel'},check));return this.resumeInner(handle,read,check,scope.user);
  });}
  private async resumeInner(handle:string,read:(user:string)=>Promise<string>,check:Check,user:string):Promise<HistoryBackupStatus> {
    const state=status(await this.action(handle,await read(user),{action:'view'},check));
    const request=decodeNative('PublishHistoryKey',await this.action(handle,await read(user),{action:state.cancel_requested?'pending_cancel':'pending'},check));
    await check();
    if(state.cancel_requested){
      const result=decodeNative('HistoryKeySettlement',await this.remote.cancelCryptoHistoryKey(request));await check();
      return status(await this.action(handle,await read(user),{action:'settle_cancel',result},check));
    }
    let receipt:HistoryKeyReceipt;
    try{receipt=await this.remote.cryptoHistoryKeyOperation(request.operation_id);}
    catch(error){if(!(error instanceof NativeError&&error.status===404&&error.code==='not_found'))throw error;await check();receipt=await this.remote.publishCryptoHistoryKey(request);}
    await check();return status(await this.action(handle,await read(user),{action:'acknowledge',receipt:decodeNative('HistoryKeyReceipt',receipt)},check));
  }
  /** Joins the active generation with its history code. */
  join(code:string):Promise<HistoryBackupStatus>{return this.identity.withIdentity(async(handle,own,_read,check)=>{
    if(code.trim().length!==78)throw new NativeError(400,'crypto_recovery_failed');
    await check();const remote=decodeNative('HistoryKeyState',await this.remote.cryptoHistoryKey());await check();
    return status(await this.action(handle,own,{action:'join',remote,code:code.trim()},check));
  });}
  /** Uploads every pending page of this device's history; returns the pages sent. */
  sync():Promise<number>{return this.identity.withIdentity(async(handle,_own,read,check,scope)=>{
    let pages=0;
    // Uploads go only under the active generation (E2EE_HISTORY_BACKUP.md).
    await check();const remote=decodeNative('HistoryKeyState',await this.remote.cryptoHistoryKey());await check();
    for(;;){
      const r=record(await this.action(handle,await read(scope.user),{action:'upload',remote},check));
      if(r.upload===null)return pages;
      const upload=record(r.upload);
      if(typeof upload.period!=='string'||!/^[0-9a-f]{64}$/.test(upload.period))fail();
      const receipt=decodeNative('HistoryBackupReceipt',await this.remote.uploadCryptoHistoryBackup(upload.period,decodeNative('UploadHistoryBackup',upload.input)));
      await check();
      if(record(await this.action(handle,await read(scope.user),{action:'uploaded',receipt},check)).recorded!==true)fail();
      pages++;
    }
  });}
  /** Downloads and imports every backed-up period of the held generation. */
  restore():Promise<number>{return this.identity.withIdentity(async(handle,own,read,check,scope)=>{
    const held=status(await this.action(handle,own,{action:'view'},check));
    if(held.generation===null)throw new NativeError(409,'crypto_history_key_missing');
    let imported=0,cursor:string|undefined;
    for(;;){
      const listed=decodeNative('HistoryBackupPeriods',await this.remote.cryptoHistoryBackupPeriods(held.generation,cursor));await check();
      for(const period of listed.periods){
        let next=after(await this.action(handle,await read(scope.user),{action:'next',listed:period},check));
        while(next!==null){
          const page=decodeNative('HistoryBackupPage',await this.remote.cryptoHistoryBackupRecords(period.period,next));await check();
          imported+=page.records.length;
          next=after(await this.action(handle,await read(scope.user),{action:'import',listed:period,page},check));
        }
      }
      if(!listed.next)return imported;
      cursor=listed.next;
    }
  });}
}
