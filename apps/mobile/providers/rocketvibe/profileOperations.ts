/** Original profile commands survive a lost acknowledgement and process restart. */
import type {NativeDatabase} from './store.ts';
import type {AvatarCommand,OwnProfile,ProfileReceipt,UpdatePreferences,UpdateProfile} from './protocol.generated.ts';
import type {MyProfile} from '../../lib/myProfile.ts';
import {avatarBase64} from '../../lib/nativeAvatars.ts';
import {decodeNative} from './validation.ts';
import {roomIdentifier} from './roomOperations.ts';

export type ProfileOperation=
  |{kind:'profile';input:UpdateProfile}
  |{kind:'preferences';input:UpdatePreferences}
  |{kind:'avatar';input:AvatarCommand;upload:{mime:'image/png'|'image/jpeg';base64:string}|null};
export type ProfileSlot=ProfileOperation['kind'];
export type SavedProfileOperation={command:ProfileOperation;phase:'pending'|'proof'|'failed';error:string|null};
type Row={id:string;slot:string;payload:string;state:string;error:string|null};

export function avatarBytes(value:string):Uint8Array {
  if(!value||value.length>2_796_204||value.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw new Error('invalid_avatar');
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',length=value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0);
  if(length>2*1024*1024)throw new Error('invalid_avatar');
  const bytes=new Uint8Array(length);let at=0;
  for(let i=0;i<value.length;i+=4){
    const n=alphabet.indexOf(value[i])<<18|alphabet.indexOf(value[i+1])<<12|Math.max(0,alphabet.indexOf(value[i+2]))<<6|Math.max(0,alphabet.indexOf(value[i+3]));
    if(at<length)bytes[at++]=n>>16&255;if(at<length)bytes[at++]=n>>8&255;if(at<length)bytes[at++]=n&255;
  }
  if(avatarBase64(bytes)!==value)throw new Error('invalid_avatar');
  return bytes;
}
export function profileOperation(value:unknown):ProfileOperation {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_profile_command');
  const raw=value as Record<string,unknown>;let command:ProfileOperation;
  if(raw.kind==='profile')command={kind:'profile',input:decodeNative('UpdateProfile',raw.input)};
  else if(raw.kind==='preferences')command={kind:'preferences',input:decodeNative('UpdatePreferences',raw.input)};
  else if(raw.kind==='avatar'){
    let upload:Extract<ProfileOperation,{kind:'avatar'}>['upload']=null;
    if(raw.upload!==null){
      if(!raw.upload||typeof raw.upload!=='object'||Array.isArray(raw.upload))throw new Error('invalid_avatar');
      const data=raw.upload as Record<string,unknown>;
      if(!['image/png','image/jpeg'].includes(String(data.mime))||typeof data.base64!=='string'||Object.keys(data).some(k=>!['mime','base64'].includes(k)))throw new Error('invalid_avatar');
      avatarBytes(data.base64);upload={mime:data.mime as 'image/png'|'image/jpeg',base64:data.base64};
    }
    command={kind:'avatar',input:decodeNative('AvatarCommand',raw.input),upload};
  }else throw new Error('invalid_profile_command');
  if(Object.keys(raw).some(k=>!['kind','input',...(command.kind==='avatar'?['upload']:[])].includes(k))||!roomIdentifier(command.input.operation_id)||!roomIdentifier(command.input.expected_revision))throw new Error('invalid_profile_command');
  if(command.kind==='profile'){
    const p=command.input,bytes=(s:string)=>{let n=0;for(const c of s){const v=c.codePointAt(0)!;n+=v<128?1:v<2048?2:v<65536?3:4;}return n;};
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(p.username)||!p.display_name.trim()||bytes(p.display_name)>256||bytes(p.bio)>4096||bytes(p.status_text)>512||/[\x00-\x1f\x7f-\x9f]/.test(p.display_name+p.status_text)||p.bio.includes('\0'))throw new Error('invalid_profile');
  }
  return command;
}
function row(value:Row):SavedProfileOperation {
  const command=profileOperation(JSON.parse(value.payload));
  if(command.input.operation_id!==value.id||command.kind!==value.slot||!['pending','proof','failed'].includes(value.state))throw new Error('invalid_profile_command');
  return {command,phase:value.state as SavedProfileOperation['phase'],error:value.error};
}
function form(command:ProfileOperation):string {
  const input=Object.entries(command.input).filter(([k])=>!['operation_id','expected_revision'].includes(k)).sort(([a],[b])=>a.localeCompare(b));
  return JSON.stringify([command.kind,input,command.kind==='avatar'?command.upload:null]);
}
export function nativeMyProfile(own:OwnProfile):MyProfile {
  return {revision:own.profile.revision,username:own.profile.user.username,name:own.profile.user.display_name??own.profile.user.username,bio:own.profile.bio,email:own.email??'',status:own.profile.status??'online',statusText:own.profile.status_text};
}
export function profileIntent(saved:SavedProfileOperation|null,current:MyProfile):MyProfile {
  if(saved?.command.kind!=='profile')return current;
  const p=saved.command.input;return {...current,username:p.username,name:p.display_name??'',bio:p.bio,status:p.status,statusText:p.status_text};
}

export class NativeProfileOperations {
  private readonly db:NativeDatabase;
  private readonly atomic:<T>(fn:()=>Promise<T>)=>Promise<T>;
  private readonly valid:()=>Promise<boolean>;
  constructor(db:NativeDatabase,atomic:<T>(fn:()=>Promise<T>)=>Promise<T>,valid:()=>Promise<boolean>){this.db=db;this.atomic=atomic;this.valid=valid;}
  get(slot:ProfileSlot):Promise<SavedProfileOperation|null> {return this.atomic(async()=>{if(!await this.valid())return null;const value=await this.db.getFirstAsync<Row>('SELECT * FROM native_profile_operations WHERE slot=?',[slot]);return value?row(value):null;});}
  stage(value:ProfileOperation):Promise<SavedProfileOperation|null> {
    const command=profileOperation(value);
    return this.atomic(async()=>{
      if(!await this.valid())throw new Error('server_identity_changed');
      const old=await this.db.getFirstAsync<Row>('SELECT * FROM native_profile_operations WHERE slot=?',[command.kind]);
      if(old){const saved=row(old);return saved.phase!=='failed'&&form(saved.command)===form(command)?saved:null;}
      await this.db.runAsync('INSERT INTO native_profile_operations(id,slot,payload) VALUES(?,?,?)',[command.input.operation_id,command.kind,JSON.stringify(command)]);
      return {command,phase:'pending',error:null};
    });
  }
  pending():Promise<SavedProfileOperation[]> {return this.atomic(async()=>{
    if(!await this.valid())return [];
    const result:SavedProfileOperation[]=[];
    for(const value of await this.db.getAllAsync<Row>("SELECT * FROM native_profile_operations WHERE state='pending' ORDER BY rowid",[])){
      try{result.push(row(value));}catch{await this.db.runAsync("UPDATE native_profile_operations SET state='failed',error='invalid_profile_command' WHERE id=?",[value.id]);}
    }
    return result;
  });}
  mark(saved:SavedProfileOperation,phase:SavedProfileOperation['phase'],error:string|null):Promise<void> {return this.atomic(async()=>{if(await this.valid())await this.db.runAsync('UPDATE native_profile_operations SET state=?,error=? WHERE slot=? AND id=?',[phase,error,saved.command.kind,saved.command.input.operation_id]);});}
  discard(slot:ProfileSlot,id:string):Promise<boolean> {return this.atomic(async()=>{
    if(!await this.valid())return false;
    const old=await this.db.getFirstAsync<Row>("SELECT * FROM native_profile_operations WHERE slot=? AND id=? AND state IN ('proof','failed')",[slot,id]);
    if(!old)return false;await this.db.runAsync('DELETE FROM native_profile_operations WHERE slot=? AND id=?',[slot,id]);return true;
  });}
  confirm(saved:SavedProfileOperation,value:ProfileReceipt,alive:()=>boolean):Promise<void> {
    const receipt=decodeNative('ProfileReceipt',value);
    if(receipt.operation_id!==saved.command.input.operation_id||!roomIdentifier(receipt.applied_revision))throw new Error('invalid_profile_receipt');
    return this.atomic(async()=>{
      if(!alive()||!await this.valid())throw new Error('session_closed');
      await this.db.runAsync('DELETE FROM native_profile_operations WHERE slot=? AND id=?',[saved.command.kind,receipt.operation_id]);
      if(!alive())throw new Error('session_closed');
    });
  }
}
