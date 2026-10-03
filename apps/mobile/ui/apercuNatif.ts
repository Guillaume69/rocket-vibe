import {useCallback,useEffect,useSyncExternalStore} from 'react';
import {abonnerApercuNatif,photoApercuNatif,chargerApercuNatif} from '../lib/apercusNatifs.ts';
export function useApercuNatif(uri:string|null|undefined):string|null|undefined {
  const native=uri?.startsWith('rv-preview:')??false;
  const subscribe=useCallback((fn:()=>void)=>abonnerApercuNatif(native?uri:null,fn),[native,uri]);
  const snapshot=useCallback(()=>photoApercuNatif(native?uri:null),[native,uri]);
  const photo=useSyncExternalStore(subscribe,snapshot,snapshot);
  useEffect(()=>{if(native&&!photo.uri&&!photo.failed)void chargerApercuNatif(uri);},[native,uri,photo]);
  return native?photo.uri:uri;
}
