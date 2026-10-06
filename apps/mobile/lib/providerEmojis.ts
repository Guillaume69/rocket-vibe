import type {RestClient} from './rest.ts';
import type {Provider} from './provider.ts';
import {setCustomEmojis,clearCustomEmojis} from './customEmojis.ts';
import {setNativeEmojis,nativeEmojiUri,revalidateNativeEmojis} from './nativeAvatars.ts';

export function mountProviderEmojis(client:RestClient,provider:Provider):()=>void {
  const chat=provider.native?.chat;if(!chat)return()=>{};
  let active=true,version='',catalog=chat.customEmojis,readable=false;
  const unimages=setNativeEmojis(client,id=>chat.customEmojiImage(id));
  const refresh=()=>{
    const nextReadable=chat.status.online&&chat.capabilities?.custom_emojis===true;
    if(!active||version===chat.emojiVersion&&catalog===chat.customEmojis&&readable===nextReadable)return;
    version=chat.emojiVersion;catalog=chat.customEmojis;readable=nextReadable;
    revalidateNativeEmojis(client,new Set(catalog.items.map(e=>e.file_id)),readable);
    setCustomEmojis(client.baseUrl,catalog.items.map(e=>({name:e.name,extension:e.media_type==='image/gif'?'gif':'png',aliases:e.aliases,uri:nativeEmojiUri(client,e.file_id)!})));
  };
  const unlisten=chat.subscribe(refresh);refresh();void chat.restoreEmojis().catch(()=>{});
  return()=>{active=false;unlisten();unimages();clearCustomEmojis();};
}
