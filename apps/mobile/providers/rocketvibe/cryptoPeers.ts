import type {CryptoPeerApproval,CryptoPeerBridge,CryptoPeerStatus,CryptoPeerView} from '../../modules/crypto-native/index.ts';
import type {CryptoIdentityAccess} from './cryptoIdentity.ts';
import {NativeError} from './transport.ts';

function view(value:{id:string;statusJson:string},user:string):CryptoPeerView {
  if(!/^[0-9a-f]{32}$/.test(value.id) || typeof value.statusJson!=='string' || value.statusJson.length>65536)throw new NativeError(0,'crypto_integrity_failed');
  const status=JSON.parse(value.statusJson) as CryptoPeerStatus;
  const fp=(v:string)=>v==='' || /^[0-9a-f]{64}$/.test(v);
  if(status.user!==user || !fp(status.fingerprint) || !fp(status.previous_fingerprint)
    || !['unknown','unverified','verified','changed'].includes(status.trust) || !Array.isArray(status.devices)
    || status.devices.length>64 || new Set(status.devices.map(d=>d.id)).size!==status.devices.length
    || status.devices.some(d=>typeof d.id!=='string' || !d.id || d.id.length>256 || !/^[0-9a-f]{32}$/.test(d.incarnation)
      || !/^[0-9a-f]{64}$/.test(d.fingerprint) || !/^[1-9][0-9]{0,19}$/.test(d.expires_at) || typeof d.approved!=='boolean'))throw new NativeError(0,'crypto_integrity_failed');
  return {...status,id:value.id};
}
/** Only a native opaque view/consent can change protected peer trust. */
export class CryptoPeerAccess {
  private readonly identity:CryptoIdentityAccess;
  private readonly bridge:CryptoPeerBridge;
  private readonly user:string;
  constructor(identity:CryptoIdentityAccess,bridge:CryptoPeerBridge,user:string) {
    this.identity=identity;this.bridge=bridge;this.user=user;
  }
  close():Promise<void> {return this.identity.close();}
  read():Promise<CryptoPeerView> {return this.identity.withIdentity(async(handle,own,read)=>
    view(await this.bridge.peerView(handle,own,this.user,await read(this.user)),this.user));}
  pin(previous:CryptoPeerView,choice:'first_contact'|'verify'|'replace',confirmed:string):Promise<CryptoPeerView> {
    return this.identity.withIdentity(async(handle,own,read)=>{
      if(previous.user!==this.user)throw new NativeError(409,'crypto_scope_changed');
      return view(await this.bridge.peerPin(handle,own,await read(this.user),previous.id,choice,confirmed,previous.previous_fingerprint),this.user);
    });
  }
  preview(previous:CryptoPeerView,device:string):Promise<CryptoPeerApproval> {
    return this.identity.withIdentity(async(handle,own,read)=>{
      if(previous.user!==this.user)throw new NativeError(409,'crypto_scope_changed');
      const result=await this.bridge.peerPreview(handle,own,await read(this.user),previous.id,device);
      if(result.user!==this.user || result.device!==device || !/^[0-9a-f]{32}$/.test(result.id)
        || !/^[0-9a-f]{64}$/.test(result.rootFingerprint) || !/^[0-9a-f]{64}$/.test(result.fingerprint)
        || !/^[0-9a-f]{32}$/.test(result.incarnation) || !/^[1-9][0-9]{0,19}$/.test(result.expiresAt))throw new NativeError(0,'crypto_integrity_failed');
      return result;
    });
  }
  approve(approval:CryptoPeerApproval):Promise<CryptoPeerView> {return this.identity.withIdentity(async(handle,own,read)=>{
    if(approval.user!==this.user)throw new NativeError(409,'crypto_scope_changed');
    return view(await this.bridge.peerApprove(handle,own,await read(this.user),approval.id),this.user);
  });}
}
