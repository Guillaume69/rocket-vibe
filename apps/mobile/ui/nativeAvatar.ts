import {useCallback,useEffect,useSyncExternalStore} from 'react';
import {subscribeNativeAvatar,loadNativeAvatar,nativeAvatarPhoto} from '../lib/nativeAvatars.ts';

/** The image component sees local pixels; the provider owns bearer and redirects. */
export function useNativeAvatar(uri:string|null|undefined):string|null|undefined {
  const native=uri?.startsWith('rv-avatar:')||uri?.startsWith('rv-emoji:')||false;
  const subscribe=useCallback((fn:()=>void)=>subscribeNativeAvatar(native?uri:null,fn),[native,uri]);
  const snapshot=useCallback(()=>nativeAvatarPhoto(native?uri:null),[native,uri]);
  const photo=useSyncExternalStore(subscribe,snapshot,snapshot);
  useEffect(()=>{if(native&&!photo.failed&&!photo.uri)void loadNativeAvatar(uri);},[native,uri,photo]);
  return native?photo.uri:uri;
}
