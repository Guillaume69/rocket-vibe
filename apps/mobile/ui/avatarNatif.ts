import {useCallback,useEffect,useSyncExternalStore} from 'react';
import {abonnerAvatarNatif,chargerAvatarNatif,photoAvatarNatif} from '../lib/avatarsNatifs.ts';

/** The image component sees local pixels; the provider owns bearer and redirects. */
export function useAvatarNatif(uri:string|null|undefined):string|null|undefined {
  const native=uri?.startsWith('rv-avatar:')??false;
  const subscribe=useCallback((fn:()=>void)=>abonnerAvatarNatif(native?uri:null,fn),[native,uri]);
  const snapshot=useCallback(()=>photoAvatarNatif(native?uri:null),[native,uri]);
  const photo=useSyncExternalStore(subscribe,snapshot,snapshot);
  useEffect(()=>{if(native&&!photo.failed&&!photo.uri)void chargerAvatarNatif(uri);},[native,uri,photo]);
  return native?photo.uri:uri;
}
