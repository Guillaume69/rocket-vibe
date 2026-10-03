import type {ClientRest} from './rest.ts';
import type {Fournisseur} from './fournisseur.ts';
import {definirEmojisCustom,viderEmojisCustom} from './emojisCustom.ts';
import {definirEmojisNatifs,uriEmojiNatif,revaliderEmojisNatifs} from './avatarsNatifs.ts';

export function monterEmojisFournisseur(client:ClientRest,fournisseur:Fournisseur):()=>void {
  const chat=fournisseur.native?.chat;if(!chat)return()=>{};
  let active=true,version='',catalog=chat.customEmojis,readable=false;
  const unimages=definirEmojisNatifs(client,id=>chat.customEmojiImage(id));
  const refresh=()=>{
    const nextReadable=chat.status.online&&chat.capabilities?.custom_emojis===true;
    if(!active||version===chat.emojiVersion&&catalog===chat.customEmojis&&readable===nextReadable)return;
    version=chat.emojiVersion;catalog=chat.customEmojis;readable=nextReadable;
    revaliderEmojisNatifs(client,new Set(catalog.items.map(e=>e.file_id)),readable);
    definirEmojisCustom(client.baseUrl,catalog.items.map(e=>({nom:e.name,extension:e.media_type==='image/gif'?'gif':'png',aliases:e.aliases,uri:uriEmojiNatif(client,e.file_id)!})));
  };
  const unlisten=chat.subscribe(refresh);refresh();void chat.restoreEmojis().catch(()=>{});
  return()=>{active=false;unlisten();unimages();viderEmojisCustom();};
}
