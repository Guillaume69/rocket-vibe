import type {ClientRest} from './rest.ts';
import type {Fournisseur} from './fournisseur.ts';
import {definirLecteurProfil} from './profilPreload.ts';
import {definirAvatarsNatifs,retirerAvatarNatif,reprendreAvatarsNatifs,revaliderAvatarNatif} from './avatarsNatifs.ts';

/** Same provider lifetime in the app and in the HTTP/SQLite integration bench. */
export function monterProfilsFournisseur(client:ClientRest,fournisseur:Fournisseur):()=>void {
  const unprofile=definirLecteurProfil(client,cible=>fournisseur.lireProfil!(cible));
  const chat=fournisseur.native?.chat;
  if(!chat)return unprofile;
  const unavatars=definirAvatarsNatifs(client,id=>chat.profileAvatar(id));
  let avatars=new Map<string,string|null>(),online=chat.status.online;
  const unlive=chat.live.subscribe(()=>{
    const state=chat.live.state;
    if(!state)return;
    const next=new Map((state.profiles??[]).map(p=>[p.user.id,p.avatar_file_id??null]));
    for(const [uid,old] of avatars)if(old){
      if(!next.has(uid))revaliderAvatarNatif(client,old);
      else if(next.get(uid)!==old)retirerAvatarNatif(client,old);
    }
    avatars=next;
  });
  const unlisten=chat.subscribe(()=>{
    if(chat.status.online&&!online)reprendreAvatarsNatifs(client);
    online=chat.status.online;
  });
  return()=>{unlisten();unlive();unavatars();unprofile();};
}
