import type {CryptoConversationView} from './cryptoConversations.ts';
import type {MessageRowData} from '../../ui/messageRow.tsx';
/** Render-only rows, ordered by exact private journal positions. */
export function privateRows(view:CryptoConversationView|null,room:string,thread=false):MessageRowData[] {
  const rows=[...(view?.messages??[])].sort((a,b)=>{
    if(a.position!==null && b.position!==null)return BigInt(a.position)>BigInt(b.position)?-1:BigInt(a.position)<BigInt(b.position)?1:0;
    if(a.position===null && b.position!==null)return -1;if(a.position!==null && b.position===null)return 1;
    return Number(b.observed_at)-Number(a.observed_at) || b.id.localeCompare(a.id);
  });
  if(thread){rows.reverse();if(view?.root)rows.unshift(view.root);}
  return rows.map(v=>({id:v.id,rid:room,text:v.document.text,ts:Number(v.observed_at)*1000,
    authorId:v.author,authorName:v.author,systemType:null,threadId:v.document.reply_to??null,threadCount:view?.retained_replies[v.id]??0,threadLast:null,
    threadShown:false,editedAt:null,md:null,attachments:view?.quote_cards?.[v.id]?.length?JSON.stringify(view.quote_cards[v.id]):null,reactions:null,urls:null,callId:null,encryptedRaw:null,
    pinned:false,starred:null,updatedAt:0}));
}
