import type {RestClient} from './rest.ts';
import type {Provider} from './provider.ts';
import {setProfileReader} from './profilePreload.ts';
import {setNativeAvatars,removeNativeAvatar,resumeNativeAvatars,revalidateNativeAvatar} from './nativeAvatars.ts';

/** Same provider lifetime in the app and in the HTTP/SQLite integration bench. */
export function mountProviderProfiles(client:RestClient,provider:Provider):()=>void {
  const unprofile=setProfileReader(client,target=>provider.readProfile!(target));
  const chat=provider.native?.chat;
  if(!chat)return unprofile;
  const unavatars=setNativeAvatars(client,id=>chat.profileAvatar(id));
  let avatars=new Map<string,string|null>(),online=chat.status.online;
  const unlive=chat.live.subscribe(()=>{
    const state=chat.live.state;
    if(!state)return;
    const next=new Map((state.profiles??[]).map(p=>[p.user.id,p.avatar_file_id??null]));
    for(const [uid,old] of avatars)if(old){
      if(!next.has(uid))revalidateNativeAvatar(client,old);
      else if(next.get(uid)!==old)removeNativeAvatar(client,old);
    }
    avatars=next;
  });
  const unlisten=chat.subscribe(()=>{
    if(chat.status.online&&!online)resumeNativeAvatars(client);
    online=chat.status.online;
  });
  return()=>{unlisten();unlive();unavatars();unprofile();};
}
