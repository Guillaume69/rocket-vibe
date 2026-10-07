import type {CryptoAccount,CryptoGroupBridge,CryptoGroupPreview,CryptoParticipant,CryptoPeerStatus} from '../../modules/crypto-native/index.ts';
import type {CryptoIdentityAccess} from './cryptoIdentity.ts';
import type {AvailableKeyPackage,GroupEvent,GroupEventPage,GroupReceipt,GroupRoster,GroupSettlement,GroupState,GroupSubmission,OperationReceipt,PublishKeyPackages} from './protocol.generated.ts';
import {NativeError} from './transport.ts';
import {decodeNative} from './validation.ts';

export type GroupTransport={
  cryptoGroupRoster:(room:string)=>Promise<GroupRoster>;
  cryptoGroupState:(room:string)=>Promise<GroupState>;
  cryptoGroupEvents:(room:string,after:string)=>Promise<GroupEventPage>;
  cryptoGroupOperation:(room:string,id:string)=>Promise<GroupReceipt>;
  submitCryptoGroup:(room:string,input:GroupSubmission)=>Promise<GroupReceipt>;
  cancelCryptoGroup:(room:string,input:GroupSubmission)=>Promise<GroupSettlement>;
  availableCryptoKeyPackage:(room:string,user:string,device:string)=>Promise<AvailableKeyPackage>;
  cryptoOperation:(id:string)=>Promise<OperationReceipt>;
  publishKeyPackages:(input:PublishKeyPackages)=>Promise<OperationReceipt>;
};
type Pending={operation:string;fingerprint:string;cancelling:boolean;superseded:boolean};
type Grant={user:string;access_version:string;activation_version:string};
type Local={accepted:GroupReceipt|null;participants:CryptoParticipant[];pending:Pending|null;needs_credential_update:boolean;grants:Grant[]};
type CurrentDevice={user:string;device:string;incarnation:string;certificate:string};
/** An encrypted room's voice frame key at the group's epoch (docs/protocol/VOICE.md). */
export type VoiceKey={epoch:string;key:string};
export type CryptoGroupView=Local & {roster:GroupRoster;eligible:(CurrentDevice & {replacement:boolean})[];event:GroupEvent|null;own_device:string};
export type CryptoRoomAction<T>=(rpc:(input:unknown)=>Promise<unknown>,roster:GroupRoster,
  peers:(source?:GroupRoster)=>Promise<CurrentDevice[]>,scope:CryptoAccount,
  call:<R>(fn:()=>Promise<R>,mutation?:boolean)=>Promise<R>)=>Promise<T>;
const fp=(v:unknown):v is string=>typeof v==='string' && /^[0-9a-f]{64}$/.test(v);
const id=(v:unknown):v is string=>typeof v==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
function integrity():never {throw new NativeError(0,'crypto_integrity_failed');}
function object(value:unknown):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value))integrity();
  return value as Record<string,unknown>;
}
function participants(value:unknown):CryptoParticipant[] {
  if(!Array.isArray(value) || value.length>256)integrity();
  const result=value.map(v=>{const p=object(v);
    if(!id(p.user) || !id(p.device) || typeof p.incarnation!=='string' || !/^[0-9a-f]{32}$/.test(p.incarnation)
      || !fp(p.root) || !fp(p.certificate))integrity();
    return p as CryptoParticipant;
  });
  if(new Set(result.map(p=>p.device)).size!==result.length)integrity();return result;
}
function pending(value:unknown):Pending|null {
  if(value===null)return null;const p=object(value);
  if(!id(p.operation) || !fp(p.fingerprint) || typeof p.cancelling!=='boolean' || typeof p.superseded!=='boolean')integrity();
  return p as Pending;
}
function local(value:unknown,room:string,scope:CryptoAccount):Local {
  const v=object(value),accepted=v.accepted===null?null:decodeNative('GroupReceipt',v.accepted);
  if(accepted && (accepted.room_id!==room || accepted.scope.instance_id!==scope.instance || accepted.scope.data_epoch!==scope.dataEpoch))integrity();
  if(typeof v.needs_credential_update!=='boolean' || !accepted && v.needs_credential_update)integrity();
  if(!Array.isArray(v.grants) || v.grants.length>128)integrity();
  const grants=(v.grants as unknown[]).map(g=>{const x=object(g);
    if(!id(x.user) || typeof x.access_version!=='string' || typeof x.activation_version!=='string')integrity();
    return x as Grant;});
  return {accepted,participants:participants(v.participants),pending:pending(v.pending),needs_credential_update:v.needs_credential_update,grants};
}
function preview(value:unknown):CryptoGroupPreview {
  const v=object(value);
  if(typeof v.id!=='string' || !/^[0-9a-f]{32}$/.test(v.id) || !fp(v.fingerprint)
    || !['genesis','change','admission','readmission','commit'].includes(String(v.kind)))integrity();
  return {...v,recipients:participants(v.recipients)} as CryptoGroupPreview;
}
const absent=(e:unknown)=>e instanceof NativeError && e.status===404 && e.code==='not_found';
/** The JS actor only routes signed public DTOs. Rust keeps each original and
 * private consent; ordinary message/draft tables never receive MLS material. */
export class CryptoGroupAccess {
  private readonly identity:CryptoIdentityAccess;
  private readonly bridge:CryptoGroupBridge;
  private readonly remote:GroupTransport;
  private readonly room:string;
  private readonly guard:(mutation:boolean)=>Promise<void>;
  constructor(identity:CryptoIdentityAccess,bridge:CryptoGroupBridge,remote:GroupTransport,room:string,guard:(mutation:boolean)=>Promise<void>) {
    this.identity=identity;this.bridge=bridge;this.remote=remote;this.room=room;this.guard=guard;
  }
  close():Promise<void> {return this.identity.close();}
  get isClosed():boolean {return this.identity.isClosed;}
  withRoom<T>(mutation:boolean,nativeRPC:(handle:string,directory:string,input:string)=>Promise<string>,action:CryptoRoomAction<T>):Promise<T> {
    return this.identity.withIdentity(async(handle,own,fresh,check,scope)=>{
      // A read-only run reads each directory and the room's devices once; a
      // mutation keeps a fresh read before every native call.
      const directories=new Map<string,Promise<string>>();
      const read=(user:string):Promise<string>=>{
        if(mutation)return fresh(user);
        let directory=directories.get(user);
        if(!directory){directory=fresh(user);directories.set(user,directory);}
        return directory;
      };
      const gate=async()=>{await check();await this.guard(mutation);};
      const call=async<R>(fn:()=>Promise<R>,write=false):Promise<R>=>{await gate();if(write)await this.guard(true);const v=await fn();await gate();return v;};
      const rpc=async(input:unknown):Promise<unknown>=>{
        // Fresh own withdrawal observations precede every native mutation/ACK.
        const directory=await read(scope.user);
        const result=await call(()=>nativeRPC(handle,directory,JSON.stringify(input)));
        if(typeof result!=='string' || result.length>8*1024*1024)integrity();return JSON.parse(result) as unknown;
      };
      const roster=decodeNative('GroupRoster',await call(()=>this.remote.cryptoGroupRoster(this.room)));
      if(roster.room_id!==this.room || roster.scope.instance_id!==scope.instance || roster.scope.data_epoch!==scope.dataEpoch
        || roster.members.length>128 || !roster.members.some(m=>m.user_id===scope.user))throw new NativeError(409,'crypto_scope_changed');
      // A member's devices as this device trusts them, once per read-only run:
      // the room's own sources come with their own roster objects.
      const statuses=new Map<string,Promise<CryptoPeerStatus>>();
      const status=async(user:string):Promise<CryptoPeerStatus>=>{
        const directory=await read(user);
        const result=await call(()=>this.bridge.peerView(handle,own,user,directory));
        return JSON.parse(result.statusJson) as CryptoPeerStatus;
      };
      const statusOf=(user:string):Promise<CryptoPeerStatus>=>{
        if(mutation)return status(user);
        let value=statuses.get(user);
        if(!value){value=status(user);statuses.set(user,value);}
        return value;
      };
      const peers=async(source=roster)=>{
        if(source.scope.instance_id!==scope.instance || source.scope.data_epoch!==scope.dataEpoch || source.members.length>128
          || !source.members.some(m=>m.user_id===scope.user))throw new NativeError(409,'crypto_scope_changed');
        const devices:CurrentDevice[]=[];
        for(const member of source.members) {
          const status=await statusOf(member.user_id);
          if(status.user!==member.user_id || !Array.isArray(status.devices) || status.devices.length>64)integrity();
          for(const d of status.devices) {
            if(!id(d.id) || !/^[0-9a-f]{32}$/.test(d.incarnation) || !fp(d.fingerprint) || typeof d.approved!=='boolean')integrity();
            if(d.approved && d.id!==scope.device)devices.push({user:status.user,device:d.id,incarnation:d.incarnation,certificate:d.fingerprint});
          }
          if(devices.length>256)integrity();
        }
        return devices;
      };
      return action(rpc,roster,peers,scope,call);
    },!mutation);
  }
  private run<T>(mutation:boolean,action:CryptoRoomAction<T>):Promise<T> {
    return this.withRoom(mutation,(handle,directory,input)=>this.bridge.groupAction(handle,directory,input),action);
  }
  read():Promise<CryptoGroupView> {return this.run(false,async(rpc,roster,peers,scope,call)=>{
    const value=local(await rpc({action:'view',roster}),this.room,scope);
    // A member whose grant changed since the group was built (a role or a
    // right) keeps their devices only through a Remove+Add: offered as a replacement.
    const regranted=(user:string)=>value.grants.some(g=>{const now=roster.members.find(m=>m.user_id===user);
      return g.user===user && !!now && (g.access_version!==now.access_version || g.activation_version!==now.activation_version);});
    const devices=await peers(),eligible=devices.flatMap(d=>{
      const previous=value.participants.find(p=>p.user===d.user && p.device===d.device);
      return previous?.incarnation===d.incarnation && previous.certificate===d.certificate && !regranted(d.user)?[]:[{...d,replacement:!!previous}];
    });
    let event:GroupEvent|null=null;
    if(roster.group && !value.pending) {
      const state=decodeNative('GroupState',await call(()=>this.remote.cryptoGroupState(this.room)));
      const page=decodeNative('GroupEventPage',await call(()=>this.remote.cryptoGroupEvents(this.room,value.accepted?.revision??'0')));
      const next=await rpc({action:'events',roster,state,page});event=next===null?null:decodeNative('GroupEvent',next);
    }
    return {...value,roster,eligible,event,own_device:scope.device};
  });}
  /**
   * The group's voice key, when this device is at the server's epoch. Null
   * otherwise: not welcomed yet, or a change the user has not accepted
   * (group events are accepted with consent, from the room's encryption panel).
   */
  voiceKey():Promise<VoiceKey|null> {return this.run(false,async(rpc,roster)=>{
    if(!roster.group)return null;
    const result=await rpc({action:'voice_key',room:this.room});
    if(result===null)return null;
    const v=object(result);
    if(typeof v.epoch!=='number' || !Number.isSafeInteger(v.epoch) || v.epoch<0
      || typeof v.key!=='string' || !/^[A-Za-z0-9+/]{43}=$/.test(v.key))integrity();
    // Behind the server: frames under an old key would not decrypt anywhere.
    return String(v.epoch)===roster.group.epoch?{epoch:String(v.epoch),key:v.key}:null;
  });}
  preview(view:CryptoGroupView,devices:string[],removals:string[]=[],receive=false):Promise<CryptoGroupPreview> {
    return this.run(!receive,async(rpc,roster,peers,_scope,call)=>{
      if(view.roster.room_id!==this.room || new Set(devices).size!==devices.length || new Set(removals).size!==removals.length)integrity();
      const current=await peers();const packages:AvailableKeyPackage[]=[];
      for(const device of devices) {
        const target=view.eligible.find(d=>d.device===device);
        if(!target || !current.some(d=>d.user===target.user && d.device===target.device && d.incarnation===target.incarnation && d.certificate===target.certificate)
          || target.replacement && !removals.includes(target.device))integrity();
        packages.push(decodeNative('AvailableKeyPackage',await call(()=>this.remote.availableCryptoKeyPackage(this.room,target.user,target.device))));
      }
      if(receive && (!view.event || devices.length || removals.length))integrity();
      return preview(await rpc({action:'preview',roster,packages,removals,event:receive?view.event:null}));
    });
  }
  confirm(selected:CryptoGroupPreview):Promise<void> {return this.run(['genesis','change'].includes(selected.kind),async(rpc,roster,peers,_scope,call)=>{
    await peers();
    const result=object(await rpc({action:'confirm',roster,id:selected.id,fingerprint:selected.fingerprint}));
    if(pending(result.pending))await this.resumeInner(rpc,call);
  });}
  private async resumeInner(rpc:(input:unknown)=>Promise<unknown>,call:<R>(fn:()=>Promise<R>,mutation?:boolean)=>Promise<R>):Promise<void> {
    const original=pending(await rpc({action:'pending',room:this.room}));if(!original)return;
    if(original.cancelling){await this.cancelInner(rpc,call);return;}
    let receipt:GroupReceipt;
    try {receipt=decodeNative('GroupReceipt',await call(()=>this.remote.cryptoGroupOperation(this.room,original.operation)));}
    catch(error) {
      if(error instanceof NativeError && error.status===409 && error.code==='crypto_group_cancelled'){await this.cancelInner(rpc,call);return;}
      if(!absent(error))throw error;
      if(original.superseded)throw new NativeError(409,'crypto_group_changed');
      const packet=decodeNative('GroupSubmission',await rpc({action:'retry',room:this.room}));
      receipt=decodeNative('GroupReceipt',await call(()=>this.remote.submitCryptoGroup(this.room,packet),true));
    }
    await rpc({action:'acknowledge',room:this.room,receipt});
  }
  resume():Promise<void> {return this.run(false,async(rpc,_r,peers,_s,call)=>{await peers();await this.resumeInner(rpc,call);});}
  private async cancelInner(rpc:(input:unknown)=>Promise<unknown>,call:<R>(fn:()=>Promise<R>)=>Promise<R>):Promise<void> {
    const result=object(await rpc({action:'cancel',room:this.room}));
    if(result.original===null){decodeNative('GroupSettlement',result.settlement);return;}
    const original=decodeNative('GroupSubmission',result.original);
    const settlement=decodeNative('GroupSettlement',await call(()=>this.remote.cancelCryptoGroup(this.room,original)));
    await rpc({action:'settle',room:this.room,settlement});
  }
  cancel():Promise<void> {return this.run(false,(rpc,_r,_p,_s,call)=>this.cancelInner(rpc,call));}
  publishPackages():Promise<void> {return this.run(false,async(rpc,_r,_p,_s,call)=>{
    // Query the historical receipt before retrying even an expired package.
    let lookup=await rpc({action:'packages_pending'});
    if(lookup===null){await rpc({action:'packages_prepare'});lookup=await rpc({action:'packages_pending'});}
    const original=object(lookup);if(!id(original.operation))integrity();
    let receipt:OperationReceipt;
    try {receipt=decodeNative('OperationReceipt',await call(()=>this.remote.cryptoOperation(original.operation as string)));}
    catch(error) {
      if(!absent(error))throw error;
      const packet=decodeNative('PublishKeyPackages',await rpc({action:'packages_retry'}));
      receipt=decodeNative('OperationReceipt',await call(()=>this.remote.publishKeyPackages(packet)));
    }
    await rpc({action:'packages_acknowledge',receipt});
  });}
}
