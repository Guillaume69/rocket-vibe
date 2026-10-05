import {useCallback,useEffect,useSyncExternalStore} from 'react';
import {subscribeNativePreview,nativePreviewPhoto,loadNativePreview} from '../lib/nativePreviews.ts';
export function useNativePreview(uri:string|null|undefined):string|null|undefined {
  const native=uri?.startsWith('rv-preview:')??false;
  const subscribe=useCallback((fn:()=>void)=>subscribeNativePreview(native?uri:null,fn),[native,uri]);
  const snapshot=useCallback(()=>nativePreviewPhoto(native?uri:null),[native,uri]);
  const photo=useSyncExternalStore(subscribe,snapshot,snapshot);
  useEffect(()=>{if(native&&!photo.uri&&!photo.failed)void loadNativePreview(uri);},[native,uri,photo]);
  return native?photo.uri:uri;
}
