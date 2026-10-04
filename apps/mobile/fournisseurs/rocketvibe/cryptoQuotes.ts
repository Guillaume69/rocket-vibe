import type {CryptoMessage} from './cryptoConversations.ts';
import type {GroupRoster,GroupState,QuoteReference} from './protocol.generated.ts';
import type {NativeQuoteAttachment,NativeQuoteSelection} from './quotes.ts';
import type {PublicQuoteSources} from './quotes.ts';
import {nativeFileAttachments} from './fileDescriptors.ts';

export type PrivateQuoteSelection=NativeQuoteSelection & {crypto_admission:string};
export type PrivateQuotePreview={selection:PrivateQuoteSelection;author:string;text:string};
export type CryptoQuotePreview={selection:NativeQuoteSelection;author:string;text:string};
export type PrivateQuoteRoom={room:string;membership:string;admission:string|null;messages:CryptoMessage[];
  observation:{roster:GroupRoster;state:GroupState}|null};
export function ordinaryQuoteRoom(room:string,clear:PublicQuoteSources):PrivateQuoteRoom {
  return {room,membership:clear.membership,admission:null,observation:null,
    messages:clear.messages.map(({id,excerpt})=>({id,operation:id,author:excerpt.author.id,author_label:excerpt.author.username,
      document:{operation_id:id,text:excerpt.text,quotes:excerpt.references??[],reply_to:null,cards:[]},
      public_files:excerpt.files??[],position:excerpt.revision,observed_at:'0',status:'journaled'}))};
}
/** Existing cards, built only from reader-authorized private source documents. */
export function privateQuoteCards(refs:readonly QuoteReference[],sources:ReadonlyMap<string,PrivateQuoteRoom|null>,path:readonly string[]=[],depth=1):NativeQuoteAttachment[] {
  return refs.map(reference=>{
    const key=JSON.stringify([reference.room_id,reference.message_id]);
    const room=sources.get(reference.room_id);
    const source=path.includes(key)?undefined:room?.messages.find(m=>m.id===reference.message_id);
    const result:NativeQuoteAttachment={message_link:'',native_reference:reference,native_unavailable:!source,text:''};
    if(source) {
      result.text=Array.from(source.document.text).slice(0,1024).join('');result.author_name=source.author_label??source.author;
      const files=room?.admission===null?nativeFileAttachments(source.public_files??[],reference.room_id):[];
      if(files.length)result.attachments=files;
      if(depth<2 && source.document.quotes?.length)result.attachments=[...files,...privateQuoteCards(source.document.quotes,sources,[...path,key],depth+1)];
    }
    return result;
  });
}
