import type {CryptoMessage} from './cryptoConversations.ts';
import type {GroupRoster,GroupState,QuoteReference} from './protocol.generated.ts';
import type {NativeQuoteAttachment,NativeQuoteSelection} from './quotes.ts';

export type PrivateQuoteSelection=NativeQuoteSelection & {crypto_admission:string};
export type PrivateQuotePreview={selection:PrivateQuoteSelection;author:string;text:string};
export type PrivateQuoteRoom={room:string;membership:string;admission:string|null;messages:CryptoMessage[];
  observation:{roster:GroupRoster;state:GroupState}|null};
/** Existing cards, built only from reader-authorized private source documents. */
export function privateQuoteCards(refs:readonly QuoteReference[],sources:ReadonlyMap<string,PrivateQuoteRoom|null>,path:readonly string[]=[],depth=1):NativeQuoteAttachment[] {
  return refs.map(reference=>{
    const key=JSON.stringify([reference.room_id,reference.message_id]);
    const source=path.includes(key)?undefined:sources.get(reference.room_id)?.messages.find(m=>m.id===reference.message_id);
    const result:NativeQuoteAttachment={message_link:'',native_reference:reference,native_unavailable:!source,text:''};
    if(source) {
      result.text=Array.from(source.document.text).slice(0,1024).join('');result.author_name=source.author_label??source.author;
      if(depth<2 && source.document.quotes?.length)result.attachments=privateQuoteCards(source.document.quotes,sources,[...path,key],depth+1);
    }
    return result;
  });
}
