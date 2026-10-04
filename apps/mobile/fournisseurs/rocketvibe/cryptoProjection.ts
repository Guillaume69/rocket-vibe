import type {CryptoConversationView} from './cryptoConversations.ts';
import type {LigneDeMessage} from '../../ui/ligneMessage.tsx';
/** Render-only rows, ordered by exact private journal positions. */
export function lignesPrivees(view:CryptoConversationView|null,room:string):LigneDeMessage[] {
  const rows=[...(view?.messages??[])].sort((a,b)=>{
    if(a.position!==null && b.position!==null)return BigInt(a.position)>BigInt(b.position)?-1:BigInt(a.position)<BigInt(b.position)?1:0;
    if(a.position===null && b.position!==null)return -1;if(a.position!==null && b.position===null)return 1;
    return Number(b.observed_at)-Number(a.observed_at) || b.id.localeCompare(a.id);
  });
  return rows.map(v=>({id:v.id,rid:room,texte:v.document.text,horodatage:Number(v.observed_at)*1000,
    auteurId:v.author,auteurNom:v.author,typeSysteme:null,filId:v.document.reply_to??null,filReponses:0,filDernier:null,
    filAffiche:false,modifieLe:null,md:null,piecesJointes:null,reactions:null,urls:null,appelId:null,chiffreBrut:null,
    epingle:false,etoiles:null,misAJourLe:0}));
}
