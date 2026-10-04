import type {CryptoConversationBridge} from '../../modules/crypto-native/index.ts';
import {CryptoGroupAccess,type CryptoRoomAction} from './cryptoGroups.ts';
import type {ApplicationReceipt,ApplicationSettlement,ApplicationSubmission,DeliveryPage,GroupState,SendMessage} from './protocol.generated.ts';
import {NativeError} from './transport.ts';
import {decodeNative} from './validation.ts';

export type ConversationTransport={
  cryptoGroupState:(room:string)=>Promise<GroupState>;
  cryptoDelivery:(room:string,after:string,through?:string)=>Promise<DeliveryPage>;
  cryptoMessageOperation:(room:string,operation:string)=>Promise<ApplicationReceipt>;
  submitCryptoMessage:(room:string,input:ApplicationSubmission)=>Promise<ApplicationReceipt>;
  cancelCryptoMessage:(room:string,input:ApplicationSubmission)=>Promise<ApplicationSettlement>;
};
export type CryptoMessage={id:string;operation:string;author:string;document:SendMessage;position:string|null;
  observed_at:string;status:'journaled'|'pending'|'accepted'|'cancelling'|'cancelled'};
export type CryptoConversationView={admission:string;after:string;catching_up:boolean;has_older:boolean;can_send:boolean;draft:string;messages:CryptoMessage[]};
const id=(v:unknown):v is string=>typeof v==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
function integrity():never {throw new NativeError(0,'crypto_integrity_failed');}
function object(v:unknown):Record<string,unknown> {if(!v || typeof v!=='object' || Array.isArray(v))integrity();return v as Record<string,unknown>;}
function position(v:unknown,zero=true):v is string {
  return typeof v==='string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v)<=9223372036854775807n && (zero || v!=='0');
}
function projection(value:unknown,thread:string|null):CryptoConversationView {
  const v=object(value);
  if(typeof v.admission!=='string' || !/^[0-9a-f]{64}$/.test(v.admission) || !position(v.after)
    || typeof v.catching_up!=='boolean' || typeof v.has_older!=='boolean' || typeof v.can_send!=='boolean'
    || typeof v.draft!=='string' || v.draft.length>65536 || !Array.isArray(v.messages) || v.messages.length>264)integrity();
  const messages=v.messages.map(raw=>{
    const row=object(raw),document=decodeNative('SendMessage',row.document);
    if(!id(row.id) || !id(row.operation) || !id(row.author) || (row.position!==null && !position(row.position,false))
      || !position(row.observed_at) || BigInt(row.observed_at)>253402300799n
      || !['journaled','pending','accepted','cancelling','cancelled'].includes(String(row.status))
      || document.operation_id!==row.operation || (document.reply_to??null)!==thread)integrity();
    return {...row,document} as CryptoMessage;
  });
  if(new Set(messages.map(v=>v.operation)).size!==messages.length || new Set(messages.map(v=>v.id)).size!==messages.length)integrity();
  return {...v,messages} as CryptoConversationView;
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
  constructor(groups:CryptoGroupAccess,bridge:CryptoConversationBridge,remote:ConversationTransport,room:string,thread:string|null=null) {
    this.groups=groups;this.bridge=bridge;this.remote=remote;this.room=room;this.thread=thread;
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
    return this.run(false,async(rpc,_r,_p,_s,call)=>{
      if(before===null) {
        const cursor=object(await rpc({action:'journal_request'}));
        if(!position(cursor.after) || cursor.through!==null && !position(cursor.through))integrity();
        const page=decodeNative('DeliveryPage',await call(()=>this.remote.cryptoDelivery(this.room,cursor.after as string,cursor.through as string|null??undefined)));
        await rpc({action:'receive',page});
      }
      const view=projection(await rpc({action:'view',before,limit}),this.thread);
      if(this.admission && this.admission!==view.admission){await this.close();throw new NativeError(409,'crypto_scope_changed');}
      this.admission=view.admission;return view;
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
  async send(text:string):Promise<string> {
    return this.run(true,async(rpc,_r,_p,_s,call)=>{
      const prepared=object(await rpc({action:'prepare',text}));if(!id(prepared.operation))integrity();
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
