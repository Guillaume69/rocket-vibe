import type {QuoteReference} from './protocol.generated.ts';
import type {NativeQuoteAttachment} from './quotes.ts';
import {privateQuoteCards,type PrivateQuoteRoom} from './cryptoQuotes.ts';
import {decodeNative} from './validation.ts';
import {NativeError} from './transport.ts';

export type QuoteRow={id:string;references:readonly QuoteReference[]};
/** Every source callback belongs to the same account, destination membership
 * and active view. Returned excerpts are never handed to a store writer. */
export class CryptoQuoteReader {
  private closed=false;
  private readonly destination:string;
  private readonly guard:()=>Promise<void>;
  private readonly source:(room:string,ids:readonly string[],synchronize:boolean)=>Promise<PrivateQuoteRoom|null>;
  private readonly dispose:()=>Promise<void>;
  private readonly identity:{instance_id:string;data_epoch:string}|null;
  constructor(destination:string,guard:()=>Promise<void>,
    source:(room:string,ids:readonly string[],synchronize:boolean)=>Promise<PrivateQuoteRoom|null>,
    dispose:()=>Promise<void>,identity:{instance_id:string;data_epoch:string}|null=null) {
    this.destination=destination;this.guard=guard;this.source=source;this.dispose=dispose;this.identity=identity;
  }
  get isClosed():boolean{return this.closed;}
  async close():Promise<void>{if(this.closed)return;this.closed=true;await this.dispose();}
  private async check():Promise<void>{if(this.closed)throw new NativeError(0,'session_closed');await this.guard();if(this.closed)throw new NativeError(0,'session_closed');}
  async previewQuote(selection:import('./quotes.ts').NativeQuoteSelection):Promise<import('./cryptoQuotes.ts').CryptoQuotePreview|null> {
    await this.check();const reference=decodeNative('QuoteReference',selection.reference);
    if(!this.identity || selection.instance_id!==this.identity.instance_id || selection.data_epoch!==this.identity.data_epoch)return null;
    const room=await this.source(reference.room_id,[reference.message_id],true);await this.check();
    if(!room || room.room!==reference.room_id || room.membership!==selection.membership_version || room.admission!==(selection.crypto_admission??null))return null;
    const fresh=await this.source(reference.room_id,[reference.message_id],false);await this.check();
    if(!fresh || fresh.room!==room.room || fresh.membership!==room.membership || fresh.admission!==room.admission)return null;
    const message=fresh.messages.find(m=>m.id===reference.message_id && m.position===reference.revision);
    return message?{selection,author:message.author_label??message.author,text:Array.from(message.document.text).slice(0,1024).join('')}:null;
  }
  async project(rows:readonly QuoteRow[]):Promise<Record<string,NativeQuoteAttachment[]>> {
    await this.check();
    const sources=new Map<string,PrivateQuoteRoom|null>(),requested=new Map<string,Set<string>>();
    let refs=rows.flatMap(row=>{
      if(row.references.length>8)throw new NativeError(0,'crypto_integrity_failed');
      return row.references.map(r=>decodeNative('QuoteReference',r));
    });
    for(let depth=0;depth<2;depth++) {
      const changed=new Set<string>();
      for(const r of refs) {
        if(!requested.has(r.room_id))requested.set(r.room_id,new Set());
        const ids=requested.get(r.room_id)!;
        if(!ids.has(r.message_id)){ids.add(r.message_id);changed.add(r.room_id);}
      }
      for(const room of changed) {
        const first=!sources.has(room);
        const value=await this.source(room,[...requested.get(room)!],first);
        if(value && value.room!==room)throw new NativeError(0,'crypto_scope_changed');
        await this.check();sources.set(room,value);
      }
      if(depth===0)refs=refs.flatMap(r=>sources.get(r.room_id)?.messages.find(m=>m.id===r.message_id)?.document.quotes??[]);
    }
    // Different source calls may straddle a withdrawal or renewed admission.
    // Re-read before publishing and remove the whole inaccessible subtree.
    for(const [room,old] of sources)if(old) {
      const fresh=await this.source(room,[...requested.get(room)!],false);await this.check();
      if(fresh && fresh.room!==room)throw new NativeError(0,'crypto_scope_changed');
      sources.set(room,fresh?.membership===old.membership && fresh.admission===old.admission?fresh:null);
    }
    const result:Record<string,NativeQuoteAttachment[]>={};
    for(const row of rows)result[row.id]=privateQuoteCards(row.references,sources,[JSON.stringify([this.destination,row.id])]);
    await this.check();return result;
  }
}

export function quoteRows(rows:readonly {id:string;attachments:string|null}[]):QuoteRow[] {
  return rows.flatMap(row=>{
    const attachments:unknown=JSON.parse(row.attachments??'[]');if(!Array.isArray(attachments))throw Error('Invalid quote cards');
    const references=attachments.flatMap(p=>p && typeof p==='object' && 'native_reference' in p?[decodeNative('QuoteReference',p.native_reference)]:[]);
    return references.length?[{id:row.id,references}]:[];
  });
}
/** Apply after ordinary list smoothing; clearing this map immediately removes
 * all private words, without waiting for the ordinary SQLite list to change. */
export function overlayQuoteRows<T extends {id:string;attachments:string|null}>(rows:readonly T[],cards:Record<string,NativeQuoteAttachment[]>):T[] {
  return rows.map(row=>{
    if(!cards[row.id])return row;
    const attachments:unknown[]=JSON.parse(row.attachments??'[]');
    const retained=attachments.filter(p=>!p || typeof p!=='object' || !('native_reference' in p));
    return {...row,attachments:JSON.stringify([...retained,...cards[row.id]])};
  });
}
