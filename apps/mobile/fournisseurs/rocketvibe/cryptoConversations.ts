import type {CryptoConversationBridge} from '../../modules/crypto-native/index.ts';
import {CryptoGroupAccess,type CryptoRoomAction} from './cryptoGroups.ts';
import type {ApplicationReceipt,ApplicationSettlement,ApplicationSubmission,DeliveryPage,GroupRoster,GroupState,SendMessage} from './protocol.generated.ts';
import type {NativeQuoteAttachment,NativeQuoteSelection,PublicQuoteSources} from './quotes.ts';
import {privateQuoteCards,type PrivateQuoteSelection,type PrivateQuotePreview,type CryptoQuotePreview,type PrivateQuoteRoom} from './cryptoQuotes.ts';
import {NativeError} from './transport.ts';
import {decodeNative} from './validation.ts';

export type ConversationTransport={
  cryptoGroupRoster:(room:string)=>Promise<GroupRoster>;
  cryptoGroupState:(room:string)=>Promise<GroupState>;
  cryptoDelivery:(room:string,after:string,through?:string)=>Promise<DeliveryPage>;
  cryptoMessageOperation:(room:string,operation:string)=>Promise<ApplicationReceipt>;
  submitCryptoMessage:(room:string,input:ApplicationSubmission)=>Promise<ApplicationReceipt>;
  cancelCryptoMessage:(room:string,input:ApplicationSubmission)=>Promise<ApplicationSettlement>;
};
export type CryptoMessage={id:string;operation:string;author:string;document:SendMessage;position:string|null;
  author_label?:string;observed_at:string;status:'journaled'|'pending'|'accepted'|'cancelling'|'cancelled'};
export type CryptoConversationView={admission:string;after:string;catching_up:boolean;has_older:boolean;can_send:boolean;draft:string;messages:CryptoMessage[];
  root:CryptoMessage|null;retained_replies:Record<string,number>;quote_cards?:Record<string,NativeQuoteAttachment[]>};
const id=(v:unknown):v is string=>typeof v==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
function integrity():never {throw new NativeError(0,'crypto_integrity_failed');}
function object(v:unknown):Record<string,unknown> {if(!v || typeof v!=='object' || Array.isArray(v))integrity();return v as Record<string,unknown>;}
function position(v:unknown,zero=true):v is string {
  return typeof v==='string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v)<=9223372036854775807n && (zero || v!=='0');
}
function decodeRow(raw:unknown,target:string|null|undefined):CryptoMessage {
  const row=object(raw),document=decodeNative('SendMessage',row.document);
  if(!id(row.id) || !id(row.operation) || !id(row.author) || (row.position!==null && !position(row.position,false))
    || !position(row.observed_at) || BigInt(row.observed_at)>253402300799n
    || !['journaled','pending','accepted','cancelling','cancelled'].includes(String(row.status))
    || document.operation_id!==row.operation || target!==undefined && (document.reply_to??null)!==target)integrity();
  return {...row,document} as CryptoMessage;
}
function quoteSelection(value:unknown):NativeQuoteSelection {
  const v=object(value),r=object(v.reference);
  if(!id(r.room_id) || !id(r.message_id) || !position(r.revision,false) || !id(v.instance_id) || !id(v.data_epoch)
    || !id(v.membership_version) || v.crypto_admission!==undefined && (typeof v.crypto_admission!=='string' || !/^[0-9a-f]{64}$/.test(v.crypto_admission)))integrity();
  return v as NativeQuoteSelection;
}
function privateSelection(value:unknown):PrivateQuoteSelection {
  const selection=quoteSelection(value);if(selection.crypto_admission===undefined)integrity();
  return selection as PrivateQuoteSelection;
}
function projection(value:unknown,thread:string|null):CryptoConversationView {
  const v=object(value);
  if(typeof v.admission!=='string' || !/^[0-9a-f]{64}$/.test(v.admission) || !position(v.after)
    || typeof v.catching_up!=='boolean' || typeof v.has_older!=='boolean' || typeof v.can_send!=='boolean'
    || typeof v.draft!=='string' || v.draft.length>65536 || !Array.isArray(v.messages) || v.messages.length>264)integrity();
  const messages=v.messages.map(raw=>decodeRow(raw,thread));
  if(new Set(messages.map(v=>v.operation)).size!==messages.length || new Set(messages.map(v=>v.id)).size!==messages.length)integrity();
  const root=v.root===null?null:decodeRow(v.root,null),replies=object(v.retained_replies);
  if(root && (!thread || root.id!==thread || root.status!=='journaled' || root.position===null
    || BigInt(root.position)>BigInt(v.after) || messages.some(v=>v.id===root.id || v.operation===root.operation)))integrity();
  if(thread && !root && v.can_send)integrity();
  if(Object.entries(replies).length>64 || Object.entries(replies).some(([key,n])=>!id(key) || !Number.isInteger(n) || Number(n)<1 || Number(n)>64))integrity();
  return {...v,messages,root,retained_replies:replies} as CryptoConversationView;
}
const absent=(error:unknown)=>error instanceof NativeError && error.status===404 && error.code==='not_found';
/** Public HTTP packets only; clear render documents are transient. The original
 * packet, drafts, journal and ratchets are checkpointed by Rust before HTTP. */
export class CryptoConversationAccess {
  private readonly groups:CryptoGroupAccess;
  private readonly bridge:CryptoConversationBridge;
  private readonly remote:ConversationTransport;
  private readonly room:string;
  private readonly thread:string|null;
  private admission:string|null=null;
  private closed=false;
  private localDraft:((text:string)=>Promise<void>)|null=null;
  private draftQueue:Promise<void>=Promise.resolve();
  private readonly membership:string|null;
  private readonly sourceMembership:(room:string)=>Promise<string|null>;
  private readonly publicSources:(room:string,ids:readonly string[])=>Promise<PublicQuoteSources|null>;
  constructor(groups:CryptoGroupAccess,bridge:CryptoConversationBridge,remote:ConversationTransport,room:string,thread:string|null=null,
    membership:string|null=null,sourceMembership:(room:string)=>Promise<string|null>=async()=>null,
    publicSources:(room:string,ids:readonly string[])=>Promise<PublicQuoteSources|null>=async()=>null) {
    this.groups=groups;this.bridge=bridge;this.remote=remote;this.room=room;this.thread=thread;
    this.membership=membership;this.sourceMembership=sourceMembership;
    this.publicSources=publicSources;
  }
  private async source(room:string,rpc:Parameters<CryptoRoomAction<void>>[0],peers:Parameters<CryptoRoomAction<void>>[2],
    scope:Parameters<CryptoRoomAction<void>>[3],call:Parameters<CryptoRoomAction<void>>[4],ids:readonly string[]=[]):Promise<PrivateQuoteRoom|null> {
    if(!id(room))integrity();
    const clear=await call(()=>this.publicSources(room,ids));
    if(clear) {
      // Reader-authorized ordinary excerpts; the protected send document gets
      // references only, never their text or private descendants.
      const messages:CryptoMessage[]=clear.messages.map(({id,excerpt})=>({id,operation:id,author:excerpt.author.id,author_label:excerpt.author.username,
        document:{operation_id:id,text:excerpt.text,quotes:excerpt.references??[],reply_to:null,cards:[]},
        position:excerpt.revision,observed_at:'0',status:'journaled'}));
      return {room,membership:clear.membership,admission:null,messages,observation:null};
    }
    const membership=await this.sourceMembership(room);if(membership===null)return null;
    try {
      const roster=decodeNative('GroupRoster',await call(()=>this.remote.cryptoGroupRoster(room)));
      if(roster.room_id!==room || roster.scope.instance_id!==scope.instance || roster.scope.data_epoch!==scope.dataEpoch)integrity();
      if(!roster.members.some(m=>m.user_id===scope.user))return null;
      await peers(roster);
      const state=decodeNative('GroupState',await call(()=>this.remote.cryptoGroupState(room)));
      const value=await rpc({action:'sources',source:{roster,state}});
      if(await this.sourceMembership(room)!==membership || value===null)return null;
      const v=object(value);
      if(v.room_id!==room || typeof v.admission!=='string' || !/^[0-9a-f]{64}$/.test(v.admission) || !position(v.after)
        || !Array.isArray(v.messages) || v.messages.length>64)integrity();
      const messages=v.messages.map(raw=>decodeRow(raw,undefined));
      if(messages.some(m=>m.status!=='journaled' || m.position===null || BigInt(m.position)>BigInt(v.after as string))
        || new Set(messages.map(m=>m.id)).size!==messages.length || new Set(messages.map(m=>m.operation)).size!==messages.length)integrity();
      return {room,membership,admission:v.admission,messages,observation:{roster,state}};
    } catch(error) {if(error instanceof NativeError && [403,404].includes(error.status))return null;throw error;}
  }
  private async quotes(view:CryptoConversationView,rpc:Parameters<CryptoRoomAction<void>>[0],peers:Parameters<CryptoRoomAction<void>>[2],
    scope:Parameters<CryptoRoomAction<void>>[3],call:Parameters<CryptoRoomAction<void>>[4]):Promise<CryptoConversationView> {
    const rows=[...(view.root?[view.root]:[]),...view.messages];
    let refs=rows.flatMap(m=>m.document.quotes??[]);
    if(!refs.length)return view;
    const sources=new Map<string,PrivateQuoteRoom|null>();
    const requested=new Map<string,Set<string>>();
    for(let depth=0;depth<2;depth++) {
      const changed=new Set<string>();
      for(const r of refs) {
        if(!requested.has(r.room_id))requested.set(r.room_id,new Set());
        const ids=requested.get(r.room_id)!;if(!ids.has(r.message_id)){ids.add(r.message_id);changed.add(r.room_id);}
      }
      for(const room of changed)sources.set(room,await this.source(room,rpc,peers,scope,call,[...requested.get(room)!]));
      if(depth===0)refs=refs.flatMap(r=>sources.get(r.room_id)?.messages.find(m=>m.id===r.message_id)?.document.quotes??[]);
    }
    for(const [room,old] of sources)if(old) {
      const fresh=await this.source(room,rpc,peers,scope,call,[...requested.get(room)!]);
      sources.set(room,fresh?.membership===old.membership && fresh.admission===old.admission?fresh:null);
    }
    const own=sources.has(this.room)?sources.get(this.room):await this.source(this.room,rpc,peers,scope,call);
    if(!own || own.admission!==view.admission){await this.close();throw new NativeError(409,'crypto_scope_changed');}
    const cards:Record<string,NativeQuoteAttachment[]>={};
    for(const row of rows)cards[row.id]=privateQuoteCards(row.document.quotes??[],sources,[JSON.stringify([this.room,row.id])]);
    return {...view,quote_cards:cards};
  }
  close():Promise<void> {this.closed=true;this.localDraft=null;return this.groups.close();}
  get isClosed():boolean {return this.closed || this.groups.isClosed;}
  private run<T>(mutation:boolean,action:CryptoRoomAction<T>):Promise<T> {
    if(this.isClosed)return Promise.reject(new NativeError(0,'session_closed'));
    return this.groups.withRoom(mutation,async(h,d,i)=>{
      const result=await this.bridge.conversationAction(h,d,i);
      const request=JSON.parse(i) as {command:{action:string};roster:unknown;state:unknown;thread:string|null};
      if(request.command.action==='view') {
        // Local authoring uses the last verified public binding. Rust rechecks
        // its current protected admission, grant, clock and identity; it cannot
        // post HTTP. Each keystroke can be saved without directory network IO.
        this.localDraft=async text=>{
          if(this.isClosed)throw new NativeError(0,'session_closed');
          const value=await this.bridge.conversationAction(h,d,JSON.stringify({...request,command:{action:'draft',text}}));
          if(value!=='null')integrity();
        };
      }
      return result;
    },async(rpc,roster,peers,scope,call)=>{
      await peers();const state=decodeNative('GroupState',await call(()=>this.remote.cryptoGroupState(this.room)));
      return action(command=>rpc({roster,state,thread:this.thread,command}),roster,peers,scope,call);
    });
  }
  refresh(before:string|null=null,limit=200):Promise<CryptoConversationView> {
    return this.run(false,async(rpc,_r,peers,scope,call)=>{
      if(before===null) {
        const cursor=object(await rpc({action:'journal_request'}));
        if(!position(cursor.after) || cursor.through!==null && !position(cursor.through))integrity();
        const page=decodeNative('DeliveryPage',await call(()=>this.remote.cryptoDelivery(this.room,cursor.after as string,cursor.through as string|null??undefined)));
        await rpc({action:'receive',page});
      }
      const view=projection(await rpc({action:'view',before,limit}),this.thread);
      if(this.admission && this.admission!==view.admission){await this.close();throw new NativeError(409,'crypto_scope_changed');}
      this.admission=view.admission;return this.quotes(view,rpc,peers,scope,call);
    });
  }
  draft(text?:string):Promise<string|void> {return this.run(false,async rpc=>{
    const result=await rpc({action:'draft',text:text??null});
    if(text===undefined){if(typeof result!=='string' || result.length>65536)integrity();return result;}
    if(result!==null)integrity();
  });}
  saveDraft(text:string):Promise<void> {
    const save=this.localDraft;
    if(this.isClosed || !save)return Promise.reject(new NativeError(0,'session_closed'));
    const request=this.draftQueue.then(()=>save(text));
    this.draftQueue=request.catch(()=>{});return request;
  }
  restore(operation:string):Promise<void> {return this.run(false,async rpc=>{
    if(!id(operation))integrity();if(await rpc({action:'restore',operation})!==null)integrity();
  });}
  selectQuote(message:string):Promise<PrivateQuotePreview> {
    return this.run(false,async(rpc,_r,_p,_s,call)=>{
      if(!id(message) || this.membership===null || await call(()=>this.sourceMembership(this.room))!==this.membership)integrity();
      const value=object(await rpc({action:'select_quote',message,membership:this.membership}));
      const selection=privateSelection(value.selection);
      if(selection.reference.room_id!==this.room || selection.reference.message_id!==message || selection.membership_version!==this.membership
        || typeof value.author!=='string' || !id(value.author) || typeof value.text!=='string' || Array.from(value.text).length>1024)integrity();
      return {selection,author:value.author,text:value.text};
    });
  }
  readMessage(message:string):Promise<CryptoMessage|null> {
    if(!id(message))integrity();
    return this.run(false,async(rpc,_r,peers,scope,call)=>{
      const room=await this.source(this.room,rpc,peers,scope,call);
      if(!room || this.admission!==null && room.admission!==this.admission){await this.close();throw new NativeError(409,'crypto_scope_changed');}
      return room.messages.find(m=>m.id===message)??null;
    });
  }
  selectSourceQuote(room:string,message:string):Promise<CryptoQuotePreview> {
    return this.run(false,async(rpc,_r,peers,scope,call)=>{
      if(!id(room) || !id(message))integrity();
      const source=await this.source(room,rpc,peers,scope,call,[message]);
      const row=source?.messages.find(m=>m.id===message);if(!source || !row?.position)integrity();
      const selection:NativeQuoteSelection={reference:{room_id:room,message_id:message,revision:row.position},instance_id:scope.instance,
        data_epoch:scope.dataEpoch,membership_version:source.membership,...(source.admission===null?{}:{crypto_admission:source.admission})};
      const fresh=await this.source(room,rpc,peers,scope,call,[message]);
      return this.quotePreview(selection,fresh)??integrity();
    });
  }
  private quotePreview(selection:NativeQuoteSelection,room:PrivateQuoteRoom|null):CryptoQuotePreview|null {
    const message=room?.messages.find(m=>m.id===selection.reference.message_id);
    if(!room || room.membership!==selection.membership_version || room.admission!==(selection.crypto_admission??null)
      || !message || message.position!==selection.reference.revision)return null;
    return {selection,author:message.author_label??message.author,text:Array.from(message.document.text).slice(0,1024).join('')};
  }
  previewQuote(selected:NativeQuoteSelection):Promise<CryptoQuotePreview|null> {
    const selection=quoteSelection(selected);
    return this.run(false,async(rpc,_r,peers,scope,call)=>{
      if(selection.instance_id!==scope.instance || selection.data_epoch!==scope.dataEpoch)return null;
      const room=await this.source(selection.reference.room_id,rpc,peers,scope,call,[selection.reference.message_id]);
      return this.quotePreview(selection,room);
    });
  }
  async send(text:string,quotes:readonly NativeQuoteSelection[]=[]):Promise<string> {
    return this.run(true,async(rpc,_r,peers,scope,call)=>{
      const selected=quotes.map(quoteSelection),sources:PrivateQuoteRoom[]=[];
      if(selected.length>8 || new Set(selected.map(q=>JSON.stringify([q.reference.room_id,q.reference.message_id]))).size!==selected.length)integrity();
      for(const room of new Set(selected.map(q=>q.reference.room_id))) {
        const ids=selected.filter(q=>q.reference.room_id===room).map(q=>q.reference.message_id);
        const source=await this.source(room,rpc,peers,scope,call,ids);if(!source)integrity();sources.push(source);
      }
      for(const q of selected) {
        const source=sources.find(s=>s.room===q.reference.room_id)!;
        if(q.instance_id!==scope.instance || q.data_epoch!==scope.dataEpoch || !this.quotePreview(q,source))integrity();
      }
      for(let i=0;i<sources.length;i++) {
        const old=sources[i],refs=selected.filter(q=>q.reference.room_id===old.room);
        const fresh=await this.source(old.room,rpc,peers,scope,call,refs.map(q=>q.reference.message_id));
        if(!fresh || fresh.membership!==old.membership || fresh.admission!==old.admission || refs.some(q=>!this.quotePreview(q,fresh)))integrity();
        sources[i]=fresh;
      }
      const prepared=object(await rpc({action:'prepare',text,quotes:selected,
        sources:sources.filter(s=>s.room!==this.room && s.observation!==null).map(s=>s.observation),
        public_sources:sources.filter(s=>s.admission===null).map(s=>({room_id:s.room,membership_version:s.membership,
          references:selected.filter(q=>q.reference.room_id===s.room).map(q=>q.reference)}))}));if(!id(prepared.operation))integrity();
      // Once prepared, an uncertain HTTP result leaves this exact intention in
      // the private outbox. A retry never prepares a second ciphertext.
      try {await this.resumeInner(prepared.operation,rpc,call);}
      catch(error) {
        if(!(error instanceof NativeError && (['network_error','network_or_protocol_error'].includes(error.code) || error.status>=500 || error.status===429)))throw error;
      }
      return prepared.operation;
    });
  }
  private async resumeInner(operation:string,rpc:(v:unknown)=>Promise<unknown>,call:<R>(fn:()=>Promise<R>,mutation?:boolean)=>Promise<R>):Promise<void> {
    if(!id(operation))integrity();const pending=object(await rpc({action:'pending',operation}));
    if(pending.operation!==operation || !['pending','accepted','cancelled','cancelling'].includes(String(pending.status)))integrity();
    if(pending.status==='accepted' || pending.status==='cancelled')return;
    if(pending.status==='cancelling'){await this.cancelInner(operation,rpc,call);return;}
    let receipt:ApplicationReceipt;
    try {receipt=decodeNative('ApplicationReceipt',await call(()=>this.remote.cryptoMessageOperation(this.room,operation)));}
    catch(error) {
      if(error instanceof NativeError && error.status===409 && error.code==='crypto_message_cancelled'){await this.cancelInner(operation,rpc,call);return;}
      if(!absent(error))throw error;
      const packet=decodeNative('ApplicationSubmission',await rpc({action:'retry',operation}));
      receipt=decodeNative('ApplicationReceipt',await call(()=>this.remote.submitCryptoMessage(this.room,packet),true));
    }
    await rpc({action:'acknowledge',receipt});
  }
  resume(operation:string):Promise<void> {return this.run(false,(rpc,_r,_p,_s,call)=>this.resumeInner(operation,rpc,call));}
  private async cancelInner(operation:string,rpc:(v:unknown)=>Promise<unknown>,call:<R>(fn:()=>Promise<R>)=>Promise<R>):Promise<void> {
    if(!id(operation))integrity();const original=await rpc({action:'cancel',operation});if(original===null)return;
    const packet=decodeNative('ApplicationSubmission',original);
    const settlement=decodeNative('ApplicationSettlement',await call(()=>this.remote.cancelCryptoMessage(this.room,packet)));
    await rpc({action:'settle',operation,settlement});
  }
  cancel(operation:string):Promise<void> {return this.run(false,(rpc,_r,_p,_s,call)=>this.cancelInner(operation,rpc,call));}
}
