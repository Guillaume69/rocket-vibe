import type {CryptoConversationView,CryptoMessage} from './cryptoConversations.ts';
import type {MessageRowData} from '../../ui/messageRow.tsx';
/** The account whose user id shows under its username, so its reactions are marked. */
export type PrivateSelf={id:string;username:string};
/** Reactions keyed like the ordinary rows: `{":name:": {usernames: [...]}}`. */
function reactions(row:CryptoMessage,self?:PrivateSelf):string|null {
  if(!row.reactions?.length)return null;
  return JSON.stringify(Object.fromEntries(row.reactions.map(r=>[`:${r.emoji}:`,
    {usernames:r.users.map(u=>self && u===self.id?self.username:u)}])));
}
/** One render-only row. */
export function privateRow(v:CryptoMessage,room:string,threadCount=0,cards:string|null=null,self?:PrivateSelf):MessageRowData {
  return {id:v.id,rid:room,text:v.document.text,ts:Number(v.observed_at)*1000,
    authorId:v.author,authorName:v.author,systemType:null,threadId:v.document.reply_to??null,threadCount,threadLast:null,
    threadShown:false,editedAt:v.edited?Number(v.observed_at)*1000:null,md:null,attachments:cards,reactions:reactions(v,self),urls:null,callId:null,encryptedRaw:null,
    pinned:false,starred:null,updatedAt:0};
}
/** Render-only rows, ordered by exact private journal positions. */
export function privateRows(view:CryptoConversationView|null,room:string,thread=false,self?:PrivateSelf):MessageRowData[] {
  const rows=[...(view?.messages??[])].sort((a,b)=>{
    if(a.position!==null && b.position!==null)return BigInt(a.position)>BigInt(b.position)?-1:BigInt(a.position)<BigInt(b.position)?1:0;
    if(a.position===null && b.position!==null)return -1;if(a.position!==null && b.position===null)return 1;
    return Number(b.observed_at)-Number(a.observed_at) || b.id.localeCompare(a.id);
  });
  if(thread){rows.reverse();if(view?.root)rows.unshift(view.root);}
  return rows.map(v=>privateRow(v,room,view?.retained_replies[v.id]??0,
    view?.quote_cards?.[v.id]?.length?JSON.stringify(view.quote_cards[v.id]):null,self));
}
