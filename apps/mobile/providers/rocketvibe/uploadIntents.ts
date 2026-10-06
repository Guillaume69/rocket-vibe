/** Upload identity and original bytes are committed with the existing UI outbox. */
import type {NativeDatabase} from './store.ts';
import type {CompleteUpload,Message,PrepareUpload,Upload} from './protocol.generated.ts';
import {fileDescriptor} from './fileDescriptors.ts';
import {decodeNative} from './validation.ts';
import {INSERT_UPLOAD} from '../../db/upserts.ts';

export type UploadIntent={id:string;room:string;membership:string;uri:string;prepare:PrepareUpload;complete:CompleteUpload};
export type SavedUpload=UploadIntent&{phase:'pending'|'cancelling';status:string;fileId:string|null};
type Row={payload:string;phase:SavedUpload['phase'];status:string;file_id:string|null};
const SELECT='SELECT n.payload,n.phase,t.status,t.file_id FROM native_upload_intents n JOIN uploads t ON t.id=n.id';
function saved(row:Row):SavedUpload {const value=JSON.parse(row.payload) as UploadIntent;return {...value,phase:row.phase,status:row.status,fileId:row.file_id};}
export class NativeUploadIntents {
  private readonly db:NativeDatabase;
  private readonly atomic:<T>(fn:()=>Promise<T>)=>Promise<T>;
  private readonly valid:(room:string,membership:string)=>Promise<boolean>;
  private readonly project:(message:Message)=>Promise<void>;
  constructor(db:NativeDatabase,atomic:<T>(fn:()=>Promise<T>)=>Promise<T>,valid:(room:string,membership:string)=>Promise<boolean>,project:(message:Message)=>Promise<void>){
    this.db=db;this.atomic=atomic;this.valid=valid;this.project=project;
  }
  stage(intent:UploadIntent):Promise<void> {
    return this.atomic(async()=>{
      if(!await this.valid(intent.room,intent.membership))throw new Error('upload_scope_changed');
      await this.db.runAsync('INSERT INTO native_upload_intents(id,rid,payload,phase) VALUES(?,?,?,?)',[intent.id,intent.room,JSON.stringify(intent),'pending']);
      const caption=intent.complete.content.kind==='plain'?intent.complete.content.markdown:'';
      await this.db.runAsync(INSERT_UPLOAD,[intent.id,intent.room,intent.uri,intent.prepare.filename??'',intent.prepare.media_type,caption,Date.now(),intent.complete.reply_to??null]);
    });
  }
  list():Promise<SavedUpload[]> {return this.atomic(async()=>{
    const rows=await this.db.getAllAsync<Row>(`${SELECT} ORDER BY t.created_at,t.id`,[]);
    const result:SavedUpload[]=[];
    for(const row of rows){const intent=saved(row);if(await this.valid(intent.room,intent.membership))result.push(intent);}
    return result;
  });}
  get(id:string):Promise<SavedUpload|null>{return this.atomic(async()=>{
    const row=await this.db.getFirstAsync<Row>(`${SELECT} WHERE n.id=?`,[id]);
    const value=row?saved(row):null;return value&&await this.valid(value.room,value.membership)?value:null;
  });}
  private async current(intent:UploadIntent):Promise<boolean>{
    return await this.valid(intent.room,intent.membership)&&!!await this.db.getFirstAsync('SELECT id FROM native_upload_intents WHERE id=? AND payload=?',[intent.id,JSON.stringify({id:intent.id,room:intent.room,membership:intent.membership,uri:intent.uri,prepare:intent.prepare,complete:intent.complete})]);
  }
  reset(exclude:string[]):Promise<void>{return this.atomic(async()=>{
    for(const row of await this.db.getAllAsync<Row>(`${SELECT} WHERE t.status='sending'`,[])){
      const intent=saved(row);if(!exclude.includes(intent.id)&&await this.current(intent))await this.db.runAsync("UPDATE uploads SET status='pending' WHERE id=?",[intent.id]);
    }
  });}
  claim(intent:UploadIntent):Promise<boolean>{return this.atomic(async()=>{
    if(!await this.current(intent)||!await this.db.getFirstAsync("SELECT id FROM uploads WHERE id=? AND status='pending'",[intent.id]))return false;
    await this.db.runAsync("UPDATE uploads SET status='sending' WHERE id=?",[intent.id]);return true;
  });}
  remember(intent:UploadIntent,upload:Upload):Promise<void>{return this.atomic(async()=>{
    if(!await this.current(intent))throw new Error('upload_scope_changed');
    const actual=fileDescriptor(upload.file,intent.room),expected={...intent.prepare,id:upload.id};
    if(actual.id!==upload.id||actual.sha256!==expected.sha256||actual.bytes!==expected.bytes||actual.media_type!==expected.media_type||actual.filename!==expected.filename)throw new Error('invalid_upload');
    await this.db.runAsync('UPDATE uploads SET file_id=? WHERE id=?',[upload.id,intent.id]);
  });}
  mark(intent:UploadIntent,status:'pending'|'failed',error:string|null):Promise<void>{return this.atomic(async()=>{
    if(await this.current(intent))await this.db.runAsync('UPDATE uploads SET status=?,last_error=? WHERE id=?',[status,error,intent.id]);
  });}
  cancelling(intent:UploadIntent):Promise<void>{return this.atomic(async()=>{
    if(!await this.current(intent))return;
    await this.db.runAsync("UPDATE native_upload_intents SET phase='cancelling' WHERE id=?",[intent.id]);
    await this.db.runAsync("UPDATE uploads SET status='pending' WHERE id=?",[intent.id]);
  });}
  confirm(intent:UploadIntent,message:Message,alive:()=>boolean):Promise<boolean>{return this.atomic(async()=>{
    if(!alive()||!await this.current(intent))return false;
    const confirmed=decodeNative('Message',message);
    const row=await this.db.getFirstAsync<{file_id:string}>('SELECT file_id FROM uploads WHERE id=?',[intent.id]);
    if(confirmed.id!==intent.complete.operation_id||confirmed.room_id!==intent.room||!confirmed.deleted&&confirmed.files?.[0]?.id!==row?.file_id)throw new Error('invalid_upload_receipt');
    await this.project(confirmed);
    if(!alive())throw new Error('session_closed');
    await this.clear(intent.id);return true;
  });}
  discard(intent:UploadIntent):Promise<boolean>{return this.atomic(async()=>{if(!await this.current(intent))return false;await this.clear(intent.id);return true;});}
  private async clear(id:string):Promise<void>{
    await this.db.runAsync('DELETE FROM native_upload_intents WHERE id=?',[id]);
    await this.db.runAsync('DELETE FROM uploads WHERE id=?',[id]);
  }
}
