import type {FichierAEnvoyer} from '../../lib/upload.ts';
import type {OutboxFichiers} from '../../lib/fournisseur.ts';
import {validerFichier} from '../../lib/envoiFichiers.ts';
import {FILE_MAX,FILE_TYPES,fileDescriptor} from './fileDescriptors.ts';
import {NativeError} from './transport.ts';
import type {NativeChat} from './chat.ts';
import type {SavedUpload} from './uploadIntents.ts';

export type NativeFileSender=(url:string,headers:Record<string,string>,uri:string,signal:AbortSignal,progress:(fraction:number)=>void)=>Promise<{status:number;body:string}>;
export type NativeFileIO={
  available?:boolean;
  /** Make a private durable copy, then hash it without buffering the file. */
  copy:(file:FichierAEnvoyer,id:string)=>Promise<{uri:string;bytes:number;sha256:string}>;
  remove:(uri:string)=>Promise<void>;
  send:NativeFileSender;
};
const inFlight=new Set<string>();
const permanent=(e:unknown)=>e instanceof NativeError&&e.status>=400&&e.status!==408&&e.status!==429&&e.status!==503&&e.code!=='upload_in_progress'&&e.code!=='delivery_revalidate';

/** Uses the same outbox rows, progress and retry/abandon controls as Rocket.Chat. */
export class NativeFileOutbox implements OutboxFichiers {
  readonly progression=new Map<string,number>();
  private listeners=new Set<()=>void>();
  private running:Promise<void>|null=null;
  private transfers=new Map<string,AbortController>();
  private retry:ReturnType<typeof setTimeout>|null=null;
  private closed=false;
  private readonly unlisten:()=>void;
  private readonly chat:NativeChat;
  private readonly io:NativeFileIO;
  private readonly id:()=>string;
  constructor(chat:NativeChat,io:NativeFileIO,id:()=>string){
    this.chat=chat;this.io=io;this.id=id;
    this.unlisten=chat.subscribe(()=>{
      if(!chat.filesActive){for(const transfer of this.transfers.values())transfer.abort();}
      else void this.traiter().catch(()=>{});
    });
  }
  abonner(fn:()=>void):()=>void{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
  private notify():void{for(const fn of this.listeners)fn();}
  close():void {this.closed=true;this.unlisten();if(this.retry)clearTimeout(this.retry);for(const c of this.transfers.values())c.abort();this.listeners.clear();}
  fermer():void {this.close();}
  async valider(file:{type:string;taille:number|null}):Promise<void>{
    validerFichier({tailleMax:FILE_MAX,typesAcceptes:FILE_TYPES,fichiersChiffres:false},file);
    if(file.taille!==null&&(!Number.isSafeInteger(file.taille)||file.taille<=0))throw new NativeError(422,'invalid_file');
  }
  async envoyer(room:string,file:FichierAEnvoyer&{taille:number|null},caption=''):Promise<void>{
    if(this.closed)throw new NativeError(0,'session_closed');
    await this.valider(file);
    const membership=(await this.chat.store.readState(room))?.membership_version;
    if(!membership)throw new NativeError(403,'room_access_denied');
    const id=this.id(),operation=this.id(),copy=await this.io.copy(file,id);
    try{
      if(this.closed)throw new NativeError(0,'session_closed');
      await this.valider({type:file.type,taille:copy.bytes});
      const descriptor=fileDescriptor({id,room_id:room,bytes:String(copy.bytes),sha256:copy.sha256,media_type:file.type,filename:file.nom.trim(),encrypted:false},room);
      await this.chat.store.uploads.stage({id,room,membership,uri:copy.uri,
        prepare:{operation_id:id,room_id:room,bytes:descriptor.bytes,sha256:descriptor.sha256,media_type:descriptor.media_type,filename:descriptor.filename,encrypted:false},
        complete:{operation_id:operation,content:{kind:'plain',markdown:caption,mentions:[],quotes:[],files:[]}},
      });
    }catch(error){await this.io.remove(copy.uri).catch(()=>{});throw error;}
    this.notify();await this.traiter();
  }
  traiter():Promise<void>{
    if(this.running)return this.running;
    if(this.closed||!this.chat.filesActive)return Promise.resolve();
    const running=this.drain().finally(()=>{if(this.running===running)this.running=null;});
    this.running=running;return running;
  }
  private async drain():Promise<void>{
    await this.chat.store.uploads.reset([...inFlight]);
    for(const intent of await this.chat.store.uploads.list()){
      if(this.closed||!this.chat.filesActive)break;
      if(intent.status!=='en-attente'||inFlight.has(intent.id)||!await this.chat.store.uploads.claim(intent))continue;
      inFlight.add(intent.id);
      try{await this.apply(intent);}
      catch(error){
        if(!this.closed){
          const code=error instanceof Error?error.message:'upload_failed';
          await this.chat.store.uploads.mark(intent,permanent(error)?'echec':'en-attente',code);
          if(!permanent(error)&&this.retry===null)this.retry=setTimeout(()=>{this.retry=null;void this.traiter().catch(()=>{});},error instanceof NativeError&&error.retryAfter?error.retryAfter*1000:5000);
        }
      }finally{inFlight.delete(intent.id);this.transfers.delete(intent.id);this.progression.delete(intent.id);this.notify();}
    }
  }
  private async apply(intent:SavedUpload):Promise<void>{
    const scope=await this.chat.fileScope(intent.room,intent.membership);
    const controller=new AbortController();this.transfers.set(intent.id,controller);
    const check=async()=>{await scope.check();if(this.closed||controller.signal.aborted||!await this.chat.store.uploads.get(intent.id))throw new NativeError(0,'session_closed');};
    await check();
    // Preparing again is an idempotent status proof even when its first reply was lost.
    let upload=await this.chat.transport.prepareUpload(intent.prepare);await check();
    await this.chat.store.uploads.remember(intent,upload);
    const latest=await this.chat.store.uploads.get(intent.id);
    if(latest?.phase==='cancelling'){
      if(upload.state!=='completed'){
        try{upload=await this.chat.transport.cancelUpload(upload.id);}
        catch(error){if(!(error instanceof NativeError)||error.status!==409)throw error;upload=await this.chat.transport.uploadStatus(upload.id);if(upload.state!=='completed')throw error;}
        await check();
      }
      if(upload.state!=='completed'){
        if(await this.chat.store.uploads.discard(intent))await this.io.remove(intent.uri).catch(()=>{});
        return;
      }
    }
    if(upload.state==='cancelled'||upload.state==='expired')throw new NativeError(410,'upload_expired');
    if(upload.state==='prepared'){
      upload=await this.chat.transport.uploadLocal(upload.id,intent.uri,this.io.send,controller.signal,p=>{this.progression.set(intent.id,p);this.notify();});
      await check();await this.chat.store.uploads.remember(intent,upload);
      if((await this.chat.store.uploads.get(intent.id))?.phase==='cancelling')throw new NativeError(0,'upload_cancel_pending');
    }
    if(intent.complete.content.kind!=='plain')throw new NativeError(422,'invalid_file');
    const message=await this.chat.transport.completeUpload(upload.id,{...intent.complete,content:{...intent.complete.content,files:[upload.id]}});
    await check();
    if(await this.chat.store.uploads.confirm(intent,message,scope.alive))await this.io.remove(intent.uri).catch(()=>{});
  }
  async reessayer(id:string):Promise<void>{
    const intent=await this.chat.store.uploads.get(id);if(intent)await this.chat.store.uploads.mark(intent,'en-attente',null);
    this.notify();await this.traiter();
  }
  async abandonner(id:string):Promise<void>{
    const intent=await this.chat.store.uploads.get(id);if(!intent)return;
    await this.chat.store.uploads.cancelling(intent);this.transfers.get(id)?.abort();
    if(!this.closed&&this.chat.filesActive){
      try{
        const scope=await this.chat.fileScope(intent.room,intent.membership);
        const upload=await this.chat.transport.prepareUpload(intent.prepare);await scope.check();
        if(upload.state==='prepared'||upload.state==='ready')await this.chat.transport.cancelUpload(upload.id);
      }catch(error){
        // A racing confirmation may already have committed. The durable cancel
        // is replayed below and resolves that receipt instead of inventing success.
        if(this.closed)return;
        await this.chat.store.uploads.mark(intent,'en-attente',error instanceof Error?error.message:'upload_cancel_pending');
      }
    }
    await this.running;
    if(!this.closed)await this.chat.store.uploads.mark(intent,'en-attente',null);
    await this.traiter();this.notify();
  }
}
